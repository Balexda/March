import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { sessionMatchesSlice } from "../pure/session.js";
import { archiveSlice, dropSession, dropSlice } from "../state/mutations.js";

/**
 * Terminal-PR cleanup. A slice whose PR has MERGED/CLOSED is done — request
 * Brood teardown (Brood owns removing the steward/worktree/branch; the loop no
 * longer prunes), then archive the slice. assess() is pure over the sensed
 * snapshot; apply() does the teardown + archive.
 */

export interface CleanupDecision {
  readonly sliceId: string;
  readonly sessionId: string;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly terminalState: "MERGED" | "CLOSED";
}

/** Pure: which active slices have a terminal PR and should be torn down. */
export function assess(state: LoopState): CleanupDecision[] {
  const out: CleanupDecision[] = [];
  if (!state.statePresent) return out;
  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    if (!state.sessions.some((s) => sessionMatchesSlice(s, slice))) continue;
    const pr = state.perSlice[sliceId]?.pr;
    if (!pr || pr.skipped) continue;
    const terminalState = pr.state;
    if (terminalState !== "MERGED" && terminalState !== "CLOSED") continue;
    out.push({
      sliceId,
      sessionId,
      prNumber: pr.number ?? slice?.pr?.number ?? null,
      prUrl: pr.url ?? slice?.pr?.url ?? null,
      terminalState,
    });
  }
  return out;
}

export async function apply(decisions: CleanupDecision[], ctx: HandlerContext, state: LoopState): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  for (const d of decisions) {
    const slice = state.slices[d.sliceId];
    if (!slice) continue;
    const teardown = await ctx.broodTeardown(d.sessionId, {
      reason: `pr-${d.terminalState.toLowerCase()}`,
    });
    if (!teardown.ok) {
      // Brood couldn't confirm teardown (incl. 404 not-tracked) — DEFER. Never
      // archive over an orphaned steward/worktree (the #155 hazard).
      slice.last_action = ctx.ts;
      slice.last_action_note = `cleanup deferred: ${teardown.detail}`;
      res.mutated = true;
      const failure = {
        slice_id: d.sliceId,
        session_id: d.sessionId,
        pr_number: d.prNumber,
        pr_state: d.terminalState,
        error: teardown.detail || "brood teardown did not confirm",
      };
      res.failures.push(failure);
      continue;
    }
    archiveSlice(state.raw, d.sliceId, slice, { number: d.prNumber, url: d.prUrl }, d.terminalState, ctx.ts);
    dropSlice(state, d.sliceId);
    dropSession(state, d.sessionId);
    ctx.emitTransition?.({ type: "slice.archived", sliceId: d.sliceId });
    res.mutated = true;
    const cleanup = {
      schema_version: 1,
      ts: ctx.ts,
      processor: ctx.meta.processor_name,
      paired_legate: ctx.meta.paired_legate,
      kind: "cleanup",
      slice_id: d.sliceId,
      session_id: d.sessionId,
      pr_number: d.prNumber,
      pr_url: d.prUrl,
      pr_state: d.terminalState,
      removed: true,
    };
    res.actions.push(cleanup);
  }
  return res;
}
