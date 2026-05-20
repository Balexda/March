import type { HandlerContext, HandlerResult, LoopState, TickResult } from "./state/types.js";
import * as cleanup from "./handlers/cleanup.js";
import * as ghostCleanup from "./handlers/ghost-cleanup.js";
import * as relaunch from "./handlers/relaunch.js";
import * as babysit from "./handlers/babysit.js";
import * as dispatch from "./handlers/dispatch.js";

/**
 * Stage 2 orchestration. runTick senses once, then runs the handlers in the
 * fixed order cleanup → ghost-cleanup → relaunch → babysit → dispatch, each as
 * pure assess() + effecting apply(), threading the SAME mutating {@link LoopState}
 * through all of them. Because apply() mutates the snapshot in place (drops a
 * cleaned session, archives a slice), a later handler's assess() sees the current
 * world without re-polling — this replaces the monolith's habit of re-listing
 * Castra sessions between handlers.
 */

export interface CoordinatorDeps {
  /** Stage 1 — gather the snapshot (bound to its SenseDeps). */
  sense: () => LoopState;
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
    dispatch: HandlerResult;
  };
}

const countAction = (res: HandlerResult, action: string): number => res.actions.filter((a) => a?.action === action).length;

function buildTickResult(state: LoopState, r: CoordinatorOutput["results"]): TickResult {
  return {
    ts: state.ts,
    statePresent: state.statePresent,
    stateError: state.stateError,
    sliceCount: Object.keys(state.slices).length,
    archivedSliceCount: Object.keys(state.archived).length,
    workers: state.workers,
    queue: state.smithy.queue,
    cleanupCount: r.cleanup.actions.length,
    cleanupFailureCount: r.cleanup.failures.length,
    ghostCleanupCount: countAction(r.ghost, "ghost-cleanup"),
    relaunchCount: countAction(r.relaunch, "relaunch-steward"),
    babysitActionCount: r.babysit.actions.length,
    processorRequestCount: r.babysit.requests.length + r.dispatch.requests.length,
    dispatchActionCount: r.dispatch.actions.length,
    dispatchFailureCount: r.dispatch.failures.length,
  };
}

export function runTick(deps: CoordinatorDeps): CoordinatorOutput {
  const state = deps.sense();
  const ctx = deps.makeContext(state);

  const results = {
    cleanup: cleanup.apply(cleanup.assess(state), ctx, state),
    ghost: ghostCleanup.apply(ghostCleanup.assess(state), ctx, state),
    relaunch: relaunch.apply(relaunch.assess(state), ctx, state, deps.relaunch),
    babysit: babysit.apply(babysit.assess(state), ctx, state, deps.babysit),
    dispatch: dispatch.apply(dispatch.assess(state), ctx, state, deps.dispatch),
  };

  return { state, tick: buildTickResult(state, results), results };
}
