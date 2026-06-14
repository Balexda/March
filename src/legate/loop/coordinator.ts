import type { HandlerContext, HandlerResult, LoopState, TickResult } from "./state/types.js";
import * as cleanup from "./handlers/cleanup.js";
import * as ghostCleanup from "./handlers/ghost-cleanup.js";
import * as castraRecover from "./handlers/castra-recover.js";
import * as relaunch from "./handlers/relaunch.js";
import * as babysit from "./handlers/babysit.js";
import * as recovery from "./handlers/recovery.js";
import * as adoptFromFold from "./handlers/adopt-from-fold.js";
import * as dispatch from "./handlers/dispatch.js";
import { dispatchableReady, summarizeSlicesByStage, type SpawnBudget } from "./pure/slice.js";

/**
 * Stage 2 orchestration. runTick senses once, then runs the handlers in the fixed
 * order cleanup → ghost-cleanup → castra-recover → relaunch → babysit → recovery →
 * adopt-from-fold → dispatch,
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
  /** The GLOBAL concurrent-spawn budget (#313), shared across every profile this
   *  tick. Attached to the handler context so dispatch caps fresh launches against
   *  it. Omitted → dispatch is uncapped (pre-#313 behavior). */
  spawnBudget?: SpawnBudget;
}

export interface CoordinatorOutput {
  state: LoopState;
  tick: TickResult;
  results: {
    cleanup: HandlerResult;
    ghost: HandlerResult;
    castraRecover: HandlerResult;
    relaunch: HandlerResult;
    babysit: HandlerResult;
    recovery: HandlerResult;
    adoptFromFold: HandlerResult;
    dispatch: HandlerResult;
  };
}

const countAction = (res: HandlerResult, action: string): number => res.actions.filter((a) => a?.action === action).length;

function buildTickResult(state: LoopState, r: CoordinatorOutput["results"], spawnBudget?: SpawnBudget): TickResult {
  // The steward-nudge family rides in on the babysit handler's actions but is
  // metricized on its own (#212), so split it out of the babysit umbrella count.
  const stewardNudgeCount = countAction(r.babysit, "steward-nudge");
  const stewardStrandedCount = countAction(r.babysit, "steward-stranded");
  // Tally after all handlers ran so stages/PR snapshots reflect this tick (#220).
  // Pass the live merge policy so the all-clear set splits into auto-mergeable
  // (readyToMerge) vs blocked-on-a-human-gate (waitingOnApproval).
  const { byStage, readyToMerge, waitingOnApproval, escalatedByReason } = summarizeSlicesByStage(
    state.slices,
    state.mergePolicy,
  );
  // The TRUE dispatch-ready count: the record-paced set the dispatcher actually
  // launches (`dispatchableReady`), distinct from the node-level `queue.dispatchable`
  // frontier metric which over-counts (escalated/blocked-shadow nodes). Computed
  // post-handlers, so it reflects work STILL ready after this tick's dispatch —
  // the precise "ready but not flowing" signal the dispatch alarms key on.
  const dispatchableReadyCount = state.smithy.ok
    ? dispatchableReady(state.raw, state.smithy.ready).length
    : 0;
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
    dispatchableReadyCount,
    escalatedByReason,
    cleanupCount: r.cleanup.actions.length,
    cleanupFailureCount: r.cleanup.failures.length,
    ghostCleanupCount: countAction(r.ghost, "ghost-cleanup"),
    ghostCleanupFailureCount: countAction(r.ghost, "ghost-cleanup-failed"),
    relaunchCount: countAction(r.relaunch, "relaunch-steward"),
    relaunchFailureCount: countAction(r.relaunch, "relaunch-failed"),
    babysitActionCount: r.babysit.actions.length - stewardNudgeCount - stewardStrandedCount,
    stewardNudgeCount,
    stewardStrandedCount,
    processorRequestCount: r.cleanup.requests.length + r.babysit.requests.length + r.dispatch.requests.length,
    dispatchActionCount: r.dispatch.actions.length,
    dispatchFailureCount: r.dispatch.failures.length,
    ...(spawnBudget
      ? { spawnCap: spawnBudget.cap, spawnsLive: spawnBudget.live, spawnsDeferred: spawnBudget.deferred }
      : {}),
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
    cleanup: await cleanup.apply(cleanup.assess(state), ctx, state),
    ghost: await ghostCleanup.apply(ghostCleanup.assess(state), ctx, state),
    // Restart errored worker sessions (e.g. post-reboot) in place BEFORE relaunch
    // (which only fires on a vanished session) and babysit (which would escalate
    // a present-but-errored worker) — apply mutates the snapshot so they see the
    // recovered sessions as live this same tick.
    castraRecover: await castraRecover.apply(castraRecover.assess(state), ctx, state),
    relaunch: await relaunch.apply(relaunch.assess(state), ctx, state, deps.relaunch),
    babysit: await babysit.apply(babysit.assess(state), ctx, state, deps.babysit),
    // Operator recovery (#238) runs BEFORE dispatch so the dropped slice frees the
    // still-ready smithy item for a fresh re-dispatch on this same tick.
    recovery: await recovery.apply(recovery.assess(state), ctx, state),
    // #173: adopt-from-fold runs BEFORE dispatch so an escalated slice whose branch
    // Herald observed an open PR on is transitioned to pr-open here, and dispatch's
    // recoverableEscalations no longer re-dispatches it (no collision needed).
    adoptFromFold: await adoptFromFold.apply(adoptFromFold.assess(state), ctx, state),
    dispatch: await dispatch.apply(dispatch.assess(state), ctx, state, deps.dispatch),
  };

  return { state, tick: buildTickResult(state, results, deps.spawnBudget), results };
}
