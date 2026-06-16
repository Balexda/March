import fs from "node:fs";
import path from "node:path";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { isWorkerSession } from "../pure/session.js";
import { ensureRetryCounts } from "../state/mutations.js";
import { execText } from "../clients/exec.js";

/**
 * Steward relaunch: a non-terminal slice that still has an open PR but whose
 * worker session has vanished (crashed/removed) gets a fresh opus steward
 * re-attached to its EXISTING worktree/branch (createBranch:false), so future
 * babysit messages have somewhere to land. assess() is pure; apply() recreates
 * the worktree if needed, launches via Castra, sends a resume-context prompt,
 * and rewrites the slice's worker pointer. Throttled to {@link RELAUNCH_LIMIT}
 * attempts per slice via the working state's transient_retry_counts.
 *
 * Brood reconciliation AT THE SOURCE (#308): a relaunch mints a NEW session id
 * (the prior one vanished) and may land on a NEW worktree, but it only used to
 * rewrite the legate's in-memory pointer — Brood was never told. So the prior
 * attempt's row stayed registered (torndown later, possibly resolving the wrong
 * session by worktree match, #304) and the new attempt was never registered →
 * an untracked orphan the moment its slice completes. apply() now closes that at
 * the source: after a successful launch it REGISTERS the new session+worktree
 * with Brood and REAPS the prior steward's Brood record, so at most one live
 * steward + worktree per slice exists and Brood always tracks the live one. The
 * prior reap is GUARDED on a distinct worktree path: Brood's steward removal
 * resolves the live session by exact worktree (#304), so tearing down the prior
 * when both share a worktree path would pull the checkout out from under the
 * freshly relaunched session. Both Brood calls are best-effort — a failure logs
 * and records a note but never fails the relaunch (the #304 sweep is the net).
 */

const ELIGIBLE_STAGES = new Set([
  "implementing",
  "pr-open",
  "pr-in-fix",
  "pr-resolving-conflicts",
  "pr-rebasing",
  "pr-in-rerun",
]);
const RELAUNCH_LIMIT = 3;

export interface RelaunchDecision {
  readonly sliceId: string;
  readonly bareBranch: string;
  readonly featureBranch: string;
  readonly expectedDirName: string;
  readonly worktreePath: string;
  readonly launchTitle: string;
  readonly prNumber: number;
  readonly prUrl: string;
  /** This attempt's 1-based count (== persisted counter after apply). */
  readonly attempt: number;
  readonly limit: number;
}

/** Side-effect seams for apply — injectable so the git/fs writes are testable. */
export interface RelaunchDeps {
  worktreeExists: (p: string) => boolean;
  ensureWorktree: (worktreePath: string, featureBranch: string, repoPath: string) => Promise<void>;
}

const defaultRelaunchDeps: RelaunchDeps = {
  worktreeExists: (p) => fs.existsSync(p),
  ensureWorktree: async (worktreePath, featureBranch, repoPath) => {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await execText("git", ["worktree", "add", worktreePath, featureBranch], { cwd: repoPath });
  },
};

function errMsg(err: any): string {
  return (err?.message || String(err)).slice(0, 200);
}

/** Pure read of the throttle counters (assess never mutates them). */
function readRetryCounts(raw: any): Record<string, number> {
  const c = raw?.transient_retry_counts;
  return c && typeof c === "object" ? c : {};
}

function stewardResumeMessage(d: RelaunchDecision): string {
  return [
    "[STEWARD RESUME] You are the re-launched March Hatchery management session for PR #" + d.prNumber + ".",
    "Branch: " + d.featureBranch,
    "PR: " + d.prUrl,
    "",
    "The previous steward session for this slice was removed; the loop has attached you to the",
    "existing worktree so future babysit messages have somewhere to go. Stand by for:",
    "  - '/smithy.fix <thread-summary>' if review threads need a response.",
    "  - Conflict-resolution prompts if the branch develops merge conflicts.",
    "  - CI-failure judgement requests.",
    "",
    "When such a message arrives, act on it directly: inspect, fix, commit, push.",
    "Do not pre-emptively rewrite anything; the PR is already open and may be in review.",
  ].join("\n");
}

