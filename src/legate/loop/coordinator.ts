import type { HandlerContext, HandlerResult, LoopState, TickResult } from "./state/types.js";
import * as cleanup from "./handlers/cleanup.js";
import * as ghostCleanup from "./handlers/ghost-cleanup.js";
import * as relaunch from "./handlers/relaunch.js";
import * as babysit from "./handlers/babysit.js";
import * as recovery from "./handlers/recovery.js";
import * as adoptFromFold from "./handlers/adopt-from-fold.js";
import * as dispatch from "./handlers/dispatch.js";
import { summarizeSlicesByStage } from "./pure/slice.js";

/**
 * Stage 2 orchestration. runTick senses once, then runs the handlers in the fixed
 * order cleanup → ghost-cleanup → relaunch → babysit → recovery → adopt-from-fold →
 * dispatch,
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
}

export interface CoordinatorOutput {
  state: LoopState;
  tick: TickResult;
  results: {
    cleanup: HandlerResult;
    ghost: HandlerResult;
    relaunch: HandlerResult;
    babysit: HandlerResult;
    recovery: HandlerResult;
    adoptFromFold: HandlerResult;
    dispatch: HandlerResult;
  };
}

const countAction = (res: HandlerResult, action: string): number => res.actions.filter((a) => a?.action === action).length;

function buildTickResult(state: LoopState, r: CoordinatorOutput["results"]): TickResult {
  // The steward-nudge family rides in on the babysit handler's actions but is
  // metricized on its own (#212), so split it out of the babysit umbrella count.
  const stewardNudgeCount = countAction(r.babysit, "steward-nudge");
  const stewardStrandedCount = countAction(r.babysit, "steward-stranded");
  // Tally after all handlers ran so stages/PR snapshots reflect this tick (#220).
  const { byStage, readyToMerge } = summarizeSlicesByStage(state.slices);
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
    cleanupCount: r.cleanup.actions.length,
    cleanupFailureCount: r.cleanup.failures.length,
    ghostCleanupCount: countAction(r.ghost, "ghost-cleanup"),
    relaunchCount: countAction(r.relaunch, "relaunch-steward"),
    babysitActionCount: r.babysit.actions.length - stewardNudgeCount - stewardStrandedCount,
    stewardNudgeCount,
    stewardStrandedCount,
    processorRequestCount: r.cleanup.requests.length + r.babysit.requests.length + r.dispatch.requests.length,
    dispatchActionCount: r.dispatch.actions.length,
    dispatchFailureCount: r.dispatch.failures.length,
  };
}

export async function runTick(deps: CoordinatorDeps): Promise<CoordinatorOutput> {
  const state = await deps.sense();
  const ctx = deps.makeContext(state);

  // Awaited in order — each apply mutates the shared snapshot, so a later
  // handler's assess sees the current world. Do NOT parallelize: the ordering
  // (cleanup drops a session before babysit reads it) is load-bearing.
  const results = {
    cleanup: await cleanup.apply(cleanup.assess(state), ctx, state),
    ghost: await ghostCleanup.apply(ghostCleanup.assess(state), ctx, state),
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

  return { state, tick: buildTickResult(state, results), results };
}
