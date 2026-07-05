/**
 * Step library — the CI-fix action (#506).
 *
 * "Fix a failing CI" as a discrete, named step: the leaf action the babysit
 * *process* coordinates when a slice's PR is red. Babysit decides WHEN (a PR is
 * OPEN and `checks === "FAIL"`); this module owns the CI-fix action's self-heal
 * POLICY and accounting — how many attempts, how long to back off, when to notify
 * — layered on the shared {@link ../pure/self-heal-pacer.ts pacer} that the
 * relaunch and dispatch-recovery domains use too. Factoring it here keeps babysit
 * a thin coordinator (one `decideCiFix` call in assess, one `recordCiFixAttempt`
 * in apply) and makes the policy testable in isolation — and reusable by a future
 * process (a legate that attaches to human-opened PRs) that shares the step.
 *
 * SELF-HEAL SHAPE. Like a merge conflict, a CI failure is never "done": a green PR
 * goes red the instant `main` moves under it (a stale-base breakage) and back when
 * the base is fixed. So the fix is re-dispatched INDEFINITELY, paced by the shared
 * exponential backoff + per-slice jitter — the first fix goes out immediately, each
 * still-failing re-try waits ever-longer (2min → … → 6h plateau). A genuinely
 * broken PR diff may never self-heal on its own, so the operator is notified ONCE
 * at {@link CI_NOTIFY_ATTEMPT} (visible, not a give-up); the loop keeps probing.
 *
 * KEYED PER FAILING HEAD SHA. CI re-runs of the SAME commit (a manual re-run, a
 * flake retry, the staged l0/l1/l2/l3 jobs reporting FAIL at different ticks) must
 * not burn attempts, so a re-dispatch for the already-attempted SHA re-pokes the
 * (likely parked) steward without advancing the count; a genuinely new failing
 * commit the steward pushed IS a fresh attempt. The SHA the counter reflects rides
 * on the slice as `ci_recovery_head_sha`.
 */
import type { StepContract } from "./contract.js";
import {
  clearBackoff,
  retryAttempts,
  scheduleBackoff,
  setRetryAttempts,
  whenDue,
  type RetryDomain,
} from "../pure/self-heal-pacer.js";

/** The CI-fix step's contract: sends a prompt + advances stage + re-arms the warm
 *  backoff — it preserves the PR / branch / worktree, so it is safe to run
 *  automatically with backoff (never destructive). */
export const ciFixStep: StepContract = { name: "ci-fix", destructive: false };

/** This action's ({@link RetryDomain}) — its durable retry-counter key + warm
 *  backoff-window field, the same shape relaunch and dispatch-recovery use. */
export const CI_RECOVERY_DOMAIN: RetryDomain = {
  retryKey: (sliceId) => "ci-recovery:" + sliceId,
  backoffField: "ci_recovery_backoff_until",
};

/** After how many genuinely-new failing attempts the operator is pinged ONCE. */
export const CI_NOTIFY_ATTEMPT = 3;

/** The CI-fix action's decision for one slice/PR this tick, or `null` to HOLD
 *  (either cooling down inside the backoff window, or nothing to do). */
export interface CiFixPlan {
  /** This attempt's 1-based count (== the durable counter after {@link recordCiFixAttempt}). */
  readonly attempt: number;
  /** True on the one genuinely-new attempt that crosses {@link CI_NOTIFY_ATTEMPT}. */
  readonly notify: boolean;
}

/**
 * Pure: should the babysit process dispatch a CI-fix for this failing PR this tick,
 * and if so at what attempt? Returns `null` to hold — a prior attempt exists and
 * we're still inside its backoff window (this also absorbs CI re-runs, which land
 * during the window). Otherwise returns the attempt to make:
 *  - SAME failing head SHA as the last attempt → re-poke without burning an attempt
 *    (`attempt` stays put, `notify` false);
 *  - a NEW failing commit (or the first failure) → a fresh attempt (`prev + 1`),
 *    with `notify` set on the single attempt that first reaches the threshold.
 *
 * `nowMs` is the tick epoch-ms; pass NaN to disable the backoff gate (a non-date
 * tick → always eligible, for unit tests).
 */
export function decideCiFix(raw: any, sliceId: string, slice: any, pr: any, nowMs: number): CiFixPlan | null {
  // The pacer owns the "it's time" gate (hold inside the window — which also
  // absorbs CI re-runs); this callback is only the CI-specific counting policy.
  const plan = whenDue(raw, CI_RECOVERY_DOMAIN, sliceId, nowMs, (next): CiFixPlan => {
    const headSha = String(pr?.head_sha || "");
    const sameSha = headSha !== "" && headSha === String(slice?.ci_recovery_head_sha || "");
    const attempt = sameSha ? Math.max(next - 1, 1) : next;
    // Notify once at the threshold — but only on a genuinely new attempt (a distinct
    // failing commit), never on a same-SHA re-poke.
    return { attempt, notify: !sameSha && attempt === CI_NOTIFY_ATTEMPT };
  });
  return plan ?? null;
}

/**
 * Record a dispatched CI-fix attempt against the shared pacer: set the durable
 * counter, schedule the next exponential-backoff window, and stamp the failing head
 * SHA the count now reflects (so a same-commit re-run next tick re-pokes without
 * burning a fresh attempt). Does NOT emit `retry.counted` — the caller owns the
 * transition emit (returns the count so it has the value to emit).
 */
export function recordCiFixAttempt(raw: any, sliceId: string, slice: any, headSha: any, attempt: number, nowMs: number): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? attempt : 1;
  setRetryAttempts(raw, CI_RECOVERY_DOMAIN, sliceId, n);
  scheduleBackoff(raw, CI_RECOVERY_DOMAIN, sliceId, n, nowMs);
  slice.ci_recovery_head_sha = headSha ?? null;
  return n;
}

/**
 * Reset a slice's CI self-heal budget on an all-clear (CI went green): zero the
 * durable counter, drop the warm backoff window, and forget the tracked SHA so a
 * future re-failure (a base movement broke it again) re-probes promptly. Returns
 * whether the durable counter was non-zero, so the caller emits `retry.counted(0)`
 * only when there was something to clear.
 */
export function resetCiFixRecovery(raw: any, sliceId: string, slice: any): boolean {
  const had = retryAttempts(raw, CI_RECOVERY_DOMAIN, sliceId) > 0;
  if (had) setRetryAttempts(raw, CI_RECOVERY_DOMAIN, sliceId, 0);
  clearBackoff(raw, CI_RECOVERY_DOMAIN, sliceId);
  delete slice.ci_recovery_head_sha;
  return had;
}
