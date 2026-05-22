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

/** Per-stage slice tally plus the derived ready-to-merge count (#220). */
export interface SliceStageSummary {
  /** Count of non-archived slices keyed by lifecycle `stage` (a metric label). */
  readonly byStage: Record<string, number>;
  /** Slices `pr-open` with passing checks, no conflicts, and no threads owed. */
  readonly readyToMerge: number;
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
  let readyToMerge = 0;
  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    const raw = typeof slice.stage === "string" ? slice.stage : "";
    const stage = STAGE_ALLOWLIST.has(raw) ? raw : OTHER_STAGE;
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    if (stage === "pr-open" && slice.pr?.checks === "PASS" && slice.pr?.mergeable !== "CONFLICTING") {
      // Require an explicit 0 — undefined (e.g. post-cold-start, before babysit
      // re-derives it) is "unknown thread debt", not "no threads owed".
      const owed = slice.needs_response_count ?? slice.pr?.needs_response_count;
      if (owed === 0) readyToMerge++;
    }
  }
  return { byStage, readyToMerge };
}
