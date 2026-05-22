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
import {
  actionArguments,
  actionCommandLine,
  dispatchBranch,
  dispatchIdentity,
  dispatchTitle,
} from "../pure/dispatch-id.js";
import { buildSmithySpawnPrompt } from "../pure/messages.js";
import { hashText } from "../pure/hash.js";
import { DISPATCH_RECOVERY_LIMIT, recoveryAttemptKey } from "../pure/slice.js";

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
    const existing = state.slices?.[sliceId];
    if (existing && existing.stage === "hatchery-pending") {
      existing.stage = "escalated";
      // Tag the recoverable class so the loop's bounded auto-recovery (#211) can
      // re-dispatch this slice; survives a restart via rebuildWorkingState.
      existing.escalated_reason = "hatchery_dispatch_failed";
      existing.last_action = ts;
      existing.last_action_note = "NEED: Hatchery dispatch launch failed: " + error;
      deps.emitTransition({ type: "slice.escalated", sliceId, reason: "hatchery_dispatch_failed" });
      notifications.push({
        slice: existing, sliceId,
        requestKey: "hatchery-failure:" + sliceId + ":launch-throw:" + hashText(error).slice(0, 12),
        reason: "hatchery_dispatch_failed",
        detail: "Hatchery dispatch launch threw for " + actionCommandLine(action) + ".\n\nError:\n" + error
          + "\n\nThe loop auto-recovers this class up to " + DISPATCH_RECOVERY_LIMIT + " times; if you are seeing this the"
          + " budget is exhausted. For 'branch already exists' surface this via legate.unwedge; otherwise legate.error.",
      });
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

  // The slice was `escalated` in the Herald fold; slice.dispatched alone does not
  // reset stage, so emit the stage transition explicitly when the re-launch landed
  // it in hatchery-pending. This keeps the fold correct so a restart mid-recovery
  // resumes the completion poll instead of re-recovering. If launchDispatch's own
  // catch re-escalated (the POST threw), the slice is escalated again — leave it.
  if (state.slices?.[sliceId]?.stage === "hatchery-pending") {
    deps.emitTransition({ type: "slice.stage.changed", sliceId, stage: "hatchery-pending" });
  }
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
    // Stable requestKey so the judgement request fires once per distinct failure.
    notifications.push({
      slice, sliceId,
      requestKey: "hatchery-failure:" + sliceId + ":" + hashText(errorText).slice(0, 12),
      reason: "hatchery_dispatch_failed",
      detail: "Hatchery dispatch for " + commandLine + " failed and was escalated.\n\nError:\n" + errorText.trim()
        + "\n\nThe loop auto-recovers recoverable dispatch failures up to " + DISPATCH_RECOVERY_LIMIT + " times before"
        + " leaving the slice operator-only — if you are seeing this judgement request the budget is exhausted. A"
        + " 'branch already exists' / diverged-branch collision needs legate.unwedge + a Brood teardown of the orphan"
        + " branch/worktree (#155) before re-dispatch; otherwise run legate.error for worker-side recovery.",
    });
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
    // to implementing, so prior transient failures no longer matter.
    if (state.transient_retry_counts && typeof state.transient_retry_counts === "object") {
      delete state.transient_retry_counts[sliceId];
      for (const k of Object.keys(state.transient_retry_counts)) {
        if (k.endsWith(":" + sliceId)) delete state.transient_retry_counts[k];
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
