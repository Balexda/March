import {
  dispatchBranch,
  dispatchItemKey,
  dispatchSliceId,
  legacyCutBranch,
  legacyCutSliceId,
  sliceActionKey,
} from "./dispatch-id.js";
import { isMarchBotComment } from "../../../observe/march-bot.js";
import { taskTypeForSlice } from "../../../herald/profiles/slice-verb.js";
import { approvalEvidence, changesRequestedSatisfied, resolveMergeRequirements, type ApprovalCode, type MergePolicy } from "../../../herald/profiles/merge-policy.js";
import { readRecoveryRate, stepRecoveryRate } from "./self-heal.js";
import {
  backoffUntil,
  clearBackoff,
  coolingDown,
  retryAttempts,
  scheduleBackoff,
  whenDue,
  type RetryDomain,
} from "./self-heal-pacer.js";

export { taskTypeForSlice };

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

/** Which identity matched a blocking slice to a ready item (#592). */
/** `legacy_id`: a pre-#599 cut id or branch, on an entry without an action key. */
export type BlockerMatch = "id" | "action_key" | "branch" | "legacy_id";

/** The archived slice that holds a ready item back, and how it matched (#592). */
export interface ArchiveBlocker {
  readonly sliceId: string;
  readonly matchedOn: BlockerMatch;
  /** The archive's terminal PR outcome; null when it ended any other way. */
  readonly terminal: "MERGED" | "CLOSED" | null;
  readonly prNumber: number | null;
}

/** The live (non-archived) slice that holds a ready item back (#592). */
export interface LiveBlocker {
  readonly sliceId: string;
  readonly matchedOn: BlockerMatch | "original_id";
  readonly stage: string | null;
  readonly escalatedReason: string | null;
}

/** An archive's terminal PR outcome, read the same way `rebuildWorkingState` writes it. */
export function archiveTerminal(slice: any): "MERGED" | "CLOSED" | null {
  if (!slice || typeof slice !== "object") return null;
  const state = typeof slice.terminal_state === "string" ? slice.terminal_state.toUpperCase() : null;
  if (state === "MERGED" || state === "CLOSED") return state;
  const prState = typeof slice.pr?.state === "string" ? slice.pr.state.toUpperCase() : null;
  if (prState === "MERGED" || prState === "CLOSED") return prState;
  if (slice.stage === "merged") return "MERGED";
  return null;
}

/**
 * Whether an archived slice may be released back to the queue (#592): a CLOSED
 * archive always, a MERGED one only with `releaseMerged` (its PR may really have
 * done the row's work — release it only when the id collided, #599/#602). Any
 * other archive (escalated, unknown outcome) stays an operator decision.
 */
export function releasableArchive(
  archived: any,
  releaseMerged: boolean,
): { ok: true; terminal: "MERGED" | "CLOSED" } | { ok: false; error: string } {
  const terminal = archiveTerminal(archived);
  if (terminal === "CLOSED") return { ok: true, terminal };
  if (terminal === "MERGED") {
    return releaseMerged
      ? { ok: true, terminal }
      : { ok: false, error: "is archived MERGED — pass releaseMerged:true to release its hold on the plan row (only if the merged PR did not do this row's work)" };
  }
  return { ok: false, error: `is archived (${archived?.terminal_state ?? "done"}) without a closed or merged PR — nothing to requeue` };
}

function archivePrNumber(slice: any): number | null {
  const n = typeof slice?.pr_number === "number" ? slice.pr_number : slice?.pr?.number;
  return typeof n === "number" && n > 0 ? n : null;
}

function archiveBlocker(sliceId: string, slice: any, matchedOn: BlockerMatch): ArchiveBlocker {
  return { sliceId, matchedOn, terminal: archiveTerminal(slice), prNumber: archivePrNumber(slice) };
}

/** True when the slice carries the action key (`command` etc.). Slices rebuilt
 *  from the Herald fold on a cold start do not. */
function hasActionKey(slice: any): boolean {
  return typeof slice?.command === "string" && slice.command.length > 0;
}

/**
 * True when `slice` is keyed by (or on the branch of) the id `item` had before
 * #599, and carries no action key to tell which row it was for. Sibling rows of a
 * long-named plan file share that legacy id, so such an entry is ambiguous: the
 * callers treat it conservatively (block) except where smithy's own state already
 * settles it (a MERGED archive). An entry WITH an action key is decided by the key.
 */
function ambiguousLegacyEntry(slice: any, existingId: string, item: any): boolean {
  if (!slice || typeof slice !== "object" || hasActionKey(slice)) return false;
  const legacyId = legacyCutSliceId(item);
  if (!legacyId) return false;
  if (existingId === legacyId) return true;
  const legacyBranch = legacyCutBranch(item);
  return Boolean(legacyBranch && (slice.branch === legacyBranch || slice.actual_branch === legacyBranch));
}

