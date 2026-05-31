/**
 * Dispatch ops (#144 phase 3) — the bodies behind the dispatch handler's
 * {@link ./dispatch.ts} injected seams. Two operations, both small:
 *
 *   - launchDispatch                    → ask Hatchery to spawn a codex worker for
 *     a ready item, and record `slice.dispatched`.
 *   - completePendingHatcheryDispatches → poll in-flight Hatchery jobs and either
 *     promote the slice to `implementing` (success) or escalate it for judgement
 *     (failure). No retries, no ghost-session reclamation, no direct-steward
 *     fallback — the legate asks services to act and records the outcome; it does
 *     not perform recovery surgery (that machinery, lifted verbatim from the old
 *     generated .mjs, was deleted in #144: its in-memory state — job ids aside —
 *     was never durable across a restart, so it could not be relied on anyway).
 *
 * The poll is a known interim: completion should ultimately be a Herald
 * observation event the legate folds, not a direct Hatchery poll (see the
 * follow-up issue). Persisting the job id in the fold (`slice.dispatched.jobId`)
 * keeps the poll correct across restarts until then.
 *
 * All effects route through {@link DispatchIoDeps}; the pure id/prompt helpers are
 * imported directly. Each op unit-tests against fakes.
 */
import type { DispatchIoDeps } from "./dispatch-io.js";
import { createSenseIo } from "../../../observe/sense-io.js";
import {
  actionArguments,
  actionCommandLine,
  dispatchBranch,
  dispatchIdentity,
  dispatchTitle,
} from "../pure/dispatch-id.js";
import { buildSmithySpawnPrompt } from "../pure/messages.js";
import { hashText } from "../pure/hash.js";
import { DISPATCH_RECOVERY_LIMIT, recoveryAttemptKey, recoveryBudgetExhausted } from "../pure/slice.js";

/** A judgement-request notification (the dispatch handler fires these). */
export interface DispatchNotification {
  slice: any;
  sliceId: string;
  requestKey: string;
  reason: string;
  detail: string;
}

/** Shape returned to the dispatch handler's apply() (CompletionResult/LaunchResult). */
export interface DispatchOutcome {
  actions: any[];
  failures: any[];
  mutated: boolean;
  notifications: DispatchNotification[];
}

// #173: adopt the slice's own open PR on a branch-collision instead of escalating.
//
// When the loop re-dispatches a slice whose branch is already alive with an open
// PR, the spawn fails with "branch '<name>' already exists". Hatchery's #245
// self-heal correctly REFUSES to delete that branch when it is unsafe (open-pr /
// diverged) — protecting real work — and surfaces the collision rather than
// reconciling it: the forge-truth decision (an open PR must not be deleted) is the
// legate's to make, not hatchery's (orphan-branch.ts:140-143; ownership moves to
// the Statio extraction / legate side per #250). So here, on ANY branch-collision,
// we ask the shared sense I/O whether a matching open PR exists for this slice's
// expected branches (branch-variant matched, identical to Herald/babysit — no
// duplicated gh logic). If it does, the colliding branch HAS our PR: adopt it
// (stage → "pr-open", slice.pr ← snapshot) and emit the matching fold transitions
// so the existing babysit pipeline drives it to merge with no fresh dispatch and no
// destructive cleanup. The caller falls through to its normal escalate path when
// this returns null (not a collision, or a genuine orphan branch with no open PR).
//
// Returns the adopt action to record, or null when nothing was adopted.
async function adoptOpenPrOnCollision(
  state: any,
  ts: string,
  sliceId: string,
  errorText: string,
  deps: DispatchIoDeps,
): Promise<any | null> {
  // Lookup-based detection (cleaner + self-correcting than string-matching the
  // unsafe-to-remove verdict): only a "branch already exists" collision can be an
  // adopt candidate; everything else escalates as before.
  if (!/already exists/i.test(errorText)) return null;
  const slice = state.slices?.[sliceId];
  if (!slice || typeof slice !== "object") return null;
  let pr: any;
  try {
    // Discovery routes through the shared sense I/O (branch-variant matched,
    // identical to Herald/babysit). It is injectable via deps.discoverPr (tests
    // stub it); in production deps doesn't carry it, so fall back to building the
    // sense I/O from meta here. Pass the steward sessionId when the fold already
    // knows it (#210); discovery falls back to branch-variant `gh pr list`
    // matching when it is absent, the common collision case (re-dispatch cleared it).
    const discover =
      deps.discoverPr ??
      ((s: any, st: any, sid?: string) =>
        createSenseIo({ meta: deps.meta, env: process.env }).discoverPrForSlice(s, st, sid ?? ""));
    pr = await discover(slice, state, slice.worker_session_id || "");
  } catch {
    return null;
  }
  const number = pr?.number;
  // A genuine orphan branch (no matching open PR) → no adoption; let the caller
  // escalate exactly as it does today. Guard state too: discovery's session-output
  // path can surface a non-open PR.
  if (!pr || pr.skipped || typeof number !== "number" || !(number > 0)) return null;
  if (pr.state && String(pr.state).toUpperCase() !== "OPEN") return null;

  // Adopt: hand the slice to babysit's pr-open → fix → merge pipeline.
  slice.stage = "pr-open";
  slice.pr = pr;
  // Clear any escalation residue from a prior incarnation — adoption resolves the
  // situation cleanly, so the slice must not read as operator-only.
  slice.escalated_reason = undefined;
  slice.last_action = ts;
  slice.last_action_note = "Adopted existing open PR #" + number + " on branch-collision (#173)";
  // The fold is authoritative: record stage + PR as transitions, never in-memory
  // only (#255). Carry the steward sessionId when known so the durable slice→
  // session link (#210/#218) keeps holding; omit it otherwise (babysit + PR
  // discovery do not require it for an open PR).
  const sessionId = slice.worker_session_id || undefined;
  deps.emitTransition({
    type: "slice.stage.changed",
    sliceId,
    stage: "pr-open",
    ...(sessionId ? { sessionId } : {}),
  });
  deps.emitTransition({ type: "slice.pr.changed", sliceId, pr });
  deps.log("[" + ts + "] dispatch " + sliceId + ": adopted existing open PR #" + number + " from branch-collision");
  return {
    action: "adopt-pr",
    sliceId,
    sessionId: slice.worker_session_id || null,
    detail: "adopted existing open PR #" + number + " from branch-collision",
  };
}

