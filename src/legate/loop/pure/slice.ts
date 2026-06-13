import { dispatchBranch, dispatchItemKey, dispatchSliceId, sliceActionKey } from "./dispatch-id.js";

/**
 * Pure slice/archive reasoning: terminal detection and the dedup/recovery
 * matchers that decide whether a smithy item is already in flight, already
 * archived, or colliding with a prior MERGED archive. No I/O — all derived from
 * the passed `state` (the in-memory working state) + smithy `item`.
 */

export function isTerminalSlice(slice: any): boolean {
  if (!slice || typeof slice !== "object") return true;
  if (slice.stage === "merged" || slice.stage === "escalated") return true;
  if (slice.pr?.state === "MERGED" || slice.pr?.state === "CLOSED") return true;
  return false;
}

/**
 * Dedup helper for new-dispatch suppression. Stricter than isTerminalSlice: only
 * a MERGED slice means the artifact is "done" and a fresh dispatch is safe.
 * Escalated / closed-unmerged slices stay load-bearing (unresolved blockers).
 */
export function sliceReleasesArtifact(slice: any): boolean {
  if (!slice || typeof slice !== "object") return false;
  if (slice.stage === "merged") return true;
  if (slice.pr?.state === "MERGED") return true;
  return false;
}

export function archivedSlices(state: any): Record<string, any> {
  return state?.archived_slices && typeof state.archived_slices === "object"
    ? state.archived_slices
    : {};
}

/**
 * A stub archive entry has no command and no branch — usually a leftover from an
 * older state-schema migration. dispatchSliceId is deterministic from the item
 * path, so a stub's key collides with the SID of a freshly-computed ready item;
 * treat stubs as "no info" so we don't block fresh dispatches behind ghosts.
 */
export function isStubArchivedSlice(slice: any): boolean {
  if (!slice || typeof slice !== "object") return true;
  const hasCommand = typeof slice.command === "string" && slice.command.length > 0;
  const hasBranch =
    (typeof slice.branch === "string" && slice.branch.length > 0) ||
    (typeof slice.actual_branch === "string" && slice.actual_branch.length > 0);
  return !hasCommand && !hasBranch;
}

export function alreadyArchivedSlice(state: any, item: any, sliceId: string): boolean {
  const archived = archivedSlices(state);
  if (Object.prototype.hasOwnProperty.call(archived, sliceId) && !isStubArchivedSlice(archived[sliceId]))
    return true;
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const slice of Object.values(archived)) {
    if (!slice || typeof slice !== "object") continue;
    if (sliceActionKey(slice) === key) return true;
    if ((slice as any).branch && (slice as any).branch === branch) return true;
    if ((slice as any).actual_branch && (slice as any).actual_branch === branch) return true;
  }
  return false;
}

export function alreadyHasInFlightSlice(state: any, item: any, sliceId: string): boolean {
  if (alreadyArchivedSlice(state, item, sliceId)) return true;
  return inFlightSliceMatches(state, item, sliceId);
}

/**
 * Live-only portion of the dedup check. Carved out so the recovery-dispatch path
 * can distinguish "blocked because a recovery is already in flight" from
 * "blocked because the prior MERGED archive collides" (the recoverable case).
 */
export function inFlightSliceMatches(state: any, item: any, sliceId: string): boolean {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const [existingId, slice] of Object.entries(slices) as [string, any][]) {
    if (existingId === sliceId) return true;
    if (!slice || typeof slice !== "object") continue;
    if (sliceReleasesArtifact(slice)) continue;
    if (slice.original_slice_id === sliceId) return true;
    if (sliceActionKey(slice) === key) return true;
    if (slice.branch && slice.branch === branch) return true;
  }
  return false;
}

/**
 * Returns the matching archived slice ONLY if it terminated in MERGED — the
 * partial-merge recovery wedge (smithy says "ready" but the SID collides with a
 * prior MERGED archive). Escalated/closed-unmerged archives return null so they
 * keep blocking re-dispatch.
 */