/**
 * The archived slice that blocks `item` from a fresh dispatch, or null. A direct
 * id hit on a {@link isStubArchivedSlice stub} is ignored; every archive is then
 * scanned for the same action key or branch, and for a pre-#599 cut id that
 * cannot be told apart from its siblings (see the loop). {@link alreadyArchivedSlice} is this
 * as a boolean, so the dispatch decisions `/queue` publishes and the selection the
 * dispatcher acts on can never disagree.
 */
export function findArchiveBlocker(state: any, item: any, sliceId: string): ArchiveBlocker | null {
  const archived = archivedSlices(state);
  if (Object.prototype.hasOwnProperty.call(archived, sliceId) && !isStubArchivedSlice(archived[sliceId]))
    return archiveBlocker(sliceId, archived[sliceId], "id");
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const [archivedId, slice] of Object.entries(archived) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    // A pre-#599 archive rebuilt without an action key (#599): a MERGED one does
    // not block (smithy marks the merged row done, and its siblings are not that
    // work); an escalated/closed one keeps blocking, as the operator decided.
    if (!isStubArchivedSlice(slice) && archiveTerminal(slice) !== "MERGED" && ambiguousLegacyEntry(slice, archivedId, item))
      return archiveBlocker(archivedId, slice, "legacy_id");
    if (sliceActionKey(slice) === key) return archiveBlocker(archivedId, slice, "action_key");
    if (slice.branch && slice.branch === branch) return archiveBlocker(archivedId, slice, "branch");
    if (slice.actual_branch && slice.actual_branch === branch) return archiveBlocker(archivedId, slice, "branch");
  }
  return null;
}

export function alreadyArchivedSlice(state: any, item: any, sliceId: string): boolean {
  return findArchiveBlocker(state, item, sliceId) !== null;
}

export function alreadyHasInFlightSlice(state: any, item: any, sliceId: string): boolean {
  if (alreadyArchivedSlice(state, item, sliceId)) return true;
  return inFlightSliceMatches(state, item, sliceId);
}

function liveBlocker(sliceId: string, slice: any, matchedOn: LiveBlocker["matchedOn"]): LiveBlocker {
  return {
    sliceId,
    matchedOn,
    stage: typeof slice?.stage === "string" ? slice.stage : null,
    escalatedReason: typeof slice?.escalated_reason === "string" ? slice.escalated_reason : null,
  };
}

/**
 * The live slice that blocks `item` from a fresh dispatch, or null. A slice keyed
 * at the item's own id always blocks; any other slice blocks unless it has
 * released its artifact (merged), matching on `original_slice_id`, action key or
 * branch. {@link inFlightSliceMatches} is this as a boolean.
 */
export function findLiveBlocker(state: any, item: any, sliceId: string): LiveBlocker | null {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const key = dispatchItemKey(item);
  const branch = dispatchBranch(item);
  for (const [existingId, slice] of Object.entries(slices) as [string, any][]) {
    if (existingId === sliceId) return liveBlocker(existingId, slice, "id");
    if (!slice || typeof slice !== "object") continue;
    if (sliceReleasesArtifact(slice)) continue;
    // A live pre-#599 slice rebuilt without an action key may be this row's
    // running worker; block rather than dispatch it twice (#599).
    if (ambiguousLegacyEntry(slice, existingId, item)) return liveBlocker(existingId, slice, "legacy_id");
    if (slice.original_slice_id === sliceId) return liveBlocker(existingId, slice, "original_id");
    if (sliceActionKey(slice) === key) return liveBlocker(existingId, slice, "action_key");
    if (slice.branch && slice.branch === branch) return liveBlocker(existingId, slice, "branch");
  }
  return null;
}

/**
 * Live-only portion of the dedup check. Carved out so the recovery-dispatch path
 * can distinguish "blocked because a recovery is already in flight" from
 * "blocked because the prior MERGED archive collides" (the recoverable case).
 */
