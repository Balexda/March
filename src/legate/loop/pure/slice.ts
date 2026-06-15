import { dispatchBranch, dispatchItemKey, dispatchSliceId, sliceActionKey } from "./dispatch-id.js";
import { resolveMergeRequirements, type MergePolicy } from "../../../herald/profiles/merge-policy.js";
import { workerBySessionId } from "./session.js";

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

export const STAGE_ALLOWLIST = new Set<string>(SLICE_STAGES);

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
  /** All-clear slices blocked on a HUMAN review gate (`merge_gate ==
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
  /** Slices whose live steward session is parked in `waiting` status — blocked
   *  needing input, an operator-attention signal independent of any GitHub state
   *  (stamped by {@link stampStewardAwaitingInput}). */
  readonly stewardsAwaitingInput: number;
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
 * The smithy verb that keys a slice's per-task-type merge policy (e.g. "cut").
 * Tries, in order: the dispatch-time `command`; the fold-durable branch
 * (`smithy/<verb>/…`); the sliceId suffix (`…-<verb>`). Undefined for
 * non-smithy / unrecognized shapes → {@link resolveMergeRequirements} falls back
 * to all-required. Shared by babysit's auto-merge gate AND the merge-readiness
 * split below so the gauge and the gate agree on the task type 1:1.
 */
export function taskTypeForSlice(sliceId: string, slice: any): string | undefined {
  const fromCommand = String(slice?.command || "").match(/^smithy\.([a-z0-9_-]+)/i);
  if (fromCommand) return fromCommand[1].toLowerCase();
  const branch = String(slice?.actual_branch || slice?.branch || "");
  const fromBranch = branch.match(/(?:^|\/)smithy\/([a-z0-9_-]+)\//i);
  if (fromBranch) return fromBranch[1].toLowerCase();
  const fromId = String(sliceId || "").match(/-(cut|forge|mark|render|fix|strike)$/i);
  if (fromId) return fromId[1].toLowerCase();
  return undefined;
}

/**
 * The human-consumable merge state of a `pr-open` slice — a THREE-way split of the
 * all-clear set (passing checks, not conflicting, no threads owed):
 *   - `ready`               — human gates cleared (approval / changes-requested per
 *                             the profile's merge policy) AND GitHub's own
 *                             `merge_state_status == clean`: the loop squash-merges
 *                             it now. Transient — a `ready` slice merges and
 *                             archives, so it does not linger.
 *   - `waiting-approval`    — blocked on a HUMAN review gate (missing required
 *                             approval or an open changes-requested review).
 *                             Human-paced — a metric, NEVER an alarm.
 *   - `blocked-merge-state` — human gates cleared but GitHub won't merge yet
 *                             (`UNKNOWN`/`BEHIND`/`BLOCKED`/`DIRTY` — needs a rebase
 *                             or branch protection still enforces a review the
 *                             policy relaxed). A real stall the loop can't clear
 *                             on its own.
 *   - `not-ready`           — fails the all-clear precondition.
 */
export type MergeReadiness = "not-ready" | "ready" | "waiting-approval" | "blocked-merge-state";

/**
 * Classify a slice's merge readiness from the LIVE PR snapshot, mirroring
 * babysit's auto-merge gate EXACTLY (same `resolveMergeRequirements` approval/CR
 * checks + `merge_state_status == clean`). `pr` is the source of the merge fields
 * — pass the freshly observed PR so the verdict reflects what the loop actually
 * sees this tick (babysit stamps it onto `slice.merge_gate` in `snapshot()`); the
 * summary then tallies the stamp rather than recomputing from the possibly-stale
 * persisted `slice.pr`. A missing approval/merge-state field fails its gate
 * (fail-safe — never falsely claims `ready`).
 */
export function mergeReadiness(
  sliceId: string,
  slice: any,
  pr: any,
  mergePolicy: MergePolicy | undefined,
): MergeReadiness {
  if (!slice || typeof slice !== "object" || slice.stage !== "pr-open") return "not-ready";
  const src = pr ?? {};
  if (src.checks !== "PASS") return "not-ready";
  if (src.mergeable === "CONFLICTING") return "not-ready";
  const owed = src.needs_response_count ?? slice.needs_response_count ?? slice.pr?.needs_response_count;
  if (owed !== 0) return "not-ready";
  const req = resolveMergeRequirements(mergePolicy, taskTypeForSlice(sliceId, slice));
  const approvalOk = !req.approval || Number(src.human_approval_count ?? 0) >= 1;
  const crOk = !req.changesRequested || Number(src.changes_requested_count ?? 0) === 0;
  if (!approvalOk || !crOk) return "waiting-approval";
  // A missing/empty merge_state_status (sense-io maps absent → null; also the
  // case for a cold-start thin slice.pr) is UNKNOWN, not a stall — classify it
  // not-ready so a partial/restarted observation can't raise a false
  // blocked-merge-state alarm. Only a present, non-"clean" value is a real stall.
  const mergeState = src.merge_state_status;
  if (mergeState == null || mergeState === "") return "not-ready";
  return String(mergeState).toLowerCase() === "clean" ? "ready" : "blocked-merge-state";
}

/**
 * The merge-BLOCKER taxonomy for a PR-bearing slice: the dominant reason it is not
 * merging, in babysit's own dispatch precedence (conflict → review threads →
 * conversation comments → CI). This COMPLEMENTS {@link mergeReadiness} rather than
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
 *  :eyes: ack yet (mirrors `commentsNeedingResponse`, inlined to keep this pure
 *  module free of a messages.ts dependency). */
function owesCommentResponse(pr: any): boolean {
  const comments = pr?.conversation_comments;
  return Array.isArray(comments) && comments.some((c: any) => c && c.reacted_eyes !== true);
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
  if (owesCommentResponse(src)) return "owes_comments";
  if (src.checks === "FAIL") return "ci_failing";
  return "none";
}

/**
 * Stamp `slice.steward_awaiting_input` on every slice from its live worker session
 * status — a pure SESSION-state signal, decoupled from GitHub/PR state. A steward
 * whose session is parked in `waiting` status is blocked needing input (a Claude
 * permission prompt, or a question it asked) and cannot self-progress; the
 * legate-agent/human path that would answer it isn't built yet, so we surface it
 * for an operator to find (the session id + worktree ride in /escalations) and
 * unblock. Call once per tick on the working slices before
 * {@link summarizeSlicesByStage} so the gauge + endpoint read the current value.
 */
export function stampStewardAwaitingInput(
  slices: Record<string, any> | undefined,
  sessions: any,
  workerGroup: string,
): void {
  const workers = workerBySessionId(sessions, workerGroup);
  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    const sid = String(slice.worker_session_id || "");
    const worker = sid ? workers.get(sid) : undefined;
    slice.steward_awaiting_input = !!worker && worker.status === "waiting";
  }
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
  let stewardsAwaitingInput = 0;
  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    if (slice.steward_awaiting_input === true) stewardsAwaitingInput++;
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
  return { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState, escalatedByReason, prBlocker, stewardsAwaitingInput };
}