export function blockingMergedArchive(state: any, item: any, sliceId: string): any {
  const archived = archivedSlices(state);
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  const isMerged = (a: any) => {
    if (!a || typeof a !== "object") return false;
    if (a.terminal_state === "MERGED") return true;
    if (a.stage === "merged") return true;
    if (a.pr && a.pr.state === "MERGED") return true;
    return false;
  };
  const direct = archived[sliceId];
  if (direct && !isStubArchivedSlice(direct) && isMerged(direct)) return direct;
  for (const slice of Object.values(archived)) {
    if (!slice || typeof slice !== "object") continue;
    if (!isMerged(slice)) continue;
    if (sliceActionKey(slice) === key) return slice;
    if ((slice as any).branch && (slice as any).branch === branch) return slice;
    if ((slice as any).actual_branch && (slice as any).actual_branch === branch) return slice;
  }
  return null;
}

/**
 * The number of slices in a profile's working state that are actively consuming
 * a worker resource — a running codex **spawn** (hatchery-pending / implementing)
 * or an active **steward** session (pr-open with owed thread responses / failing
 * checks / conflicts, pr-in-fix, pr-resolving-conflicts). The global spawn cap
 * (#313) budgets against the SUM of this across all profiles, so it bounds how
 * much heavy parallel work runs at once — NOT how many PRs are open.
 *
 * Excluded:
 *  - {@link isTerminalSlice terminal} slices (merged / closed / escalated) — done
 *    or operator-only, worker torn down.
 *  - {@link isReadyToMerge waiting-to-merge} slices (pr-open, checks passing, no
 *    conflicts, no threads owed) — the PR is parked awaiting a merge and runs no
 *    spawn or active steward, so it must NOT hold a slot. This is what lets the
 *    loop keep dispatching fresh work while merge-ready PRs pile up for review
 *    (the overnight-throughput goal). A waiting-to-merge slice that reverts to
 *    steward (new comment / conflict) counts again; because the cap only gates
 *    FRESH dispatch and never preempts, the live set can briefly exceed the cap —
 *    that just delays the next dispatch, it never kills running work.
 */
export function liveSpawnCount(state: any): number {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  let live = 0;
  for (const slice of Object.values(slices)) {
    if (isTerminalSlice(slice)) continue;
    if (isReadyToMerge(slice)) continue;
    live++;
  }
  return live;
}

/**
 * The shared, mutable per-tick budget for the GLOBAL concurrent-spawn cap (#313).
 * One instance is threaded across every profile's dispatch in a single tick so the
 * combined number of NEW spawns can't exceed the cap. `remaining` is decremented
 * per fresh launch and `deferred` accrues the dispatchable items skipped once the
 * budget is exhausted (they stay dispatchable and launch a later tick as slots
 * free). `cap`/`live` are the tick-start constants, retained for logging + /status.
 */
export interface SpawnBudget {
  /** The configured global cap (MARCH_MAX_CONCURRENT_SPAWNS). */
  readonly cap: number;
  /** Live spawns across ALL profiles at tick start (the cap's current draw). */
  readonly live: number;
  /** New fresh dispatches still permitted this tick; decremented per launch. */
  remaining: number;
  /** Fresh dispatchable items skipped this tick because the budget hit 0. */
  deferred: number;
}

/**
 * Seed the shared budget for a tick: `remaining = max(0, cap − liveAcrossProfiles)`.
 * A live count ≥ cap yields 0 remaining (dispatch is fully throttled this tick, not
 * negative). The caller threads the returned object through every profile's
 * dispatch so the global sum of fresh launches stays ≤ cap.
 */
export function createSpawnBudget(cap: number, liveAcrossProfiles: number): SpawnBudget {
  return { cap, live: liveAcrossProfiles, remaining: Math.max(0, cap - liveAcrossProfiles), deferred: 0 };
}

/**
 * The subset of smithy layer-0 ready items that would dispatch FRESH this tick:
 * ready minus anything already in-flight or archived — the exact dedup
 * {@link assess} (`handlers/dispatch.ts`) applies before launching a spawn. Shared
 * so the "dispatchable now" metric (#219) is driven by the dispatcher's selection
 * rather than the raw `ready.length`, which over-counts work the loop has already
 * dispatched (escalated slices stay in-flight until merge, so they correctly do
 * NOT count here — they belong in the escalated bucket).
 */
