/**
 * Shared self-healing pace: exponential backoff + per-slice jitter + a global
 * AIMD rate. Two recovery domains use the IDENTICAL algorithm — the steward
 * relaunch path (`handlers/relaunch.ts`, a stranded slice WITH an open PR whose
 * worker vanished) and the spawn re-dispatch path (`pure/slice.ts` /
 * `handlers/dispatch-ops.ts`, a slice whose Hatchery spawn FAILED before any PR,
 * `hatchery_dispatch_failed`). Both replaced a hard give-up limit with this:
 * retry INDEFINITELY but ever-further apart, rate-limited so an outage can't
 * stampede, self-healing the instant the world recovers.
 *
 * The two domains keep SEPARATE state keys (their own backoff map + rate scalar)
 * so a relaunch outage doesn't throttle fresh-spawn recovery or vice versa — they
 * share the code, not the counters.
 */

/** AIMD global recovery-rate bounds. The rate R is the max backoff-eligible
 *  slices a domain attempts per tick; it adds 1 per clean rate-limited sweep and
 *  halves on any failure, floored at MIN, capped at MAX. */
export const RECOVERY_RATE_MIN = 1;
export const RECOVERY_RATE_MAX = 8;

/** Exponential-backoff schedule. delay = min(BASE · 2^(attempt-1), MAX) ·
 *  (1 + jitter), jitter ∈ [0, JITTER) derived deterministically from the slice id. */
export const BACKOFF_BASE_MS = 2 * 60 * 1000; // 2 min after the first failure
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000; // plateau at 6 h
export const BACKOFF_JITTER = 0.2; // up to +20% spread, per slice
/** Cap the doubling exponent so 2^n can't overflow (min() clamps to MAX anyway). */
const BACKOFF_MAX_EXP = 16;

/** NaN-safe epoch-ms parse of a tick timestamp. Returns NaN for non-dates (unit
 *  tests use `ts:"T"`); callers treat NaN as "backoff cannot gate" (eligible). */
export function parseMs(ts: unknown): number {
  return typeof ts === "string" ? Date.parse(ts) : NaN;
}

/** Deterministic per-slice jitter fraction in [0, 1) (FNV-1a over the id). Stable
 *  across ticks so a slice's backoff spread is reproducible (and test-friendly),
 *  yet differs between slices so a failed burst doesn't re-probe in lock-step. */
export function jitterFraction(sliceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sliceId.length; i++) {
    h ^= sliceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Exponential backoff with per-slice jitter for the Nth failure (1-based). */
export function backoffMs(attempt: number, sliceId: string): number {
  const exp = Math.min(Math.max(attempt - 1, 0), BACKOFF_MAX_EXP);
  const base = Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
  return Math.round(base * (1 + BACKOFF_JITTER * jitterFraction(sliceId)));
}

/** Read an AIMD rate scalar off `raw[field]`, clamped to [MIN, MAX]. Default MIN
 *  (a cold start / post-outage recovers ONE slice, then ramps as probes succeed). */
export function readRecoveryRate(raw: any, field: string): number {
  const r = raw?.[field];
  if (!Number.isFinite(r)) return RECOVERY_RATE_MIN;
  return Math.min(RECOVERY_RATE_MAX, Math.max(RECOVERY_RATE_MIN, Math.floor(r)));
}

/** One AIMD step from `current`: any failure HALVES (multiplicative decrease,
 *  floored at MIN); otherwise a clean but rate-limited sweep ADDS 1 (additive
 *  increase, capped at MAX); an un-limited clean sweep holds steady. Pure. */
export function stepRecoveryRate(
  current: number,
  outcome: { failures: number; rateLimited: boolean },
): number {
  if (outcome.failures > 0) return Math.max(RECOVERY_RATE_MIN, Math.floor(current / 2));
  if (outcome.rateLimited) return Math.min(RECOVERY_RATE_MAX, current + 1);
  return current;
}
