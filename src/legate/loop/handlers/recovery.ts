import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { dropRecoveredSlice } from "../state/mutations.js";

/**
 * Operator recovery (#238): honor `slice.recovery.requested` events drained from
 * the Herald inbox this tick. Once a slice escalates with its bounded-recovery
 * budget (#211) exhausted, the loop has NO internal re-dispatch path — the
 * escalated slice stays load-bearing and dedups the still-ready smithy work
 * forever. An operator un-wedges it with `march legate recover <sliceId>` (or the
 * `legate.unwedge` skill), which appends a `slice.recovery.requested` event.
 *
 * This handler reconciles the loop's IN-MEMORY working state for each request:
 * it drops the slice from both the live and archived sets and clears its retry
 * budget. Acting here — during the tick the request is drained — is what defeats
 * warm-loop invisibility: the request's reducer tombstones the slice in the
 * durable fold, but the warm loop's `raw` is threaded in memory and only rebuilt
 * from the fold on a cold start, so a fold edit alone never reaches the running
 * loop (gap #3 in #238). With the slice dropped, the dispatcher's
 * `dispatchableReady` re-selects the still-ready item and re-launches it FRESH on
 * this same tick (the dispatch handler runs after this one).
 *
 * Pure `assess` + effecting `apply`, deps-free like cleanup/ghost-cleanup — the
 * only effect is the in-memory drop. The action records it returns are appended to
 * the action log by {@link runHeartbeat} in pipeline order alongside every other
 * handler's actions (this handler does NOT write the log directly, so per-tick
 * action ordering stays consistent). No transition event is emitted: the
 * `slice.recovery.requested` is already in the durable log (operator-appended) and
 * the ensuing fresh `slice.dispatched` is the durable record of the re-dispatch.
 */

export interface RecoveryDecision {
  readonly sliceId: string;
}

/**
 * Pure: one decision per DISTINCT recovery request drained this tick. De-duped so
 * an operator appending several `slice.recovery.requested` for the same slice
 * before the next tick produces a single recovery action (the drop is idempotent,
 * but a duplicate action would misreport the work done).
 */
export function assess(state: LoopState): RecoveryDecision[] {
  const seen = new Set<string>();
  const out: RecoveryDecision[] = [];
  for (const sliceId of state.recoveryRequests ?? []) {
    if (seen.has(sliceId)) continue;
    seen.add(sliceId);
    out.push({ sliceId });
  }
  return out;
}

export async function apply(decisions: RecoveryDecision[], _ctx: HandlerContext, state: LoopState): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!state.raw) return res;
  for (const { sliceId } of decisions) {
    // "cleared" reflects whether a slice was actually tracked, computed from the
    // drop itself (not a pre-apply snapshot) so the report can't claim a slice was
    // cleared when nothing was there.
    const cleared = dropRecoveredSlice(state.raw, sliceId);
    res.mutated = true;
    const detail = cleared
      ? "operator recovery: cleared escalated slice for fresh re-dispatch"
      : "operator recovery: no tracked slice to clear (already recovered or unknown) — re-dispatch will proceed if still ready";
    res.actions.push({ action: "slice-recovery", sliceId, detail });
  }
  return res;
}