export function dispatchableReady<T>(state: any, ready: readonly T[] | undefined): T[] {
  return (ready ?? []).filter((item) => !alreadyHasInFlightSlice(state, item, dispatchSliceId(item)));
}

/**
 * Bounded auto-recovery for recoverable escalations (#211).
 *
 * A spawn that fails at the dispatch stage escalates with
 * `escalatedReason: hatchery_dispatch_failed` and — pre-#211 — sat operator-only
 * forever, wedging a still-ready smithy item behind it. The whole
 * `hatchery_dispatch_failed` family is *recoverable* by a fresh re-dispatch:
 *
 *   - a bad worker patch (the actual #211 root cause: a truncated diff / a
 *     new-file-on-existing) — codex is non-deterministic, so another worker gets
 *     a clean shot;
 *   - an orphan-branch collision — now collision-free since #216 deletes the
 *     orphan branch on the failed-spawn rollback;
 *   - a Hatchery job-lookup 404 after a service restart — a re-dispatch mints a
 *     fresh job.
 *
 * Recovery is gated by an ALLOWLIST of reasons (so any *other* future escalation
 * reason defaults to operator-only, fail-safe) and BOUNDED by a per-slice retry
 * counter — the same durable {@link transient_retry_counts} the relaunch handler
 * uses, folded via `retry.counted` and restored from the Herald fold on restart.
 * After {@link DISPATCH_RECOVERY_LIMIT} attempts the slice falls back to the
 * operator-only escalation it had before, so a genuinely-terminal failure (a
 * patch that is bad every time, a real config error) can never loop forever.
 */
export const RECOVERABLE_ESCALATION_REASONS = new Set<string>(["hatchery_dispatch_failed"]);

/**
 * How many times the loop auto-re-dispatches a recoverable escalation before
 * leaving it operator-only. Two: a deterministic failure that survives two fresh
 * workers is almost certainly not transient, so a human should look. Total spawn
 * attempts for a slice are 1 (original) + {@link DISPATCH_RECOVERY_LIMIT}.
 */
export const DISPATCH_RECOVERY_LIMIT = 2;

/** Durable retry-counter key for a slice's auto-recovery budget. Suffixed with
 *  the slice id so completePending's success-path cleanup (`endsWith(":"+id)`)
 *  clears it — emitting a durable `retry.counted` 0 so the reset survives a
 *  restart (the fold has no separate clear event) — once the slice transitions
 *  cleanly. */
export function recoveryAttemptKey(sliceId: string): string {
  return "dispatch-recovery:" + sliceId;
}

/**
 * True once a slice has used its full auto-recovery budget — i.e. the loop has
 * re-dispatched it {@link DISPATCH_RECOVERY_LIMIT} times and the latest attempt
 * still failed. The escalate paths use this to decide whether a dispatch failure
 * is still the loop's to retry (within budget → no operator notification) or has
 * become genuinely operator-only (budget exhausted → escalate for judgement), so
 * an operator is pinged once at the end rather than on every recoverable failure.
 */
export function recoveryBudgetExhausted(state: any, sliceId: string): boolean {
  const counts = state?.transient_retry_counts && typeof state.transient_retry_counts === "object" ? state.transient_retry_counts : {};
  const used = Number.isFinite(counts[recoveryAttemptKey(sliceId)]) ? counts[recoveryAttemptKey(sliceId)] : 0;
  return used >= DISPATCH_RECOVERY_LIMIT;
}

/** True when a slice is escalated for a reason the loop is allowed to auto-recover. */
export function escalatedRecoverable(slice: any): boolean {
  if (!slice || typeof slice !== "object") return false;
  if (slice.stage !== "escalated") return false;
  return RECOVERABLE_ESCALATION_REASONS.has(slice.escalated_reason);
}

/**
 * Live blocker OTHER than the escalated slice we're recovering. The escalated
 * slice is keyed at the item's deterministic id (`dispatchSliceId`), so this is
 * {@link inFlightSliceMatches} minus that self-match — a guard so recovery never
 * re-dispatches over a genuinely active worker that happens to share the branch.
 */