// Launch a codex spawn through the Hatchery SERVICE. POSTs the spawn request via
// the async Hatchery client and returns the server job id;
// completePendingHatcheryDispatches polls that id with getJob() across ticks
// until the job reaches a terminal state. POST /spawns returns 202 immediately
// (the server runs the spawn in the background), so this stays non-blocking for
// the tick. repoPath must be valid INSIDE the hatchery container — it bind-mounts
// the repo + worktree-parent at the identical absolute path. Telemetry is owned
// by the service; the dispatch trace is correlated server-side via sliceId.
export async function launchHatcheryDispatch(item: any, sliceId: string, deps: DispatchIoDeps): Promise<{ jobId: string }> {
  const repoPath = deps.meta.repo?.path;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("repo path is missing");
  }
  const dispatchIdent = dispatchIdentity(item);
  const spawnRequest = {
    prompt: buildSmithySpawnPrompt(item),
    backend: "codex",
    repoPath,
    agentDeckProfile: deps.meta.profile,
    managerGroup: deps.meta.worker_group,
    title: dispatchTitle(item),
    branch: dispatchBranch(item),
    profile: deps.meta.profile,
    taskType: dispatchIdent.verb,
    taskName: dispatchIdent.stem,
    // Use the caller's slice id so the spawn, the in-memory slice, and the emitted
    // transitions all correlate under one id (single source of truth).
    sliceId,
  };
  const created = await deps.postSpawn(spawnRequest);
  // postSpawn's parseJsonBody yields {} on an empty/invalid 202 body, so the id
  // can be missing. Guard it: a slice recorded with no usable job_id is skipped
  // forever by completePendingHatcheryDispatches. Throw so the caller's
  // try/catch escalates the slice instead.
  if (typeof created.id !== "string" || created.id.length === 0) {
    throw new Error("hatchery POST /spawns returned no job id");
  }
  return { jobId: created.id };
}