export function inFlightSliceMatches(state: any, item: any, sliceId: string): boolean {
  return findLiveBlocker(state, item, sliceId) !== null;
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
 * After how many failed re-dispatches the loop PINGS THE OPERATOR (once). This is
 * NO LONGER a give-up limit (#460): the loop now re-dispatches a recoverable
 * escalation INDEFINITELY with exponential backoff (see {@link
 * recoverableEscalations}), the same self-healing pace the steward relaunch path
 * uses — a transient cause (stale base, a Castra-unreachable window, codex auth
 * lapse) self-heals the instant the world recovers, costing almost nothing while
 * it waits. The operator is still notified once this threshold is crossed so a
 * genuinely-stuck slice is visible, but the loop keeps probing (and, with parking
 * enabled, each failed probe leaves a forensic artifact to root-cause).
 */
export const DISPATCH_RECOVERY_LIMIT = 2;

/** Warm working-state field (in `state.raw`, NOT folded — resets to empty on a
 *  cold start, like the relaunch backoff map): epoch-ms of each slice's next
 *  dispatch-recovery eligibility. */
export const DISPATCH_RECOVERY_BACKOFF_FIELD = "dispatch_recovery_backoff_until";
/** Warm working-state field: the dispatch-recovery AIMD rate R (max re-dispatches
 *  attempted per tick). Its own scalar, independent of relaunch's `recovery_rate`,
 *  so a spawn-failure burst and a steward-relaunch burst don't throttle each other. */
export const DISPATCH_RECOVERY_RATE_FIELD = "dispatch_recovery_rate";

/** This domain's ({@link recoveryAttemptKey}, {@link DISPATCH_RECOVERY_BACKOFF_FIELD})
 *  pair for the shared self-heal {@link RetryDomain pacer} — the same retry-counter +
 *  warm-backoff-window bookkeeping the relaunch and CI-fix domains use. */
export const DISPATCH_RECOVERY_DOMAIN: RetryDomain = {
  retryKey: (sliceId) => recoveryAttemptKey(sliceId),
  backoffField: DISPATCH_RECOVERY_BACKOFF_FIELD,
};

/**
 * Schedule the next dispatch-recovery backoff window for a slice after a failed
 * (re-)dispatch: `now + backoffMs(attempt)`. `attempt` is the failure count so
 * far (1-based) so the delay doubles per failure. No-op when `nowMs` is not a
 * finite time (a non-date tick ts → backoff can't gate, so don't record one).
 */
export function scheduleDispatchRecoveryBackoff(state: any, sliceId: string, attempt: number, nowMs: number): void {
  scheduleBackoff(state, DISPATCH_RECOVERY_DOMAIN, sliceId, attempt, nowMs);
}

/** Clear a slice's dispatch-recovery backoff (it transitioned cleanly, so a future
 *  re-strand should re-probe promptly with a short first backoff). */
export function clearDispatchRecoveryBackoff(state: any, sliceId: string): void {
  clearBackoff(state, DISPATCH_RECOVERY_DOMAIN, sliceId);
}

/** AIMD decrease: halve R (floored at MIN) after a failed re-dispatch. */
export function decreaseDispatchRecoveryRate(state: any): void {
  const current = readRecoveryRate(state, DISPATCH_RECOVERY_RATE_FIELD);
  const next = stepRecoveryRate(current, { failures: 1, rateLimited: false });
  if (next !== current) state[DISPATCH_RECOVERY_RATE_FIELD] = next;
}

/** AIMD increase: +1 R (capped at MAX) after a re-dispatch that cleanly succeeded. */
export function increaseDispatchRecoveryRate(state: any): void {
  const current = readRecoveryRate(state, DISPATCH_RECOVERY_RATE_FIELD);
  const next = stepRecoveryRate(current, { failures: 0, rateLimited: true });
  if (next !== current) state[DISPATCH_RECOVERY_RATE_FIELD] = next;
}

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
  return retryAttempts(state, DISPATCH_RECOVERY_DOMAIN, sliceId) >= DISPATCH_RECOVERY_LIMIT;
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
    if (ambiguousLegacyEntry(slice, existingId, item)) return true;
    if (slice.original_slice_id === sliceId) return true;
    if (sliceActionKey(slice) === key) return true;
    if (slice.branch && slice.branch === branch) return true;
  }
  return false;
}

/**
 * The pre-#599 id of a recoverably escalated slice that belongs to `item`, or
 * null. The entry belongs to the item when its action key matches, or — rebuilt
 * without one — when `item` is the only ready item that maps to that legacy id.
 * With several candidates it is ambiguous and stays blocked (the operator's
 * `march legate requeue` clears it).
 */
function legacyRecoverableId(slices: Record<string, any>, item: any, ready: readonly any[] | undefined): string | null {
  const legacyId = legacyCutSliceId(item);
  if (!legacyId) return null;
  const slice = slices[legacyId];
  if (!escalatedRecoverable(slice)) return null;
  if (hasActionKey(slice)) return sliceActionKey(slice) === dispatchItemKey(item) ? legacyId : null;
  const owners = (ready ?? []).filter((candidate) => legacyCutSliceId(candidate) === legacyId);
  return owners.length === 1 ? legacyId : null;
}

/** The id of the recoverable escalation `item` owns: its own slice, else a
 *  pre-#599 one per {@link legacyRecoverableId}; null when there is none. */
