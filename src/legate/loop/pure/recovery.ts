/**
 * Pure recovery helpers extracted from the dispatch/recovery machinery in
 * runtime.ts (#144). These are the side-effect-free pieces: error-text parsers
 * that classify a Hatchery spawn failure, and the per-slice retry-budget
 * bookkeeping shared by every transient-failure auto-release. Keeping them here
 * (typed + unit-tested) lets runtime.ts stay thin wiring over a tested base.
 *
 * The runtime's recovery flow stays in runtime.ts because it also mutates the
 * working state and appends Herald transition events; these helpers carry only
 * the decisions (parse / budget), not the effects.
 */

/**
 * agent-deck reports a colliding steward session as
 * `session already exists: <title> (<sessionId>)`. Extract the trailing session
 * id so the loop can reclaim the ghost (via Castra) and re-dispatch. Returns
 * null when the error is not a session collision.
 */
export function parseSessionCollisionError(text: unknown): string | null {
  const s = String(text ?? "");
  if (!/session already exists/i.test(s)) return null;
  const m = s.match(/\(([0-9a-fA-F]+-[0-9]+)\)\s*$/) || s.match(/\(([^()]+)\)\s*$/);
  return m ? m[1].trim() : null;
}

/**
 * Match the launchAgentDeckManager wrong-worktree refusal — the upstream n→n-1
 * agent-deck launch race where pickLaunchedSession attaches to the wrong sibling
 * session. The error text is the contract; if it changes in spawn-handoff.ts,
 * update this regex in lockstep.
 */
export function parseWrongWorktreeRaceError(text: unknown): boolean {
  const s = String(text ?? "");
  return /agent-deck manager session "[^"]+" attached to worktree "[^"]+" but this launch requested branch/.test(s);
}

/**
 * Codex spawn-error detection: `git apply --index` rejecting the patch codex
 * produced — usually a truncated diff (`corrupt patch at ...:N`) or a patch that
 * re-creates an existing file (`already exists in index`). Re-running codex with
 * the same prompt typically yields a different (often applicable) output, so
 * callers retry these.
 */
export function parseSpawnPatchError(text: unknown): boolean {
  const s = String(text ?? "");
  if (/git apply --index failed/.test(s)) return true;
  if (/corrupt patch at /.test(s)) return true;
  if (/already exists in index/.test(s)) return true;
  return false;
}

/** Mutable per-key attempt counters threaded on the working state. */
export type RetryCounts = Record<string, number>;

/**
 * Ensure `state.transient_retry_counts` exists and return it. The transient
 * counters (wrong-worktree race, spawn-error, hatchery-stale, …) live on the
 * in-memory working state, keyed per slice / failure mode.
 */
export function transientRetryCounts(state: { transient_retry_counts?: unknown }): RetryCounts {
  if (!state.transient_retry_counts || typeof state.transient_retry_counts !== "object") {
    state.transient_retry_counts = {};
  }
  return state.transient_retry_counts as RetryCounts;
}

/** Outcome of charging one attempt against a retry budget. */
export interface RetryOutcome {
  /** True once the attempt count exceeds `limit` — the budget is spent. */
  readonly exhausted: boolean;
  /** The attempt number this call represents (1-based). */
  readonly count: number;
}

/**
 * Charge one attempt against a per-key retry budget. Returns the new (1-based)
 * attempt number and whether the budget is now exhausted. On exhaustion the key
 * is cleared so a later, unrelated failure starts fresh; otherwise the new count
 * is persisted on `counts`. Pure aside from mutating the passed-in `counts`.
 */
export function bumpRetry(counts: RetryCounts, key: string, limit: number): RetryOutcome {
  const prev = Number.isFinite(counts[key]) ? counts[key] : 0;
  const count = prev + 1;
  if (count > limit) {
    delete counts[key];
    return { exhausted: true, count };
  }
  counts[key] = count;
  return { exhausted: false, count };
}
