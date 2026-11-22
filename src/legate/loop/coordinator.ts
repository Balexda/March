import type { HandlerContext, HandlerResult, LoopState, TickResult } from "./state/types.js";
import * as cleanup from "./handlers/cleanup.js";
import * as ghostCleanup from "./handlers/ghost-cleanup.js";
import * as castraRecover from "./handlers/castra-recover.js";
import * as relaunch from "./handlers/relaunch.js";
import * as babysit from "./handlers/babysit.js";
import * as recovery from "./handlers/recovery.js";
import * as requeue from "./handlers/requeue.js";
import * as mergeNow from "./handlers/merge-now.js";
import * as adoptFromFold from "./handlers/adopt-from-fold.js";
import * as dispatch from "./handlers/dispatch.js";
import * as dependencyMerge from "./handlers/dependency-merge.js";
import * as prLabels from "./handlers/pr-labels.js";
import * as coderabbitRereview from "./handlers/coderabbit-rereview.js";
import {
  countStrandedSlices,
  DISPATCH_DECISIONS,
  dispatchableReady,
  summarizeSlicesByStage,
  type DispatchDecisionRow,
  type SpawnBudget,
} from "./pure/slice.js";
import { isDeadSessionStatus, isWorkerSession } from "./pure/session.js";

/**
 * Stage 2 orchestration. runTick senses once, then runs the handlers in the fixed
 * order cleanup → ghost-cleanup → castra-recover → relaunch → babysit →
 * coderabbit-rereview → recovery →
 * adopt-from-fold → dispatch → dependency-merge → pr-labels,
 * each as pure assess() + effecting apply(), threading the SAME mutating {@link LoopState}
 * through all of them. Because apply() mutates the snapshot in place (drops a
 * cleaned session, archives a slice), a later handler's assess() sees the current
 * world without re-polling — this replaces the monolith's habit of re-listing
 * Castra sessions between handlers.
 */

export interface CoordinatorDeps {
  /** Stage 1 — gather the snapshot (bound to its SenseDeps). */
  sense: () => Promise<LoopState>;
  /** Build the per-tick handler context (Castra/Brood/persist/emit/log). */
  makeContext: (state: LoopState) => HandlerContext;
  babysit: babysit.BabysitDeps;
  dispatch: dispatch.DispatchDeps;
  relaunch?: relaunch.RelaunchDeps;
  /** GitHub seams for the operator requeue (#588). Omitted → a requeue that must
   *  close a PR fails (and retries); one with no PR / remote branch still works. */
  requeue?: requeue.RequeueDeps;
  /** GitHub seams for the operator merge-now (#593). Omitted → a merge request
   *  is refused ("GitHub seam unavailable") rather than silently stalling. */
  mergeNow?: mergeNow.MergeNowDeps;
  /** Seams for the opt-in Dependabot auto-merge. Omitted → the handler is inert. */
  dependencyMerge?: dependencyMerge.DependencyMergeDeps;
  /** Seams for opt-in reviewer requests. Omitted → the handler is inert. */
  coderabbitRereview?: coderabbitRereview.ReviewRequestDeps;
  /** Seams for the PR label reconciler (`march:opened` / `march:needs-human`). Omitted → inert. */
  prLabels?: prLabels.PrLabelsDeps;
  /** The GLOBAL concurrent-spawn budget (#313), shared across every profile this
   *  tick. Attached to the handler context so dispatch caps fresh launches against
   *  it. Omitted → dispatch is uncapped (pre-#313 behavior). */
  spawnBudget?: SpawnBudget;
}

export interface CoordinatorOutput {
  state: LoopState;
  tick: TickResult;
  results: {
    /** Operator requeue (#588/#593); absent in outputs built without it. */
    requeue?: HandlerResult;
    /** Operator merge-now (#593); absent in outputs built without it. */
    mergeNow?: HandlerResult;
    cleanup: HandlerResult;
    ghost: HandlerResult;
    castraRecover: HandlerResult;
    relaunch: HandlerResult;
    babysit: HandlerResult;
    /** Opt-in reviewer requests; absent in outputs built without it. */
    coderabbitRereview?: HandlerResult;
    recovery: HandlerResult;
    adoptFromFold: HandlerResult;
    dispatch: HandlerResult;
    /** Opt-in Dependabot auto-merge; absent in outputs built without it. */
    dependencyMerge?: HandlerResult;
    /** PR label reconciler; absent in outputs built without it. */
    prLabels?: HandlerResult;
  };
}