function recoveryTargetId(slices: Record<string, any>, item: any, ready: readonly any[] | undefined): string | null {
  const currentId = dispatchSliceId(item);
  return escalatedRecoverable(slices[currentId]) ? currentId : legacyRecoverableId(slices, item, ready);
}

/** A still-ready smithy item whose deterministic slice is recoverably escalated
 *  and eligible for an auto re-dispatch this tick. */
export interface RecoverableEscalation {
  readonly item: any;
  readonly sliceId: string;
  /** This attempt's 1-based count (== the persisted counter after apply). */
  readonly attempt: number;
  readonly limit: number;
}

/**
 * The subset of smithy layer-0 ready items the loop should AUTO-RECOVER this tick.
 * Each candidate's deterministic slice is escalated for a {@link
 * RECOVERABLE_ESCALATION_REASONS recoverable reason}, is not blocked by a terminal
 * archive decision (a MERGED/ESCALATED/CLOSED archive keeps blocking — we never
 * fight an operator's archive), and has no OTHER live blocker. Disjoint from
 * {@link dispatchableReady}: an escalated slice reads as in-flight there, so the
 * same item is never both a fresh dispatch and a recovery in one tick.
 *
 * SELF-HEALING PACE (#460), mirroring the steward relaunch path: there is NO hard
 * give-up limit. A recoverable escalation is re-dispatched INDEFINITELY but
 *  - gated by EXPONENTIAL BACKOFF + per-slice jitter ({@link
 *    DISPATCH_RECOVERY_BACKOFF_FIELD}, warm-only): a candidate still cooling down
 *    is skipped, so a genuinely-broken slice is probed ever-further apart yet
 *    self-heals the instant the cause clears; and
 *  - rate-limited by the per-profile AIMD rate R ({@link
 *    DISPATCH_RECOVERY_RATE_FIELD}): at most R candidates per tick, longest-waiting
 *    first, so a burst that all failed at once can't stampede re-dispatches (the
 *    throttle that replaces the removed hard cap).
 *
 * `nowMs` is the tick epoch-ms; pass NaN (or omit) to disable the backoff gate
 * (unit tests / a non-date tick → every recoverable slice is eligible).
 */
export function recoverableEscalations(state: any, ready: readonly any[] | undefined, nowMs = NaN): RecoverableEscalation[] {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const candidates: { item: any; sliceId: string; attempt: number; until: number }[] = [];
  for (const item of ready ?? []) {
    const currentId = dispatchSliceId(item);
    const sliceId = recoveryTargetId(slices, item, ready);
    if (!sliceId) continue;
    if (alreadyArchivedSlice(state, item, currentId)) continue;
    if (otherLiveBlocker(state, item, sliceId)) continue;
    // The pacer's "it's time" gate: the callback fires only once the slice is past
    // its backoff window (a candidate still cooling down is skipped).
    whenDue(state, DISPATCH_RECOVERY_DOMAIN, sliceId, nowMs, (attempt, until) => {
      candidates.push({ item, sliceId, attempt, until });
    });
  }
  // Longest-waiting first: smallest next-eligible timestamp (never-tried = 0) wins.
  candidates.sort((a, b) => a.until - b.until);
  const rate = readRecoveryRate(state, DISPATCH_RECOVERY_RATE_FIELD);
  return candidates.slice(0, rate).map((c) => ({
    item: c.item,
    sliceId: c.sliceId,
    attempt: c.attempt,
    limit: DISPATCH_RECOVERY_LIMIT,
  }));
}

/**
 * Why one ready plan item did or did not dispatch this tick (#592). The fixed
 * vocabulary is also the `decision` label on `march.legate.dispatch.items`, so
 * keep it low-cardinality.
 *
 *  - `dispatch`: launched fresh this tick.
 *  - `spawn_cap`: would launch, but the global spawn budget (cap or breaker) ran out.
 *  - `paused`: would launch or re-dispatch, but an operator paused dispatch (#593).
 *  - `in_flight`: a live slice already covers it.
 *  - `recovery_due` / `recovery_backoff`: its own slice is a recoverable
 *    escalation, re-dispatched this tick or cooling down / rate-limited.
 *  - `archived_merged` / `archived_closed` / `archived_other`: an archived slice
 *    with the same id, action key or branch holds it back.
 */
export const DISPATCH_DECISIONS = [
  "dispatch",
  "spawn_cap",
  "paused",
  "in_flight",
  "recovery_due",
  "recovery_backoff",
  "archived_merged",
  "archived_closed",
  "archived_other",
] as const;
export type DispatchDecisionKind = (typeof DISPATCH_DECISIONS)[number];

