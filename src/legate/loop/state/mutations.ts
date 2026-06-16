import type { LoopState } from "./types.js";

/**
 * In-memory working-state mutations shared by Stage-2 handlers' apply(). Mutating
 * the LoopState snapshot (not re-polling) is what lets later handlers see the
 * effects of earlier ones within a tick; the durable record is the event log.
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

/**
 * Ensure `raw.transient_retry_counts` exists and return it — the #211 bounded-retry
 * budget. Shared by handlers that persist a per-key attempt/tombstone count
 * (`relaunch-steward:<sliceId>`, `ghost-cleanup:<sessionId>`) so a failing action
 * stops re-firing every tick instead of churning forever.
 */
export function ensureRetryCounts(raw: any): Record<string, number> {
  if (!raw.transient_retry_counts || typeof raw.transient_retry_counts !== "object") {
    raw.transient_retry_counts = {};
  }
  return raw.transient_retry_counts;
}

/** Drop a session from the in-memory snapshot after teardown so later handlers
 *  don't act on it. */
export function dropSession(state: LoopState, sessionId: string): void {
  state.sessions = state.sessions.filter((s) => String(s?.id || "") !== sessionId);
  state.sessionsById.delete(sessionId);
}

/**
 * Operator-recovery reconciliation of the in-memory working state (#238). Drops
 * the slice from BOTH the live set and the archived set and clears its transient
 * retry counters (the bounded-recovery budget, #211), so the still-ready smithy
 * item is no longer deduped by an escalated/archived incarnation and the
 * dispatcher re-launches it FRESH this tick (`dispatchableReady` re-selects it).
 * Mutates `raw`. Returns true if anything was actually dropped (for logging).
 *
 * This mirrors what the `slice.recovery.requested` reducer does to the durable
 * fold; doing it here too is required because the loop's `raw` is threaded in
 * memory across ticks and is rebuilt from the fold only on a cold start
 * (warm-loop invisibility — gap #3 in #238).
 */
export function dropRecoveredSlice(raw: any, sliceId: string): boolean {
  let dropped = false;
  if (raw?.slices && typeof raw.slices === "object" && Object.prototype.hasOwnProperty.call(raw.slices, sliceId)) {
    delete raw.slices[sliceId];
    dropped = true;
  }
  if (
    raw?.archived_slices &&
    typeof raw.archived_slices === "object" &&
    Object.prototype.hasOwnProperty.call(raw.archived_slices, sliceId)
  ) {
    delete raw.archived_slices[sliceId];
    dropped = true;
  }
  const counts = raw?.transient_retry_counts;
  if (counts && typeof counts === "object") {
    for (const key of Object.keys(counts)) {
      if (key === sliceId || key.endsWith(":" + sliceId)) delete counts[key];
    }
  }
  return dropped;
}
