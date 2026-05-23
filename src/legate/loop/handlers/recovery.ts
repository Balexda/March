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
 * warm-loop invisibility: the request's reducer drops the slice from the durable
 * fold, but the warm loop's `raw` is threaded in memory and only rebuilt from the
 * fold on a cold start, so a fold edit alone never reaches the running loop (gap
 * #3 in #238). With the slice dropped, the dispatcher's `dispatchableReady`
 * re-selects the still-ready item and re-launches it FRESH on this same tick (the
 * dispatch handler runs after this one).
 *
 * Pure `assess` + effecting `apply`, deps-free like cleanup/ghost-cleanup — the
 * only effects are the in-memory drop and an action-log record for observability.
 * No transition event is emitted: the `slice.recovery.requested` is already in the
 * durable log (operator-appended) and the ensuing fresh `slice.dispatched` is the
 * durable record of the re-dispatch.
 */

export interface RecoveryDecision {
  readonly sliceId: string;
  /** Whether the slice was actually tracked in `raw` (false = already gone/unknown). */
  readonly present: boolean;
}

/** Pure: one decision per recovery request drained this tick. */
export function assess(state: LoopState): RecoveryDecision[] {
  const requests = state.recoveryRequests ?? [];
  const slices = state.raw?.slices && typeof state.raw.slices === "object" ? state.raw.slices : {};
  const archived =
    state.raw?.archived_slices && typeof state.raw.archived_slices === "object" ? state.raw.archived_slices : {};
  return requests.map((sliceId) => ({
    sliceId,
    present:
      Object.prototype.hasOwnProperty.call(slices, sliceId) ||
      Object.prototype.hasOwnProperty.call(archived, sliceId),
  }));
}

export async function apply(decisions: RecoveryDecision[], ctx: HandlerContext, state: LoopState): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!state.raw) return res;
  for (const d of decisions) {
    dropRecoveredSlice(state.raw, d.sliceId);
    res.mutated = true;
    const detail = d.present
      ? "operator recovery: cleared escalated slice for fresh re-dispatch"
      : "operator recovery: no tracked slice to clear (already recovered or unknown) — re-dispatch will proceed if still ready";
    res.actions.push({ action: "slice-recovery", sliceId: d.sliceId, detail });
    ctx.emit({
      schema_version: 1,
      ts: ctx.ts,
      processor: ctx.meta.processor_name,
      paired_legate: ctx.meta.paired_legate,
      kind: "slice_recovery",
      action: "slice-recovery",
      slice_id: d.sliceId,
      detail,
    });
    ctx.log("[" + ctx.ts + "] " + detail + " (" + d.sliceId + ")");
  }
  return res;
}