function otherLiveBlocker(state: any, item: any, sliceId: string): boolean {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const [existingId, slice] of Object.entries(slices) as [string, any][]) {
    if (existingId === sliceId) continue;
    if (!slice || typeof slice !== "object") continue;
    if (sliceReleasesArtifact(slice)) continue;
    if (slice.original_slice_id === sliceId) return true;
    if (sliceActionKey(slice) === key) return true;
    if (slice.branch && slice.branch === branch) return true;
  }
  return false;
}

/** A still-ready smithy item whose deterministic slice is recoverably escalated
 *  and within the retry budget — i.e. a candidate for auto re-dispatch. */
export interface RecoverableEscalation {
  readonly item: any;
  readonly sliceId: string;
  /** This attempt's 1-based count (== the persisted counter after apply). */
  readonly attempt: number;
  readonly limit: number;
}

/**
 * The subset of smithy layer-0 ready items the loop should AUTO-RECOVER this tick:
 * each item whose deterministic slice is escalated for a {@link
 * RECOVERABLE_ESCALATION_REASONS recoverable reason}, is within the {@link
 * DISPATCH_RECOVERY_LIMIT retry budget}, is not blocked by a terminal archive
 * decision (a MERGED/ESCALATED/CLOSED archive keeps blocking — we never fight an
 * operator's archive), and has no OTHER live blocker. Disjoint from {@link
 * dispatchableReady}: an escalated slice reads as in-flight there, so the same
 * item is never both a fresh dispatch and a recovery in one tick.
 */
export function recoverableEscalations(state: any, ready: readonly any[] | undefined): RecoverableEscalation[] {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const counts = state?.transient_retry_counts && typeof state.transient_retry_counts === "object" ? state.transient_retry_counts : {};
  const out: RecoverableEscalation[] = [];
  for (const item of ready ?? []) {
    const sliceId = dispatchSliceId(item);
    if (!escalatedRecoverable(slices[sliceId])) continue;
    const used = Number.isFinite(counts[recoveryAttemptKey(sliceId)]) ? counts[recoveryAttemptKey(sliceId)] : 0;
    if (used >= DISPATCH_RECOVERY_LIMIT) continue;
    if (alreadyArchivedSlice(state, item, sliceId)) continue;
    if (otherLiveBlocker(state, item, sliceId)) continue;
    out.push({ item, sliceId, attempt: used + 1, limit: DISPATCH_RECOVERY_LIMIT });
  }
  return out;
}

/**
 * The fixed slice-lifecycle vocabulary — the low-cardinality `stage` label set
 * for the `march.legate.slices` gauge (#220). Any slice stage outside this set
 * (a typo, a future stage, a transient `merged` before cleanup archives it) is
 * bucketed under {@link OTHER_STAGE} so a stray value can never blow up the
 * exported series cardinality.
 */
export const SLICE_STAGES = [
  "hatchery-pending",
  "implementing",
  "pr-open",
  "pr-in-fix",
  "pr-resolving-conflicts",
  "escalated",
] as const;

/** Catch-all bucket for any stage outside {@link SLICE_STAGES}. */
export const OTHER_STAGE = "other";

const STAGE_ALLOWLIST = new Set<string>(SLICE_STAGES);

/**
 * The fixed escalation-reason vocabulary — the low-cardinality `reason` label set
 * for the `march.legate.escalated` gauge. Splits the single `escalated` stage into
 * the operator-meaningful buckets the work-status dashboard shows:
 * `hatchery_dispatch_failed` is "spawn failed — never reached a steward"; the rest
 * are "steward stuck — needs the legate agent or an operator". Any reason outside
 * this set buckets under {@link OTHER_ESCALATION_REASON} so a stray value can never
 * blow up the series cardinality.
 */
export const ESCALATION_REASONS = [
  "hatchery_dispatch_failed",
  "needs_human",
  "needs_human_judgement",
  "real_spawn_error",
] as const;

/** Catch-all bucket for any escalation reason outside {@link ESCALATION_REASONS}. */
export const OTHER_ESCALATION_REASON = "other";

const ESCALATION_REASON_ALLOWLIST = new Set<string>(ESCALATION_REASONS);