/** One row of the per-item dispatch decisions `GET /queue` serves (#592). */
export interface DispatchDecisionRow {
  readonly path: string | null;
  readonly rowId: string | null;
  readonly command: string | null;
  readonly arguments: readonly unknown[];
  readonly sliceId: string;
  readonly branch: string;
  decision: DispatchDecisionKind;
  readonly heldBy?: {
    readonly sliceId: string;
    readonly matchedOn: string;
    readonly prNumber?: number | null;
    readonly terminal?: "MERGED" | "CLOSED" | null;
    readonly stage?: string | null;
    readonly escalatedReason?: string | null;
  };
  /** ISO time a `recovery_backoff` item next becomes eligible, when known. */
  readonly retryAt?: string;
}

/**
 * Pure: classify every ready item with the same matchers {@link assess} uses, so
 * the published decision is the dispatcher's actual reason. `spawn_cap` is never
 * produced here — the dispatch handler marks it when the shared budget runs out.
 * `nowMs` gates recovery backoff exactly as {@link recoverableEscalations} does.
 */
export function classifyReady(state: any, ready: readonly any[] | undefined, nowMs = NaN): DispatchDecisionRow[] {
  const slices = state?.slices && typeof state.slices === "object" ? state.slices : {};
  const due = new Set(recoverableEscalations(state, ready, nowMs).map((r) => r.sliceId));
  return (ready ?? []).map((item) => {
    const sliceId = dispatchSliceId(item);
    const base = {
      path: typeof item?.path === "string" ? item.path : null,
      rowId: item?.parent_row_id != null ? String(item.parent_row_id) : null,
      command: typeof item?.next_action?.command === "string" ? item.next_action.command : null,
      arguments: Array.isArray(item?.next_action?.arguments) ? item.next_action.arguments : [],
      sliceId,
      branch: dispatchBranch(item),
    };
    const archived = findArchiveBlocker(state, item, sliceId);
    if (archived) {
      const decision: DispatchDecisionKind =
        archived.terminal === "MERGED" ? "archived_merged" : archived.terminal === "CLOSED" ? "archived_closed" : "archived_other";
      return { ...base, decision, heldBy: { ...archived } };
    }
    const live = findLiveBlocker(state, item, sliceId);
    if (!live) return { ...base, decision: "dispatch" as const };
    const heldBy = { ...live };
    // The item's own recoverable escalation — keyed at its id, or at its pre-#599
    // id when it owns that entry (#599).
    const recoveryId = recoveryTargetId(slices, item, ready);
    if (recoveryId && live.sliceId === recoveryId && !otherLiveBlocker(state, item, recoveryId)) {
      if (due.has(recoveryId)) return { ...base, decision: "recovery_due" as const, heldBy };
      // Not due: cooling down (retryAt known) or cut by this tick's AIMD rate.
      const retryAt = coolingDown(state, DISPATCH_RECOVERY_DOMAIN, recoveryId, nowMs)
        ? new Date(backoffUntil(state, DISPATCH_RECOVERY_DOMAIN, recoveryId)).toISOString()
        : undefined;
      return { ...base, decision: "recovery_backoff" as const, heldBy, ...(retryAt ? { retryAt } : {}) };
    }
    return { ...base, decision: "in_flight" as const, heldBy };
  });
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

export const STAGE_ALLOWLIST = new Set<string>(SLICE_STAGES);

/**
 * Lifecycle stages where a live steward session is EXPECTED to be attached — the
 * slice was handed to a steward (`implementing`) or has an open PR a steward
 * babysits/fixes/rebases. Mirrors relaunch's eligible stages, so what relaunch
 * tries to re-attach is exactly what counts as stranded until it succeeds.
 */
export const STEWARD_STAGES = new Set<string>([
  "implementing",
  "pr-open",
  "pr-in-fix",
  "pr-resolving-conflicts",
  "pr-rebasing",
  "pr-in-rerun",
]);

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
  // A steward was dispatched a fix (comment / review / conflict / CI) but parked
  // (waiting/idle) without acting — and the legate-agent/human path that would
  // drive it isn't built yet, so we surface it as escalated rather than silently
  // dropping it. Operator-resolvable; not auto-recoverable (#non-thread-comments).
  "steward_stuck",
  // The steward explicitly handed a decision back / asked the user and is parked
  // AWAITING the user's response (detected from session output). The thing it's
  // pending — operator input — isn't deliverable by the loop, so it is escalated.
  "steward_awaiting_input",
] as const;

/** Catch-all bucket for any escalation reason outside {@link ESCALATION_REASONS}. */
export const OTHER_ESCALATION_REASON = "other";

const ESCALATION_REASON_ALLOWLIST = new Set<string>(ESCALATION_REASONS);