// Fresh-dispatch launch for one ready item: create the hatchery-pending slice,
// fire the codex spawn, and return the action (or escalate + a notification on a
// launch throw). The dispatch handler's apply() calls this via DispatchDeps.
export async function launchDispatch(state: any, ts: string, item: any, sliceId: string, deps: DispatchIoDeps): Promise<DispatchOutcome> {
  const actions: any[] = [];
  const failures: any[] = [];
  const notifications: DispatchNotification[] = [];
  const action = item.next_action || {};
  try {
    state.slices[sliceId] = {
      kind: "smithy",
      worker_session_id: null,
      worker_title: dispatchTitle(item),
      branch: dispatchBranch(item),
      actual_branch: null,
      worktree_path: null,
      stage: "hatchery-pending",
      pr: null,
      command: action.command,
      arguments: actionArguments(action),
      artifact_path: item.path || null,
      hatchery: { backend: "codex" },
      last_action: ts,
      last_action_note: "Queued Hatchery codex spawn for " + actionCommandLine(action),
    };
    const launched = await launchHatcheryDispatch(item, sliceId, deps);
    state.slices[sliceId].hatchery.job_id = launched.jobId;
    actions.push({
      action: "dispatch",
      sliceId,
      sessionId: null,
      detail: "queued Hatchery codex spawn job " + launched.jobId + " for " + actionCommandLine(action),
    });
    // Persist the job id in the fold so the completion poll survives a restart
    // (rebuildWorkingState restores slice.hatchery.job_id from slice.dispatched).
    deps.emitTransition({ type: "slice.dispatched", sliceId, branch: dispatchBranch(item), jobId: launched.jobId });
  } catch (err: any) {
    const error = err?.message || String(err);
    // #173: if the launch collided with a branch that already has this slice's
    // open PR, adopt the PR and let babysit drive it — no escalate, no cleanup.
    const adopted = await adoptOpenPrOnCollision(state, ts, sliceId, error, deps);
    if (adopted) {
      actions.push(adopted);
      return { actions, failures, mutated: true, notifications };
    }
    const existing = state.slices?.[sliceId];
    if (existing && existing.stage === "hatchery-pending") {
      existing.stage = "escalated";
      // Tag the recoverable class so the loop's bounded auto-recovery (#211) can
      // re-dispatch this slice; survives a restart via rebuildWorkingState.
      existing.escalated_reason = "hatchery_dispatch_failed";
      existing.last_action = ts;
      existing.last_action_note = "NEED: Hatchery dispatch launch failed: " + error;
      deps.emitTransition({ type: "slice.escalated", sliceId, reason: "hatchery_dispatch_failed" });
      // Only bother the operator once auto-recovery is out of budget — within
      // budget the loop re-dispatches this slice itself (#211), so a judgement
      // request here would escalate prematurely and defeat bounded recovery. The
      // failure is still logged + counted below regardless.
      if (recoveryBudgetExhausted(state, sliceId)) {
        notifications.push({
          slice: existing, sliceId,
          requestKey: "hatchery-failure:" + sliceId + ":launch-throw:" + hashText(error).slice(0, 12),
          reason: "hatchery_dispatch_failed",
          detail: "Hatchery dispatch launch threw for " + actionCommandLine(action) + ".\n\nError:\n" + error
            + "\n\nThe loop auto-recovered this class " + DISPATCH_RECOVERY_LIMIT + " times and it still failed, so the"
            + " slice is now operator-only. For 'branch already exists' surface this via legate.unwedge; otherwise legate.error.",
        });
      }
    }
    failures.push({ slice_id: sliceId, command: actionCommandLine(action), error });
    deps.emit({
      schema_version: 1,
      ts,
      processor: deps.meta.processor_name,
      paired_legate: deps.meta.paired_legate,
      kind: "dispatch_failure",
      slice_id: sliceId,
      command: actionCommandLine(action),
      error,
    });
    deps.log("[" + ts + "] dispatch failed " + sliceId + ": " + error);
  }
  return { actions, failures, mutated: true, notifications };
}