/** Per-decision tally of the dispatch rows, every bounded decision present (#592). */
export function countDispatchDecisions(rows: readonly DispatchDecisionRow[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(DISPATCH_DECISIONS.map((d) => [d, 0]));
  for (const row of rows) counts[row.decision] = (counts[row.decision] ?? 0) + 1;
  return counts;
}

const countAction = (res: HandlerResult, action: string): number => res.actions.filter((a) => a?.action === action).length;

function buildTickResult(state: LoopState, r: CoordinatorOutput["results"], spawnBudget?: SpawnBudget): TickResult {
  // The steward-nudge family rides in on the babysit handler's actions but is
  // metricized on its own (#212), so split it out of the babysit umbrella count.
  const stewardNudgeCount = countAction(r.babysit, "steward-nudge");
  const stewardStrandedCount = countAction(r.babysit, "steward-stranded");
  // Tally after all handlers ran so stages/PR snapshots reflect this tick (#220).
  // The merge-readiness 3-way (ready / waiting-approval / blocked-merge-state) is
  // read from each slice's `merge_gate` stamp (babysit's live-PR verdict).
  const { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState, escalatedByReason, prBlocker } =
    summarizeSlicesByStage(state.slices);
  // Per-kind babysit fix-dispatch breakdown — the aggregate `babysitActionCount`
  // hides WHICH fix the loop is doing. Bounded label set, keyed in metric form.
  const babysitActionsByKind: Record<string, number> = {
    conflict_fix: countAction(r.babysit, "conflict-fix"),
    review_fix: countAction(r.babysit, "review-fix"),
    ci_fix: countAction(r.babysit, "ci-fix"),
    comment_fix: countAction(r.babysit, "comment-fix"),
  };
  // The TRUE dispatch-ready count: the record-paced set the dispatcher actually
  // launches (`dispatchableReady`), distinct from the node-level `queue.dispatchable`
  // frontier metric which over-counts (escalated/blocked-shadow nodes). Computed
  // post-handlers, so it reflects work STILL ready after this tick's dispatch —
  // the precise "ready but not flowing" signal the dispatch alarms key on.
  const dispatchableReadyCount = state.smithy.ok
    ? dispatchableReady(state.raw, state.smithy.ready).length
    : 0;
  // Slices in a steward stage with no live steward behind them (#stranded): the
  // adopted-but-steward-less open PRs + crashed-steward slices. Without this they
  // count as healthy "In steward" on the board while relaunch fails (or has given
  // up) every tick. Built from this tick's live worker-session list.
  const liveWorkerSessionIds = new Set<string>();
  for (const s of Array.isArray(state.sessions) ? state.sessions : []) {
    // A listed-but-dead session (`error`/`stopped`, #587) is no live steward.
    if (
      isWorkerSession(s, state.workerGroup) &&
      typeof s?.id === "string" &&
      s.id.length > 0 &&
      !isDeadSessionStatus(s.status)
    ) {
      liveWorkerSessionIds.add(s.id);
    }
  }
  const strandedCount = countStrandedSlices(state.slices, liveWorkerSessionIds);
  return {
    ts: state.ts,
    statePresent: state.statePresent,
    stateError: state.stateError,
    sliceCount: Object.keys(state.slices).length,
    archivedSliceCount: Object.keys(state.archived).length,
    workers: state.workers,
    queue: state.smithy.queue,
    slicesByStage: byStage,
    readyToMergeCount: readyToMerge,
    waitingOnApprovalCount: waitingOnApproval,
    blockedOnMergeStateCount: blockedOnMergeState,
    dispatchableReadyCount,
    strandedCount,
    escalatedByReason,
    prBlockerCounts: prBlocker,
    babysitActionsByKind,
    cleanupCount: r.cleanup.actions.length,
    cleanupFailureCount: r.cleanup.failures.length,
    ghostCleanupCount: countAction(r.ghost, "ghost-cleanup"),
    ghostCleanupFailureCount: countAction(r.ghost, "ghost-cleanup-failed"),
    ghostCleanupDeferredCount: countAction(r.ghost, "ghost-cleanup-deferred"),
    relaunchCount: countAction(r.relaunch, "relaunch-steward"),
    relaunchFailureCount: countAction(r.relaunch, "relaunch-failed"),
    // AIMD self-healing rate, read from the working state the relaunch handler
    // maintains (default 1 when unset). Surfaced as a gauge so the operator can
    // see recovery throttle down after an outage and ramp back up.
    recoveryRate: Number.isFinite(state.raw?.recovery_rate) ? state.raw.recovery_rate : 1,
    babysitActionCount: r.babysit.actions.length - stewardNudgeCount - stewardStrandedCount,
    stewardNudgeCount,
    stewardStrandedCount,
    processorRequestCount: (r.requeue?.requests.length ?? 0) + (r.mergeNow?.requests.length ?? 0) + r.cleanup.requests.length + r.babysit.requests.length + r.dispatch.requests.length,
    dispatchActionCount: r.dispatch.actions.length,
    dispatchFailureCount: r.dispatch.failures.length,
    ...(spawnBudget
      ? { spawnCap: spawnBudget.cap, spawnsLive: spawnBudget.live, spawnsDeferred: spawnBudget.deferred }
      : {}),
    dispatchDecisions: state.smithy.ok ? (r.dispatch.dispatchDecisions ?? []) : null,
    ...(state.smithy.ok ? { dispatchDecisionCounts: countDispatchDecisions(r.dispatch.dispatchDecisions ?? []) } : {}),
  };
}

export async function runTick(deps: CoordinatorDeps): Promise<CoordinatorOutput> {
  const state = await deps.sense();
  const ctx = deps.makeContext(state);
  // Share the global spawn budget with the dispatch handler via the context so a
  // single tick's combined fresh launches across all profiles stay under the cap.
  ctx.spawnBudget = deps.spawnBudget;

  // Awaited in order — each apply mutates the shared snapshot, so a later
  // handler's assess sees the current world. Do NOT parallelize: the ordering
  // (cleanup drops a session before babysit reads it) is load-bearing.
  const results = {
    // Operator requeue (#588/#593) runs FIRST: it discards the slice's incarnation
    // and drops it from the snapshot, so no later handler (cleanup archiving its
    // just-closed PR, relaunch re-attaching, babysit re-escalating) acts on a slice
    // the operator threw away — and dispatch re-launches the freed item this tick.
    requeue: await requeue.apply(requeue.assess(state), ctx, state, deps.requeue),
    // Operator merge-now (#593): right after requeue, so a merge the operator asked
    // for lands before cleanup/babysit evaluate the PR this tick.
    mergeNow: await mergeNow.apply(mergeNow.assess(state), ctx, state, deps.mergeNow),
    cleanup: await cleanup.apply(cleanup.assess(state), ctx, state),
    ghost: await ghostCleanup.apply(ghostCleanup.assess(state), ctx, state),
    // Restart errored worker sessions (e.g. post-reboot) in place BEFORE relaunch
    // (which only fires on a vanished session) and babysit (which would escalate
    // a present-but-errored worker) — apply mutates the snapshot so they see the
    // recovered sessions as live this same tick.
    castraRecover: await castraRecover.apply(castraRecover.assess(state), ctx, state),
    relaunch: await relaunch.apply(relaunch.assess(state), ctx, state, deps.relaunch),
    babysit: await babysit.apply(babysit.assess(state), ctx, state, deps.babysit),
    // After babysit, so a slice babysit just sent a fix to (no longer pr-open) is
    // not put forward for re-review until the steward has pushed it.
    coderabbitRereview: await coderabbitRereview.apply(ctx, state, deps.coderabbitRereview),
    // Operator recovery (#238) runs BEFORE dispatch so the dropped slice frees the
    // still-ready smithy item for a fresh re-dispatch on this same tick.
    recovery: await recovery.apply(recovery.assess(state), ctx, state),
    // #173: adopt-from-fold runs BEFORE dispatch so an escalated slice whose branch
    // Herald observed an open PR on is transitioned to pr-open here, and dispatch's
    // recoverableEscalations no longer re-dispatches it (no collision needed).
    adoptFromFold: await adoptFromFold.apply(adoptFromFold.assess(state), ctx, state),
    dispatch: await dispatch.apply(dispatch.assess(state), ctx, state, deps.dispatch),
    // Last: independent of every slice, so it never delays slice work, and a
    // failure here cannot affect the handlers above.
    dependencyMerge: await dependencyMerge.apply(ctx, state, deps.dependencyMerge),
    // Also last: label bookkeeping only, reading the slice state babysit has
    // already settled; a failure cannot affect any handler above.
    prLabels: await prLabels.apply(ctx, state, deps.prLabels),
  };

  return { state, tick: buildTickResult(state, results, deps.spawnBudget), results };
}
