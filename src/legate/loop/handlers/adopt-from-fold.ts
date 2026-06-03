import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";

/**
 * #173 adopt-from-fold: the tick-level fold reader for branch-collision adoption.
 *
 * Herald observes an open PR on every tracked branch — including an ESCALATED slice
 * whose original steward died but whose branch still has a live PR (the orphaned /
 * diverged adopt case) — and emits `slice.pr.changed`, which lands in the fold (and
 * in this tick's `perSlice` observation). The legate must then ADOPT: transition the
 * escalated slice to `pr-open` so babysit drives it to merge.
 *
 * The only OTHER adopt site ({@link ./dispatch-ops.ts adoptOpenPrOnCollision}) fires
 * from inside dispatch error handlers, which never run for an already-escalated
 * slice unless a fresh dispatch is attempted — and `march legate recover` tombstones
 * the slice (`recovered:true`) before the dispatch carry-forward can read its PR. So
 * the dispatch-time adopt can't cover the steady state; this handler does. Both
 * converge on the same `slice.stage.changed → "pr-open"` event + babysit downstream;
 * keep both (this one for the steady state, the dispatch-time one as belt-and-
 * suspenders for the dispatch-races-observation race).
 *
 * Stateless + idempotent: every tick rescans the projection; once a slice is
 * `pr-open` it no longer matches. Constant work per non-archived slice, no I/O —
 * pure `assess` + a transition-emitting `apply`, deps-free like recovery.
 */

export interface AdoptFromFoldDecision {
  readonly sliceId: string;
  /** The observed open-PR snapshot to adopt (babysit-shaped: number/state/…). */
  readonly pr: any;
}

/**
 * Pure: select every non-archived, non-recovered slice that is `escalated` with an
 * observed OPEN PR. The PR comes from this tick's Herald observation (`perSlice`,
 * fresh on a warm loop where the working `slice.pr` is NOT re-folded) and falls back
 * to the slice's folded `pr` (populated on a cold-start rebuild). So adoption fires
 * whether the loop is warm or freshly restarted.
 */
export function assess(state: LoopState): AdoptFromFoldDecision[] {
  const out: AdoptFromFoldDecision[] = [];
  const slices = state.slices && typeof state.slices === "object" ? state.slices : {};
  for (const [sliceId, slice] of Object.entries(slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    if (slice.archived || slice.recovered) continue;
    if (slice.stage !== "escalated") continue;
    const pr = state.perSlice?.[sliceId]?.pr ?? slice.pr;
    if (!pr || typeof pr !== "object") continue;
    if (String(pr.state).toUpperCase() !== "OPEN") continue;
    const number = pr.number;
    if (typeof number !== "number" || !(number > 0)) continue;
    out.push({ sliceId, pr });
  }
  return out;
}

/**
 * Effecting: transition each selected slice to `pr-open` in the in-memory working
 * state and emit the durable `slice.stage.changed` (#255). No `slice.pr.changed`
 * re-emit — Herald owns that event class and the fold already carries the PR.
 */
export async function apply(
  decisions: AdoptFromFoldDecision[],
  ctx: HandlerContext,
  state: LoopState,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  const ts = ctx.ts;
  for (const { sliceId, pr } of decisions) {
    const slice = state.slices?.[sliceId];
    // Re-check under the live snapshot — idempotent, and defensive against an
    // earlier handler having moved the slice this tick.
    if (!slice || typeof slice !== "object" || slice.stage !== "escalated") continue;
    slice.stage = "pr-open";
    // Reconcile the working state with the observed PR (it may have come from
    // perSlice on a warm loop, where slice.pr was not refreshed) so babysit and a
    // later cold-start rebuild see a consistent slice.
    slice.pr = pr;
    slice.escalated_reason = undefined;
    slice.last_action = ts;
    slice.last_action_note = "Adopted PR #" + pr.number + " from Herald observation on escalated branch (#173)";
    const sessionId = slice.worker_session_id || undefined;
    ctx.emitTransition?.({
      type: "slice.stage.changed",
      sliceId,
      stage: "pr-open",
      ...(sessionId ? { sessionId } : {}),
    });
    ctx.log("[" + ts + "] adopt-from-fold " + sliceId + ": adopted PR #" + pr.number);
    res.actions.push({
      action: "adopt-from-fold",
      sliceId,
      sessionId: slice.worker_session_id || null,
      detail: "adopted observed open PR #" + pr.number + " (escalated branch)",
    });
    res.mutated = true;
  }
  return res;
}