// Bounded auto-recovery (#211): re-dispatch a slice that escalated for a
// recoverable class (`hatchery_dispatch_failed`) by reusing the EXACT fresh-launch
// path. launchDispatch overwrites the escalated slice with a clean hatchery-pending
// slice and fires a new codex spawn, so the recovered slice flows back through the
// normal completion poll. #216 already removed any orphan branch/worktree on the
// failed-spawn rollback, so the re-dispatch is collision-free; teardown stays
// Brood's exact-path job (#155), never a worktree prune here. The retry counter is
// persisted (and folded via retry.counted) BEFORE re-launching so a crash
// mid-recovery can't reset the budget and loop forever; the budget itself is
// enforced upstream by recoverableEscalations (pure/slice.ts).
export async function recoverDispatch(
  state: any,
  ts: string,
  item: any,
  sliceId: string,
  attempt: number,
  deps: DispatchIoDeps,
): Promise<DispatchOutcome> {
  if (!state.transient_retry_counts || typeof state.transient_retry_counts !== "object") {
    state.transient_retry_counts = {};
  }
  const key = recoveryAttemptKey(sliceId);
  state.transient_retry_counts[key] = attempt;
  deps.emitTransition({ type: "retry.counted", key, count: attempt });
  deps.emitTransition({ type: "slice.recovery.dispatched", sliceId, branch: dispatchBranch(item) });
  deps.log("[" + ts + "] auto-recovery re-dispatch " + sliceId + " (attempt " + attempt + "/" + DISPATCH_RECOVERY_LIMIT + ")");

  const out = await launchDispatch(state, ts, item, sliceId, deps);

  // launchDispatch records a "dispatch" action + a generic note; re-tag it so the
  // operator/telemetry see this was an auto-recovery, and surface it on the
  // (currently replay-only) recovery_dispatch action-log path → recovery span.
  for (const a of out.actions) {
    if (a.action === "dispatch") {
      a.action = "dispatch-recovery";
      a.detail = "auto-recovery attempt " + attempt + "/" + DISPATCH_RECOVERY_LIMIT + ": " + a.detail;
      deps.emit({
        schema_version: 1,
        ts,
        processor: deps.meta.processor_name,
        paired_legate: deps.meta.paired_legate,
        kind: "recovery_dispatch",
        action: "recovery_dispatch",
        slice_id: sliceId,
        detail: a.detail,
      });
    }
  }

  // The slice.recovery.dispatched event above already moved the fold to
  // hatchery-pending (its reducer sets stage), so no compensating
  // slice.stage.changed is needed — a restart mid-recovery rebuilds straight
  // into the completion poll (#255). If launchDispatch's own catch re-escalated
  // (the POST threw), the slice.escalated event left it escalated — correct.
  return out;
}

