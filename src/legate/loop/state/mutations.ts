import type { LoopState } from "./types.js";

/**
 * In-memory + state.json mutations shared by Stage-2 handlers' apply(). Mutating
 * the LoopState snapshot (not re-polling) is what lets later handlers see the
 * effects of earlier ones within a tick.
 */

/** Move a slice into archived_slices and drop it from the live set. Mutates `raw`. */
export function archiveSlice(
  raw: any,
  sliceId: string,
  slice: any,
  pr: any,
  terminalState: string,
  ts: string,
): void {
  const archived =
    raw.archived_slices && typeof raw.archived_slices === "object" ? raw.archived_slices : {};
  raw.archived_slices = archived;
  const archivedSlice: any = {
    pr_number: pr?.number ?? slice?.pr?.number ?? null,
    pr_url: pr?.url ?? slice?.pr?.url ?? null,
    worker_title: slice.worker_title ?? null,
    branch: slice.branch ?? null,
    actual_branch: slice.actual_branch ?? null,
    command: slice.command ?? null,
    arguments: Array.isArray(slice.arguments) ? slice.arguments.map((a: unknown) => String(a)) : [],
    artifact_path: slice.artifact_path ?? null,
    terminal_state: terminalState,
  };
  if (terminalState === "MERGED") archivedSlice.merged_at = ts;
  if (terminalState === "CLOSED") archivedSlice.closed_at = ts;
  archived[sliceId] = archivedSlice;
  delete raw.slices[sliceId];
}

/** Drop a slice from the live snapshot (raw.slices + state.slices). */
export function dropSlice(state: LoopState, sliceId: string): void {
  if (state.raw?.slices) delete state.raw.slices[sliceId];
  delete state.slices[sliceId];
}

/** Drop a session from the in-memory snapshot after teardown so later handlers
 *  don't act on it. */
export function dropSession(state: LoopState, sessionId: string): void {
  state.sessions = state.sessions.filter((s) => String(s?.id || "") !== sessionId);
  state.sessionsById.delete(sessionId);
}