/** Pure: which slices have lost their steward and are within the retry budget. */
export function assess(state: LoopState): RelaunchDecision[] {
  const out: RelaunchDecision[] = [];
  const repoPath = state.repoPath;
  if (typeof repoPath !== "string" || repoPath.length === 0) return out;

  const liveSessionIds = new Set<string>();
  for (const s of state.sessions) {
    if (isWorkerSession(s, state.workerGroup) && typeof s?.id === "string") liveSessionIds.add(s.id);
  }
  const counts = readRetryCounts(state.raw);
  const worktreesParent = path.join(path.dirname(repoPath), "WorkTrees", path.basename(repoPath));

  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    if (!ELIGIBLE_STAGES.has(slice.stage)) continue;
    const pr = slice.pr || {};
    if (!pr.number) continue;
    const sessId = slice.worker_session_id;
    if (typeof sessId === "string" && sessId.length > 0 && liveSessionIds.has(sessId)) continue;
    const rawBranch = typeof slice.branch === "string" ? slice.branch : "";
    if (rawBranch.length === 0) continue;
    const bareBranch = rawBranch.replace(/^feature\//, "");
    const featureBranch = "feature/" + bareBranch;
    const expectedDirName = "feature-" + bareBranch.replace(/\//g, "-");
    const key = "relaunch-steward:" + sliceId;
    const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
    const attempt = prev + 1;
    if (attempt > RELAUNCH_LIMIT) continue;
    out.push({
      sliceId,
      bareBranch,
      featureBranch,
      expectedDirName,
      worktreePath: slice.worktree_path || path.join(worktreesParent, expectedDirName),
      launchTitle: slice.worker_title || "steward: " + sliceId,
      prNumber: pr.number,
      prUrl: pr.url || "(unknown)",
      attempt,
      limit: RELAUNCH_LIMIT,
    });
  }
  return out;
}

/**
 * Reconcile Brood after a successful relaunch (#308). Registers the LIVE steward
 * (new session id + its real worktree) so Brood owns its #155-safe teardown, then
 * reaps the prior steward's Brood record. The reap is GUARDED on a distinct
 * worktree path: Brood resolves the steward's real session by exact worktree
 * (#304), so tearing down the prior when it shares the live worktree would remove
 * the freshly relaunched session/checkout. Returns a short note for the action
 * log (or "" when nothing notable happened). Never throws — Brood unavailability
 * must not fail a relaunch; the #304 sweep remains the safety net.
 */
async function reconcileBrood(
  ctx: HandlerContext,
  state: LoopState,
  d: RelaunchDecision,
  ids: {
    newSessionId: string;
    liveWorktree: string;
    priorSessionId: string;
    priorWorktree: string;
    /** Hatchery spawn id this steward belongs to (#308) — preserved as the new
     *  row's parentId so terminal teardown resolves & archives the spawn group. */
    parentSpawnId: string;
  },
): Promise<string> {
  const notes: string[] = [];

  // Register the live steward FIRST so a crash between the two calls leaves the
  // live one tracked rather than orphaned.
  if (ctx.broodRegister) {
    try {
      const reg = await ctx.broodRegister({
        id: ids.newSessionId,
        kind: "steward",
        status: "running",
        // Preserve the spawn parent (#308): Brood teardown uses a steward's
        // parentId to resolve/mark the spawn+steward group; without it the
        // relaunched steward looks unparented and terminal cleanup leaves the
        // original spawn row active/unarchived. Omit when there is no spawn id
        // (a steward not backed by a Hatchery spawn).
        ...(ids.parentSpawnId ? { parentId: ids.parentSpawnId } : {}),
        agentDeckSessionId: ids.newSessionId,
        profile: ctx.meta.profile,
        repoPath: state.repoPath as string,
        branch: d.featureBranch,
        worktreePath: ids.liveWorktree,
        ...(ctx.meta.worker_group ? { group: ctx.meta.worker_group } : {}),
      });
      notes.push(reg.ok ? "registered live steward with Brood" : "Brood register failed: " + reg.detail);
      if (!reg.ok) ctx.log(`relaunch ${d.sliceId}: Brood register of ${ids.newSessionId} failed: ${reg.detail}`);
    } catch (err) {
      notes.push("Brood register errored: " + errMsg(err));
      ctx.log(`relaunch ${d.sliceId}: Brood register of ${ids.newSessionId} errored: ${errMsg(err)}`);
    }
  }

  // Reap the prior steward — only when it is a DISTINCT session on a DISTINCT
  // worktree (else the worktree-match teardown would reap the live one, #304).
  const distinctSession = ids.priorSessionId.length > 0 && ids.priorSessionId !== ids.newSessionId;
  const distinctWorktree = ids.priorWorktree.length > 0 && ids.priorWorktree !== ids.liveWorktree;
  if (distinctSession && distinctWorktree) {
    try {
      const teardown = await ctx.broodTeardown(ids.priorSessionId, {
        force: true,
        reason: "steward-relaunch",
        traceKey: d.sliceId,
      });
      if (teardown.ok) notes.push("reaped prior steward " + ids.priorSessionId);
      else if (teardown.notTracked) notes.push("prior steward " + ids.priorSessionId + " not tracked by Brood");
      else {
        notes.push("prior reap failed: " + teardown.detail);
        ctx.log(`relaunch ${d.sliceId}: Brood teardown of prior ${ids.priorSessionId} failed: ${teardown.detail}`);
      }
    } catch (err) {
      notes.push("prior reap errored: " + errMsg(err));
      ctx.log(`relaunch ${d.sliceId}: Brood teardown of prior ${ids.priorSessionId} errored: ${errMsg(err)}`);
    }
  } else if (distinctSession && !distinctWorktree) {
    // Same worktree path: a teardown would resolve the live session by worktree
    // and remove it (#304), so we must NOT tear down. But the register above only
    // upserts the NEW id — it does not retire the PRIOR row, so Brood would track
    // BOTH stewards on this worktree and the stale row (its worktree still
    // present) is not even a #304 sweep candidate, lingering forever. Retire the
    // prior row (status → torndown, no worktree prune) so exactly ONE active row
    // remains for the worktree (#308).
    if (ctx.broodRetire) {
      try {
        const retired = await ctx.broodRetire(ids.priorSessionId);
        if (retired.ok) notes.push("retired prior steward " + ids.priorSessionId + " (shared worktree)");
        else if (retired.notTracked) notes.push("prior steward " + ids.priorSessionId + " not tracked by Brood");
        else {
          notes.push("prior retire failed: " + retired.detail);
          ctx.log(`relaunch ${d.sliceId}: Brood retire of prior ${ids.priorSessionId} failed: ${retired.detail}`);
        }
      } catch (err) {
        notes.push("prior retire errored: " + errMsg(err));
        ctx.log(`relaunch ${d.sliceId}: Brood retire of prior ${ids.priorSessionId} errored: ${errMsg(err)}`);
      }
    } else {
      notes.push("prior steward shares live worktree — broodRetire unavailable");
    }
  }

  return notes.join("; ");
}

export async function apply(
  decisions: RelaunchDecision[],
  ctx: HandlerContext,
  state: LoopState,
  deps: RelaunchDeps = defaultRelaunchDeps,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (decisions.length === 0) return res;
  const counts = ensureRetryCounts(state.raw);

  // Persist THIS attempt against the budget. Called on success AND on every
  // failure path: a relaunch that can never succeed (unrecreatable worktree, a
  // launch error) must still advance the counter, else assess re-selects it every
  // tick forever and RELAUNCH_LIMIT is never reached (the relaunch_failed churn).
  const recordAttempt = (d: RelaunchDecision): void => {
    counts["relaunch-steward:" + d.sliceId] = d.attempt;
    ctx.emitTransition?.({ type: "retry.counted", key: "relaunch-steward:" + d.sliceId, count: d.attempt });
  };

  for (const d of decisions) {
    if (!deps.worktreeExists(d.worktreePath)) {
      try {
        await deps.ensureWorktree(d.worktreePath, d.featureBranch, state.repoPath as string);
      } catch (err) {
        recordAttempt(d);
        res.mutated = true;
        res.actions.push({
          action: "relaunch-failed",
          sliceId: d.sliceId,
          sessionId: null,
          detail: "could not recreate worktree at " + d.worktreePath + " from branch " + d.featureBranch + " (attempt " + d.attempt + "/" + d.limit + "): " + errMsg(err),
        });
        continue;
      }
    }

    // Capture the PRIOR steward's identity BEFORE the rebind so we can reap its
    // Brood record after the new one is registered (#308).
    const slice = state.slices[d.sliceId];
    const priorSessionId = typeof slice.worker_session_id === "string" ? slice.worker_session_id : "";
    const priorWorktree = typeof slice.worktree_path === "string" ? slice.worktree_path : "";
    // The Hatchery spawn this steward belongs to — re-registered as the new
    // row's parentId so Brood keeps the spawn↔steward group intact (#308).
    const parentSpawnId =
      slice.hatchery && typeof slice.hatchery.spawn_id === "string" ? slice.hatchery.spawn_id : "";

    let newSessionId: string | null = null;
    let liveWorktree = d.worktreePath;
    try {
      const relaunched = await ctx.castra.launchSession({
        profile: ctx.meta.profile,
        repoPath: state.repoPath as string,
        branch: d.bareBranch,
        title: d.launchTitle,
        group: ctx.meta.worker_group,
        model: "opus",
        // Attach to the EXISTING branch/PR — never `-b` (it already exists). This
        // flag was previously dropped by the async client, collapsing the attach
        // into a create that always failed "branch already exists".
        createBranch: false,
        traceKey: d.sliceId,
      });
      newSessionId = relaunched.sessionId;
      // The launch response carries the session's REAL worktree (agent-deck may
      // pick a fresh hashed path when feature-<branch> already exists); register
      // and track THAT, not the assess-time guess, so Brood owns the live path.
      if (typeof relaunched.worktreePath === "string" && relaunched.worktreePath.length > 0) {
        liveWorktree = relaunched.worktreePath;
      }
    } catch (err) {
      recordAttempt(d);
      res.mutated = true;
      res.actions.push({ action: "relaunch-failed", sliceId: d.sliceId, sessionId: null, detail: "castra launch failed (attempt " + d.attempt + "/" + d.limit + "): " + errMsg(err) });
      continue;
    }
    if (!newSessionId) {
      recordAttempt(d);
      res.mutated = true;
      res.actions.push({ action: "relaunch-failed", sliceId: d.sliceId, sessionId: null, detail: "castra launch returned no identifiable new session (attempt " + d.attempt + "/" + d.limit + ")" });
      continue;
    }

    try {
      await ctx.castra.sendPrompt({ profile: ctx.meta.profile, sessionId: newSessionId, prompt: stewardResumeMessage(d), traceKey: d.sliceId } as any);
    } catch {
      // Best-effort: session is alive; future babysit messages will still reach it.
    }

    // #308: register the LIVE steward with Brood and reap the prior one's record
    // so Brood tracks exactly one live steward + worktree per slice. Best-effort
    // — neither call may fail the relaunch (the live session must serve the PR).
    const reconcileNote = await reconcileBrood(ctx, state, d, {
      newSessionId,
      liveWorktree,
      priorSessionId,
      priorWorktree,
      parentSpawnId,
    });

    slice.worker_session_id = newSessionId;
    slice.worker_title = d.launchTitle;
    slice.worktree_path = liveWorktree;
    slice.last_action = ctx.ts;
    slice.last_action_note = "Re-launched steward for PR #" + d.prNumber + " (attempt " + d.attempt + "/" + d.limit + "); new session " + newSessionId;
    ctx.emitTransition?.({ type: "steward.relaunched", sliceId: d.sliceId, sessionId: newSessionId });
    recordAttempt(d);
    res.mutated = true;
    res.actions.push({
      action: "relaunch-steward",
      sliceId: d.sliceId,
      sessionId: newSessionId,
      detail:
        "re-attached opus steward to PR #" + d.prNumber + " on " + d.featureBranch +
        " (attempt " + d.attempt + "/" + d.limit + ")" + (reconcileNote ? "; " + reconcileNote : ""),
    });
  }

  return res;
}