/** Per-stage slice tally plus the derived ready-to-merge count (#220). */
export interface SliceStageSummary {
  /** Count of non-archived slices keyed by lifecycle `stage` (a metric label). */
  readonly byStage: Record<string, number>;
  /** All-clear slices the loop WILL squash-merge now (`merge_gate == ready`).
   *  Transient (they merge + archive); a lingering >0 is a merge stall. */
  readonly readyToMerge: number;
  /** All-clear slices blocked on a review gate (`merge_gate ==
   *  waiting-approval`). Human-paced — a metric, never an alarm. */
  readonly waitingOnApproval: number;
  /** All-clear, human-gates-cleared slices GitHub won't merge yet
   *  (`merge_gate == blocked-merge-state`: UNKNOWN/BEHIND/BLOCKED/DIRTY). A real
   *  stall the loop can't clear itself. */
  readonly blockedOnMergeState: number;
  /** Escalated-stage slices keyed by escalation `reason` (a metric label). Sums to
   *  `byStage.escalated`; lets the dashboard split spawn-failed from steward-stuck. */
  readonly escalatedByReason: Record<string, number>;
  /** PR-bearing slices keyed by dominant merge BLOCKER ({@link PrBlocker}), the
   *  not-ready reasons the 3-way merge-readiness gauge collapses away — `conflicting`
   *  / `owes_review_threads` / `owes_comments` / `ci_failing`. Pre-seeded to 0. */
  readonly prBlocker: Record<string, number>;
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
  if (slice.pr?.checks !== "PASS" && slice.pr?.checks !== "NONE") return false;
  if (slice.pr?.mergeable === "CONFLICTING") return false;
  const owed = slice.needs_response_count ?? slice.pr?.needs_response_count;
  return owed === 0;
}

/**
 * The human-consumable merge state of a `pr-open` slice — a THREE-way split of the
 * all-clear set (passing checks, not conflicting, no threads owed):
 *   - `ready`               — review gates cleared (approval / changes-requested per
 *                             the profile's merge policy) AND GitHub's own
 *                             `merge_state_status == clean`: the loop squash-merges
 *                             it now. Transient — a `ready` slice merges and
 *                             archives, so it does not linger.
 *   - `waiting-approval`    — blocked on a review gate (missing required
 *                             approval or an open changes-requested review).
 *                             Tracked as a metric.
 *   - `blocked-merge-state` — review gates cleared but GitHub won't merge yet
 *                             (`UNKNOWN`/`BEHIND`/`BLOCKED`/`DIRTY` — needs a rebase
 *                             or branch protection still enforces a review the
 *                             policy relaxed). A real stall the loop can't clear
 *                             on its own.
 *   - `not-ready`           — fails the all-clear precondition.
 */
export type MergeReadiness = "not-ready" | "ready" | "waiting-approval" | "blocked-merge-state";

/**
 * Stable machine-readable reasons a PR-bearing slice is not merging, collected by
 * {@link mergeVerdict} and stamped onto `slice.merge_failing` by babysit's
 * `snapshot()`. Exposed by the legate's `GET /slices` route and explained by the
 * `march:needs-human` reason comment. Do not rename: consumers match on them.
 *   - `not-pr-open`          — the slice is not at `pr-open` (always reported alone).
 *   - `checks:not-green`     — CI is neither PASS nor NONE.
 *   - `conflict`             — the PR conflicts with its base.
 *   - `threads:owed`         — review threads / comments still owe a response.
 *   - `approval:*`           — see {@link ApprovalCode}.
 *   - `changes-requested`    — an eligible reviewer's changes-requested stands.
 *   - `merge-state:unknown`  — GitHub's merge state is absent (or UNKNOWN).
 *   - `merge-state:<status>` — GitHub's merge state is present and not clean (e.g. `merge-state:behind`).
 *   - `head-sha:missing`     — the observed PR carries no head commit, so the loop will not merge.
 */
export type MergeConditionCode =
  | "not-pr-open"
  | "checks:not-green"
  | "conflict"
  | "threads:owed"
  | ApprovalCode
  | "changes-requested"
  | "merge-state:unknown"
  | `merge-state:${string}`
  | "head-sha:missing";

/**
 * Classify a slice's merge readiness from the LIVE PR snapshot AND collect every
 * failing condition, in one pass so the gate and its reasons cannot diverge.
 * Mirrors babysit's auto-merge gate EXACTLY (same `resolveMergeRequirements`
 * approval/CR checks + `merge_state_status == clean` + a present `head_sha`).
 * `pr` is the source of the merge fields — pass the freshly observed PR so the
 * verdict reflects what the loop actually sees this tick (babysit stamps both
 * results onto `slice.merge_gate` / `slice.merge_failing` in `snapshot()`); the
 * summary then tallies the stamp rather than recomputing from the possibly-stale
 * persisted `slice.pr`. A missing approval/merge-state/head field fails its gate
 * (fail-safe — never falsely claims `ready`).
 *
 * `failing` lists ALL failing conditions (not first-fail), ordered: checks,
 * conflict, threads, approval, changes-requested, merge state, head sha. A slice
 * that is not `pr-open` reports `["not-pr-open"]` alone. The gate precedence is:
 * checks/conflict/threads → `not-ready`; approval/CR → `waiting-approval`; missing
 * merge state → `not-ready`; non-clean → `blocked-merge-state`; missing head sha →
 * `not-ready`; else `ready` (`failing` empty).
 */