/** Per-stage slice tally plus the derived ready-to-merge count (#220). */
export interface SliceStageSummary {
  /** Count of non-archived slices keyed by lifecycle `stage` (a metric label). */
  readonly byStage: Record<string, number>;
  /** Slices `pr-open` with passing checks, no conflicts, and no threads owed. */
  readonly readyToMerge: number;
  /** Escalated-stage slices keyed by escalation `reason` (a metric label). Sums to
   *  `byStage.escalated`; lets the dashboard split spawn-failed from steward-stuck. */
  readonly escalatedByReason: Record<string, number>;
}

/**
 * A `pr-open` slice whose PR has passing checks, is not CONFLICTING, and owes no
 * thread responses — the dashboard's "waiting for merge" bucket. It runs no codex
 * spawn and no active steward, so the spawn cap ({@link liveSpawnCount}) does NOT
 * count it. This is the SAME gate babysit uses for its "all clear" merge decision
 * and {@link summarizeSlicesByStage}'s `readyToMerge` tally, so the budget and the
 * dashboard agree 1:1 — "waiting for merge" on the board is exactly the set that
 * does not hold a budget slot.
 *
 * Thread debt must be an **explicit** `0` (from the flattened `needs_response_count`
 * babysit writes, or the PR snapshot it was derived from): after a cold start
 * `rebuildWorkingState` restores `slice.pr` but not the flattened counter, so a
 * missing value is "unknown debt" → treated as still-active (it counts), never
 * silently released.
 */
export function isReadyToMerge(slice: any): boolean {
  if (!slice || typeof slice !== "object") return false;
  if (slice.stage !== "pr-open") return false;
  if (slice.pr?.checks !== "PASS") return false;
  if (slice.pr?.mergeable === "CONFLICTING") return false;
  const owed = slice.needs_response_count ?? slice.pr?.needs_response_count;
  return owed === 0;
}

/**
 * Tally the loop's working slices by lifecycle `stage` and derive how many are
 * ready to merge (#220). Pure: reads only the in-memory working `slices` record
 * (after the tick's handlers have run, so stages/PR snapshots are current).
 *
 * `stage` is a metric label, so it is normalized to the fixed {@link SLICE_STAGES}
 * allowlist (anything else → {@link OTHER_STAGE}) to keep cardinality bounded, and
 * every allowed stage is **pre-seeded to 0** so the gauge observes the full label
 * set each tick — a dashboard tile then reads `0`, not "no data", when a stage is
 * empty.
 *
 * `readyToMerge` mirrors babysit's "all clear" gate (`handlers/babysit.ts`): a
 * `pr-open` slice whose PR has passing checks, is not CONFLICTING, and owes no
 * thread responses. Thread debt must be an **explicit** `0` (from the flattened
 * `needs_response_count` babysit writes, or the PR snapshot it was derived from):
 * after a cold start `rebuildWorkingState` restores `slice.pr` but not the
 * flattened counter, so a missing value is treated as "unknown", not "zero", to
 * avoid overstating the metric.
 */
export function summarizeSlicesByStage(slices: Record<string, any> | undefined): SliceStageSummary {
  const byStage: Record<string, number> = {};
  for (const stage of SLICE_STAGES) byStage[stage] = 0; // pre-seed so dashboards show 0, not "no data"
  const escalatedByReason: Record<string, number> = { [OTHER_ESCALATION_REASON]: 0 };
  for (const reason of ESCALATION_REASONS) escalatedByReason[reason] = 0; // pre-seed for stable series
  let readyToMerge = 0;
  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    const raw = typeof slice.stage === "string" ? slice.stage : "";
    const stage = STAGE_ALLOWLIST.has(raw) ? raw : OTHER_STAGE;
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    if (isReadyToMerge(slice)) readyToMerge++;
    if (stage === "escalated") {
      const r = typeof slice.escalated_reason === "string" && ESCALATION_REASON_ALLOWLIST.has(slice.escalated_reason)
        ? slice.escalated_reason
        : OTHER_ESCALATION_REASON;
      escalatedByReason[r] = (escalatedByReason[r] ?? 0) + 1;
    }
  }
  return { byStage, readyToMerge, escalatedByReason };
}
