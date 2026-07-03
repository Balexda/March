/**
 * Self-heal PACER — the shared per-slice retry-state tracker (#506).
 *
 * {@link ./self-heal.ts} owns the *math* (exponential backoff, per-slice jitter,
 * the AIMD rate step). This module owns the *state*: the durable per-slice attempt
 * counter and the warm per-slice backoff-window map that every self-heal domain
 * keeps IDENTICALLY, differing only in which two fields on `raw` it writes.
 *
 * Three domains hand-rolled this exact bookkeeping before it was extracted — the
 * steward relaunch path (`handlers/relaunch.ts`, `relaunch_backoff_until` +
 * `relaunch-steward:<slice>`), the spawn re-dispatch path (`pure/slice.ts`,
 * `dispatch_recovery_backoff_until` + `dispatch-recovery:<slice>`), and the CI-fix
 * path (`steps/ci-fix.ts`, `ci_recovery_backoff_until` + `ci-recovery:<slice>`).
 * Each re-implemented the same read guards, the same
 * `now + backoffMs(attempt, slice)` schedule, and the same
 * ensure-the-map-exists dance. Reading all three together is what drew the
 * abstraction boundary here: the STATE representation + scheduling is common; the
 * POLICY (AIMD, an operator ladder, a per-head-SHA guard, a notify threshold) is
 * NOT — it stays in each caller. The pacer deliberately holds none of it.
 *
 * A {@link RetryDomain} names one domain's two `raw` locations. The durable count
 * lives in `transient_retry_counts` (folded via `retry.counted`, so it survives a
 * restart — callers still emit that event; the pacer only mutates the map). The
 * next-eligible timestamps live in the warm `backoffField` map (NOT folded — it
 * resets to empty on a cold start, which is the intended "re-probe promptly after
 * a restart" behavior).
 */
import { backoffMs } from "./self-heal.js";

/** Locates one self-heal domain's durable counter key + warm backoff map on `raw`. */
export interface RetryDomain {
  /** Maps a slice id to its `transient_retry_counts` key, e.g.
   *  `sliceId => "ci-recovery:" + sliceId`. */
  readonly retryKey: (sliceId: string) => string;
  /** The `raw` field holding this domain's warm `{ sliceId: epochMs }` backoff map,
   *  e.g. `"ci_recovery_backoff_until"`. */
  readonly backoffField: string;
}

// ---- durable attempt counter (folded via retry.counted) -------------------

/** Pure read of a slice's attempt counter for this domain (0 when never tried). */
export function retryAttempts(raw: any, domain: RetryDomain, sliceId: string): number {
  const c = raw?.transient_retry_counts;
  const v = c && typeof c === "object" ? c[domain.retryKey(sliceId)] : undefined;
  return Number.isFinite(v) ? v : 0;
}

/** Set a slice's attempt counter. Does NOT emit `retry.counted` — the caller owns
 *  the transition emit (the pacer is pure state, unaware of the event bus). */
export function setRetryAttempts(raw: any, domain: RetryDomain, sliceId: string, count: number): void {
  if (!raw.transient_retry_counts || typeof raw.transient_retry_counts !== "object") {
    raw.transient_retry_counts = {};
  }
  raw.transient_retry_counts[domain.retryKey(sliceId)] = count;
}

// ---- warm backoff window --------------------------------------------------

/** Pure read of a slice's next eligibility (epoch ms; 0 = unset / eligible now). */
export function backoffUntil(raw: any, domain: RetryDomain, sliceId: string): number {
  const b = raw?.[domain.backoffField];
  return b && typeof b === "object" && Number.isFinite(b[sliceId]) ? b[sliceId] : 0;
}

/** Schedule the next backoff window: `nowMs + backoffMs(attempt, sliceId)`. No-op
 *  when `nowMs` is not finite (a non-date tick ts → backoff can't gate, so don't
 *  record one). Ensures the warm map exists. `attempt` is the 1-based failure
 *  count so the delay doubles per attempt. */
export function scheduleBackoff(raw: any, domain: RetryDomain, sliceId: string, attempt: number, nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  if (!raw[domain.backoffField] || typeof raw[domain.backoffField] !== "object") {
    raw[domain.backoffField] = {};
  }
  raw[domain.backoffField][sliceId] = nowMs + backoffMs(Math.max(attempt, 1), sliceId);
}

/** Drop a slice's warm backoff window (it transitioned cleanly, so a future
 *  re-failure re-probes promptly with a short first wait). */
export function clearBackoff(raw: any, domain: RetryDomain, sliceId: string): void {
  const b = raw?.[domain.backoffField];
  if (b && typeof b === "object") delete b[sliceId];
}

// ---- convenience predicate ------------------------------------------------

/** True when a prior attempt exists AND `nowMs` is before the window ⇒ HOLD this
 *  tick (still cooling down). The common eligibility gate for a backoff-paced
 *  re-dispatch; a domain with extra policy (a ladder, AIMD) composes the reads
 *  above instead. */
export function coolingDown(raw: any, domain: RetryDomain, sliceId: string, nowMs: number): boolean {
  return retryAttempts(raw, domain, sliceId) > 0 && Number.isFinite(nowMs) && nowMs < backoffUntil(raw, domain, sliceId);
}