export function mergeVerdict(
  sliceId: string,
  slice: any,
  pr: any,
  mergePolicy: MergePolicy | undefined,
): { gate: MergeReadiness; failing: MergeConditionCode[] } {
  if (!slice || typeof slice !== "object" || slice.stage !== "pr-open") {
    return { gate: "not-ready", failing: ["not-pr-open"] };
  }
  const src = pr ?? {};
  const failing: MergeConditionCode[] = [];
  const checksBad = src.checks !== "PASS" && src.checks !== "NONE";
  if (checksBad) failing.push("checks:not-green");
  const conflict = src.mergeable === "CONFLICTING";
  if (conflict) failing.push("conflict");
  const owed = src.needs_response_count ?? slice.needs_response_count ?? slice.pr?.needs_response_count;
  const threadsOwed = owed !== 0;
  if (threadsOwed) failing.push("threads:owed");
  const req = resolveMergeRequirements(mergePolicy, taskTypeForSlice(sliceId, slice));
  const approval = approvalEvidence(req, src);
  if (!approval.ok && approval.code) failing.push(approval.code);
  const crOk = changesRequestedSatisfied(req, src);
  if (!crOk) failing.push("changes-requested");
  // A missing/empty merge_state_status (sense-io maps absent → null; also the
  // case for a cold-start thin slice.pr) is UNKNOWN, not a stall — classify it
  // not-ready so a partial/restarted observation can't raise a false
  // blocked-merge-state alarm. Only a present, non-"clean" value is a real stall.
  const mergeState = src.merge_state_status;
  const stateUnknown = mergeState == null || mergeState === "";
  const stateLower = stateUnknown ? "" : String(mergeState).toLowerCase();
  if (stateUnknown) failing.push("merge-state:unknown");
  else if (stateLower !== "clean") failing.push(`merge-state:${stateLower}`);
  const headMissing = !src.head_sha;
  if (headMissing) failing.push("head-sha:missing");

  let gate: MergeReadiness;
  if (checksBad || conflict || threadsOwed) gate = "not-ready";
  else if (!approval.ok || !crOk) gate = "waiting-approval";
  else if (stateUnknown) gate = "not-ready";
  else if (stateLower !== "clean") gate = "blocked-merge-state";
  else if (headMissing) gate = "not-ready";
  else gate = "ready";
  return { gate, failing };
}

/** The merge-readiness gate alone — `mergeVerdict(...).gate`, so they cannot diverge. */
export function mergeReadiness(
  sliceId: string,
  slice: any,
  pr: any,
  mergePolicy: MergePolicy | undefined,
): MergeReadiness {
  return mergeVerdict(sliceId, slice, pr, mergePolicy).gate;
}

/**
 * The merge-BLOCKER taxonomy for a PR-bearing slice: the dominant reason it is not
 * merging, in babysit's own dispatch precedence (conflict → review threads → CI →
 * conversation comments) — so the gauge reflects what the loop will actually act on
 * (a red-CI PR with an unacked comment classifies `ci_failing`, since babysit fixes
 * CI before comments). This COMPLEMENTS {@link mergeReadiness} rather than
 * duplicating it — the all-clear gate states (ready / waiting-approval /
 * blocked-merge-state) are reported by the 3-way gauge; this surfaces only the
 * not-ready blockers that the 3-way collapses into "not-ready" and so makes
 * invisible. `conflicting` (the base-movement / StorySpider #597 class) and
 * `owes_comments` (the non-thread-comment / March #294 class) are otherwise
 * unobservable today. `none` = no active blocker here (all-clear, no observed PR,
 * or CI still PENDING — a healthy transient). Bounded label set.
 */
export type PrBlocker = "none" | "conflicting" | "owes_review_threads" | "owes_comments" | "ci_failing";

/** The non-`none` {@link PrBlocker} values — the metric's pre-seeded label set. */
export const PR_BLOCKER_REASONS = ["conflicting", "owes_review_threads", "owes_comments", "ci_failing"] as const;