// Drain in-flight Hatchery dispatches: poll each hatchery-pending slice's job and
// either promote it to `implementing` (success) or escalate it for judgement
// (failure). Non-terminal jobs and transient lookup failures just wait for the
// next tick. A failed spawn — for ANY reason (patch error, session collision,
// branch collision, …) — escalates: the legate no longer auto-recovers.
export async function completePendingHatcheryDispatches(state: any, ts: string, deps: DispatchIoDeps): Promise<DispatchOutcome> {
  const actions: any[] = [];
  const failures: any[] = [];
  const notifications: DispatchNotification[] = [];
  let mutated = false;
  const slices: Record<string, any> = state?.slices && typeof state.slices === "object" ? state.slices : {};

  const escalate = (slice: any, sliceId: string, errorText: string) => {
    slice.stage = "escalated";
    // Tag the recoverable class so the loop's bounded auto-recovery (#211) can
    // re-dispatch this slice; survives a restart via rebuildWorkingState.
    slice.escalated_reason = "hatchery_dispatch_failed";
    slice.last_action = ts;
    slice.last_action_note = "NEED: Hatchery dispatch failed: " + errorText;
    deps.emitTransition({ type: "slice.escalated", sliceId, reason: "hatchery_dispatch_failed" });
    const commandLine = actionCommandLine({ command: slice.command, arguments: slice.arguments || [] });
    failures.push({ slice_id: sliceId, command: commandLine, error: errorText });
    // Only escalate to the operator once auto-recovery is out of budget. Within
    // budget the loop re-dispatches this slice itself (#211) on this same tick, so
    // a judgement request here fires before recovery runs and would prompt the
    // operator to intervene prematurely. The failure is still recorded above.
    if (recoveryBudgetExhausted(state, sliceId)) {
      // Stable requestKey so the judgement request fires once per distinct failure.
      notifications.push({
        slice, sliceId,
        requestKey: "hatchery-failure:" + sliceId + ":" + hashText(errorText).slice(0, 12),
        reason: "hatchery_dispatch_failed",
        detail: "Hatchery dispatch for " + commandLine + " failed and was escalated.\n\nError:\n" + errorText.trim()
          + "\n\nThe loop auto-recovered this " + DISPATCH_RECOVERY_LIMIT + " times and it still failed, so the slice is"
          + " now operator-only. A 'branch already exists' / diverged-branch collision needs legate.unwedge + a Brood"
          + " teardown of the orphan branch/worktree (#155) before re-dispatch; otherwise run legate.error for"
          + " worker-side recovery.",
      });
    }
    mutated = true;
  };

  for (const [sliceId, slice] of Object.entries(slices)) {
    if (!slice || typeof slice !== "object" || slice.stage !== "hatchery-pending") continue;
    const jobId = slice.hatchery?.job_id;
    // A pending slice always has a job id within a process (launchDispatch sets it
    // synchronously or escalates), and the fold restores it on restart. A missing
    // id here is a defensive skip, not a strand.
    if (typeof jobId !== "string" || jobId.length === 0) continue;
    let job;
    try {
      job = await deps.getJob(jobId);
    } catch (err: any) {
      // A network blip is transient — the Hatchery client prefixes those with
      // "Could not reach …" — so wait and re-poll next tick rather than escalating
      // a healthy in-flight spawn. Any other failure is a real lookup failure
      // (e.g. a 404 because a Hatchery restart lost the job, or a persistent
      // non-200); that would otherwise strand the slice in hatchery-pending
      // forever, so escalate it for judgement.
      const message = String(err?.message || "");
      if (message.startsWith("Could not reach")) continue;
      escalate(slice, sliceId, "Hatchery job lookup failed: " + (message || "unknown error"));
      continue;
    }
    if (job.status !== "succeeded" && job.status !== "failed") {
      // Still pending/running — wait for the next tick.
      continue;
    }
    if (job.status === "failed" || job.result?.error) {
      const errorText = String(job.status === "failed" ? (job.error?.message || "hatchery spawn failed") : job.result.error).trim();
      // #173: a background spawn that failed because the branch already has this
      // slice's open PR is an adopt, not an escalate. The async service model
      // surfaces the collision here (the spawn runs after POST /spawns' 202), so
      // the same forge-truth check that guards the launch path guards this one.
      const adopted = await adoptOpenPrOnCollision(state, ts, sliceId, errorText, deps);
      if (adopted) {
        actions.push(adopted);
        mutated = true;
        continue;
      }
      escalate(slice, sliceId, errorText);
      continue;
    }
    // Success: hand off to the manager session Hatchery launched.
    const result: any = job.result || {};
    const manager = result.managerSession || {};
    const artifacts = result.artifacts || {};
    slice.worker_session_id = manager.sessionId || null;
    slice.worker_title = manager.title || slice.worker_title;
    slice.branch = result.branch || manager.branch || slice.branch;
    slice.worktree_path = manager.worktreePath || null;
    slice.stage = "implementing";
    // Stable handoff timestamp so stranded-steward detection measures elapsed time
    // without being reset by later last_action updates.
    slice.implementing_started_at = ts;
    slice.last_action = ts;
    slice.last_action_note = "Hatchery codex spawn completed and handed off to manager";
    slice.hatchery = {
      ...(slice.hatchery || {}),
      spawn_id: result.spawnId,
      backend: result.backend || "codex",
      artifacts_dir: artifacts.dir || null,
      patch_path: artifacts.patchPath || null,
      spawn_output_path: artifacts.spawnOutputPath || null,
      metadata_path: artifacts.metadataPath || null,
    };
    // Carry the steward sessionId on the transition so Herald's fold learns the
    // slice→session link (#210). Without it Herald's PR-discovery gate skips the
    // steward forever, leaving real PRs stranded in an endless nudge loop. A
    // restart's rebuild keeps the link too. Complements the Hatchery push (#213).
    deps.emitTransition({ type: "slice.stage.changed", sliceId, stage: "implementing", sessionId: manager.sessionId || undefined });
    // Clear any transient retry counters for this slice — it cleanly transitioned
    // to implementing, so prior transient failures no longer matter. The fold has
    // no clear event, so emit a durable retry.counted(0) per cleared key; without
    // it the counter would reappear from sys.retries on a cold start and could
    // wrongly deny recovery to a later re-incarnation of the same slice id (#211).
    if (state.transient_retry_counts && typeof state.transient_retry_counts === "object") {
      const cleared: string[] = [];
      if (Object.prototype.hasOwnProperty.call(state.transient_retry_counts, sliceId)) cleared.push(sliceId);
      for (const k of Object.keys(state.transient_retry_counts)) {
        if (k.endsWith(":" + sliceId)) cleared.push(k);
      }
      for (const k of cleared) {
        delete state.transient_retry_counts[k];
        deps.emitTransition({ type: "retry.counted", key: k, count: 0 });
      }
    }
    actions.push({
      action: "dispatch-complete",
      sliceId,
      sessionId: manager.sessionId || null,
      detail: "Hatchery codex spawn completed for " + actionCommandLine({ command: slice.command, arguments: slice.arguments || [] }),
    });
    mutated = true;
  }
  return { actions, failures, mutated, notifications };
}