/** A conversation (non-thread) comment is outstanding when it carries no legate
 *  :eyes: ack yet and is not one of March's own `[march-bot]` replies (#374)
 *  (mirrors `commentsNeedingResponse`; the marker predicate lives in the
 *  dependency-free `march-bot` module so this pure module stays clean). */
function owesCommentResponse(pr: any): boolean {
  const comments = pr?.conversation_comments;
  return (
    Array.isArray(comments) && comments.some((c: any) => c && c.reacted_eyes !== true && !isMarchBotComment(c))
  );
}

/**
 * Classify a slice's dominant merge blocker from the LIVE PR snapshot. Unlike
 * {@link mergeReadiness} this does NOT gate on `stage === "pr-open"` — a slice the
 * loop has already moved to `pr-resolving-conflicts` / `pr-in-fix` still reports
 * the blocker its live PR exhibits, so the gauge reflects the true backlog, not
 * just the not-yet-dispatched set. Returns `none` when there is no observed PR or
 * the PR is all-clear / CI-pending (covered by mergeReadiness or healthy).
 */
export function mergeBlocker(slice: any, pr: any): PrBlocker {
  const src = pr ?? slice?.pr ?? {};
  if (!src || typeof src !== "object" || src.number == null) return "none";
  if (src.mergeable === "CONFLICTING") return "conflicting";
  const owed = src.needs_response_count ?? slice?.needs_response_count;
  if (typeof owed === "number" && owed > 0) return "owes_review_threads";
  // CI before comments — matches babysit's block order (it dispatches a ci-fix
  // before a comment-fix), so a red-CI PR with an unacked comment is `ci_failing`.
  if (src.checks === "FAIL") return "ci_failing";
  if (owesCommentResponse(src)) return "owes_comments";
  return "none";
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
  const prBlocker: Record<string, number> = {};
  for (const reason of PR_BLOCKER_REASONS) prBlocker[reason] = 0; // pre-seed so dashboards show 0, not "no data"
  let readyToMerge = 0;
  let waitingOnApproval = 0;
  let blockedOnMergeState = 0;
  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    const raw = typeof slice.stage === "string" ? slice.stage : "";
    const stage = STAGE_ALLOWLIST.has(raw) ? raw : OTHER_STAGE;
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    // Tally the merge-readiness 3-way from babysit's live-PR verdict
    // (`slice.merge_gate`, stamped in snapshot()) — NOT recomputed here, so the
    // count reflects what the loop actually saw, not a stale persisted slice.pr.
    switch (slice.merge_gate) {
      case "ready":
        readyToMerge++;
        break;
      case "waiting-approval":
        waitingOnApproval++;
        break;
      case "blocked-merge-state":
        blockedOnMergeState++;
        break;
    }
    if (stage === "escalated") {
      const r = typeof slice.escalated_reason === "string" && ESCALATION_REASON_ALLOWLIST.has(slice.escalated_reason)
        ? slice.escalated_reason
        : OTHER_ESCALATION_REASON;
      escalatedByReason[r] = (escalatedByReason[r] ?? 0) + 1;
    }
    // Tally the merge-blocker stamp (`slice.pr_blocker`, set in babysit's snapshot()
    // from the live PR) — only the non-`none` reasons are tracked series.
    if (typeof slice.pr_blocker === "string" && slice.pr_blocker in prBlocker) {
      prBlocker[slice.pr_blocker] += 1;
    }
  }
  return { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState, escalatedByReason, prBlocker };
}

/**
 * Count non-terminal slices in a {@link STEWARD_STAGES steward stage} that have NO
 * live worker session — an empty `worker_session_id`, a pointer to a session
 * Castra no longer lists, or one it lists as `error`/`stopped` (#587: the caller
 * leaves those out of `liveWorkerSessionIds`). These slices read as active work on the board (they sit
 * in `pr-open`/`implementing`/…) but have no resource behind them: the steward
 * crashed, or the slice was adopted from an observed open PR whose dispatch failed
 * before a steward ever launched (gatecli's spawn-failed forge slices, promoted to
 * `pr-open` by adopt-from-fold). Pure: `liveWorkerSessionIds` is the set of live
 * worker-session ids observed this tick. Exported as `march_legate_slices_stranded`
 * so this work stops masquerading as healthy "In steward" — and stays visible even
 * after relaunch exhausts its retry budget and goes quiet.
 */
export function countStrandedSlices(
  slices: Record<string, any> | undefined,
  liveWorkerSessionIds: ReadonlySet<string>,
): number {
  let stranded = 0;
  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    if (!STEWARD_STAGES.has(slice.stage)) continue;
    const sid = slice.worker_session_id;
    const hasLiveSteward = typeof sid === "string" && sid.length > 0 && liveWorkerSessionIds.has(sid);
    if (!hasLiveSteward) stranded++;
  }
  return stranded;
}
