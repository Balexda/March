/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  alreadyArchivedSlice,
  blockingMergedArchive,
  createSpawnBudget,
  DISPATCH_RECOVERY_LIMIT,
  dispatchableReady,
  escalatedRecoverable,
  inFlightSliceMatches,
  isReadyToMerge,
  isStubArchivedSlice,
  isTerminalSlice,
  liveSpawnCount,
  recoverableEscalations,
  recoveryAttemptKey,
  recoveryBudgetExhausted,
  sliceReleasesArtifact,
  summarizeSlicesByStage,
  mergeReadiness,
} from "./slice.js";
import { dispatchSliceId } from "./dispatch-id.js";

const item = {
  path: "docs/x.tasks.md",
  next_action: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"] },
};
// branch/key the matchers compute for `item`:
const ITEM_BRANCH = "smithy/forge/docs-x-tasks-md-forge"; // legacy-hash path may vary; not asserted directly

describe("spawn cap helpers (#313)", () => {
  it("liveSpawnCount counts only non-terminal slices (pipeline-occupying spawns)", () => {
    const slices = {
      a: { stage: "hatchery-pending" },
      b: { stage: "implementing" },
      c: { stage: "pr-open" },
      d: { stage: "pr-in-fix" },
      e: { stage: "pr-resolving-conflicts" },
      // terminal — must NOT count:
      f: { stage: "merged" },
      g: { stage: "escalated" },
      h: { pr: { state: "CLOSED" } },
      i: { pr: { state: "MERGED" } },
    };
    expect(liveSpawnCount({ slices })).toBe(5);
  });

  it("liveSpawnCount is 0 for empty/missing state", () => {
    expect(liveSpawnCount({ slices: {} })).toBe(0);
    expect(liveSpawnCount({})).toBe(0);
    expect(liveSpawnCount(null)).toBe(0);
  });

  it("liveSpawnCount excludes waiting-to-merge but counts active stewards", () => {
    const slices = {
      // active spawn + active steward → count
      spawn: { stage: "implementing" },
      stewardOwed: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 2 },
      stewardConflict: { stage: "pr-open", pr: { checks: "PASS", mergeable: "CONFLICTING" }, needs_response_count: 0 },
      stewardChecks: { stage: "pr-open", pr: { checks: "FAIL", mergeable: "MERGEABLE" }, needs_response_count: 0 },
      // waiting for merge (all-clear) → does NOT count
      waiting: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 0 },
      // unknown thread debt (e.g. post-cold-start) is treated as active → counts
      unknownDebt: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" } },
    };
    // spawn + 3 stewards + unknownDebt = 5; only `waiting` is released.
    expect(liveSpawnCount({ slices })).toBe(5);
  });

  it("isReadyToMerge matches the dashboard's waiting-for-merge gate", () => {
    const clear = { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 0 };
    expect(isReadyToMerge(clear)).toBe(true);
    expect(isReadyToMerge({ ...clear, stage: "implementing" })).toBe(false); // not pr-open
    expect(isReadyToMerge({ ...clear, pr: { checks: "FAIL", mergeable: "MERGEABLE" } })).toBe(false); // checks
    expect(isReadyToMerge({ ...clear, pr: { checks: "PASS", mergeable: "CONFLICTING" } })).toBe(false); // conflict
    expect(isReadyToMerge({ ...clear, needs_response_count: 1 })).toBe(false); // threads owed
    expect(isReadyToMerge({ stage: "pr-open", pr: { checks: "PASS" } })).toBe(false); // unknown debt → not ready
    expect(isReadyToMerge(null)).toBe(false);
  });

  it("createSpawnBudget seeds remaining = max(0, cap − live) and retains cap/live", () => {
    expect(createSpawnBudget(10, 0)).toEqual({ cap: 10, live: 0, remaining: 10, deferred: 0 });
    expect(createSpawnBudget(10, 7)).toEqual({ cap: 10, live: 7, remaining: 3, deferred: 0 });
    // live ≥ cap → fully throttled, never negative.
    expect(createSpawnBudget(10, 10)).toEqual({ cap: 10, live: 10, remaining: 0, deferred: 0 });
    expect(createSpawnBudget(10, 14)).toEqual({ cap: 10, live: 14, remaining: 0, deferred: 0 });
  });
});

describe("slice pure helpers", () => {
  it("isTerminalSlice covers merged/escalated stages + terminal PR states", () => {
    expect(isTerminalSlice({ stage: "merged" })).toBe(true);
    expect(isTerminalSlice({ stage: "escalated" })).toBe(true);
    expect(isTerminalSlice({ pr: { state: "CLOSED" } })).toBe(true);
    expect(isTerminalSlice({ stage: "implementing" })).toBe(false);
    expect(isTerminalSlice(null)).toBe(true);
  });

  it("sliceReleasesArtifact is true only for MERGED (not escalated/closed)", () => {
    expect(sliceReleasesArtifact({ stage: "merged" })).toBe(true);
    expect(sliceReleasesArtifact({ pr: { state: "MERGED" } })).toBe(true);
    expect(sliceReleasesArtifact({ stage: "escalated" })).toBe(false);
    expect(sliceReleasesArtifact({ pr: { state: "CLOSED" } })).toBe(false);
  });

  it("treats command-less, branch-less archive entries as stubs", () => {
    expect(isStubArchivedSlice({})).toBe(true);
    expect(isStubArchivedSlice({ command: "smithy.forge" })).toBe(false);
    expect(isStubArchivedSlice({ branch: "smithy/x" })).toBe(false);
  });

  it("alreadyArchivedSlice matches by action key, ignoring stubs at the same id", () => {
    // stub at the exact id does NOT block
    const stubState = { archived_slices: { [`stub`]: {} } };
    expect(alreadyArchivedSlice(stubState, item, "stub")).toBe(false);
    // a real archive with the same action key blocks
    const realState = {
      archived_slices: {
        other: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" },
      },
    };
    expect(alreadyArchivedSlice(realState, item, "whatever")).toBe(true);
  });

  it("inFlightSliceMatches: same id, recovery original, or action key — but MERGED releases", () => {
    expect(inFlightSliceMatches({ slices: { sid: { stage: "implementing" } } }, item, "sid")).toBe(true);
    expect(
      inFlightSliceMatches({ slices: { r1: { original_slice_id: "sid", stage: "implementing" } } }, item, "sid"),
    ).toBe(true);
    // a MERGED live slice releases the artifact → does not count as in-flight
    const merged = {
      slices: { m: { stage: "merged", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" } },
    };
    expect(inFlightSliceMatches(merged, item, "sid")).toBe(false);
  });

  it("blockingMergedArchive returns a MERGED collision, null otherwise", () => {
    const mergedArchive = {
      archived_slices: {
        a: { terminal_state: "MERGED", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" },
      },
    };
    expect(blockingMergedArchive(mergedArchive, item, "x")).toBeTruthy();
    const escalatedArchive = {
      archived_slices: {
        a: { terminal_state: "ESCALATED", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" },
      },
    };
    expect(blockingMergedArchive(escalatedArchive, item, "x")).toBeNull();
  });

  it("dispatchableReady drops ready items already in-flight or archived (#219)", () => {
    // No live/archived slices → the item is fresh-dispatchable.
    expect(dispatchableReady({ slices: {}, archived_slices: {} }, [item])).toEqual([item]);
    // An in-flight (implementing) slice matching the item's action key → not dispatchable.
    const inFlight = {
      slices: { s: { stage: "implementing", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" } },
      archived_slices: {},
    };
    expect(dispatchableReady(inFlight, [item])).toEqual([]);
    // An escalated slice still holds the artifact (not MERGED) → not dispatchable.
    const escalated = {
      slices: { s: { stage: "escalated", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" } },
      archived_slices: {},
    };
    expect(dispatchableReady(escalated, [item])).toEqual([]);
    expect(dispatchableReady({}, undefined)).toEqual([]);
  });

  it("summarizeSlicesByStage tallies by stage and tallies the merge_gate 3-way (#220)", () => {
    // The summary reads the merge_gate stamp babysit writes from the live PR — it
    // does NOT recompute, so each pr-open slice carries its verdict directly.
    const slices = {
      a: { stage: "hatchery-pending" },
      b: { stage: "implementing" },
      c: { stage: "pr-open", merge_gate: "ready" }, // loop will merge now
      d: { stage: "pr-open", merge_gate: "waiting-approval" }, // human gate
      e: { stage: "pr-open", merge_gate: "blocked-merge-state" }, // GitHub won't merge yet
      f: { stage: "pr-open", merge_gate: "not-ready" }, // checks pending / threads owed
      g: { stage: "escalated" },
    };
    const { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState } = summarizeSlicesByStage(slices);
    expect(byStage).toEqual({
      "hatchery-pending": 1,
      implementing: 1,
      "pr-open": 4,
      "pr-in-fix": 0,
      "pr-resolving-conflicts": 0,
      escalated: 1,
    });
    expect(Object.values(byStage).reduce((a, b) => a + b, 0)).toBe(Object.keys(slices).length);
    expect(readyToMerge).toBe(1); // c
    expect(waitingOnApproval).toBe(1); // d
    expect(blockedOnMergeState).toBe(1); // e
  });

  it("summarizeSlicesByStage buckets unknown stages; an unstamped pr-open counts in no merge bucket", () => {
    const slices = {
      typo: { stage: "implmenting" }, // typo / unexpected stage → 'other', not a new series
      merged: { stage: "merged" }, // transient terminal stage → 'other'
      // pr-open with no merge_gate yet (cold start, not re-snapshotted) → counted
      // in pr-open but in none of the merge buckets until babysit stamps it.
      cold: { stage: "pr-open" },
      ready: { stage: "pr-open", merge_gate: "ready" },
    };
    const { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState } = summarizeSlicesByStage(slices);
    expect(byStage.other).toBe(2); // typo + merged bucketed together
    expect(byStage).not.toHaveProperty("implmenting");
    expect(byStage).not.toHaveProperty("merged");
    expect(byStage["pr-open"]).toBe(2);
    expect(readyToMerge).toBe(1);
    expect(waitingOnApproval).toBe(0);
    expect(blockedOnMergeState).toBe(0); // `cold` is unstamped → no bucket
  });

  it("mergeReadiness is a 3-way over the LIVE pr, honoring the per-task-type merge policy", () => {
    const slice = { stage: "pr-open", branch: "feature/smithy/cut/x" };
    const clearPr = { checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 0, merge_state_status: "clean" };
    // Default policy requires approval → unapproved cut PR waits on approval.
    expect(mergeReadiness("x-cut", slice, clearPr, undefined)).toBe("waiting-approval");
    // Policy drops approval for `cut` + clean merge state → ready (loop merges).
    const policy = { byTaskType: { cut: { approval: false } } } as any;
    expect(mergeReadiness("x-cut", slice, clearPr, policy)).toBe("ready");
    // Approval relaxed but GitHub merge-state not clean → blocked-merge-state.
    expect(mergeReadiness("x-cut", slice, { ...clearPr, merge_state_status: "BEHIND" }, policy)).toBe("blocked-merge-state");
    // A changes-requested review blocks on the human gate even when approval is relaxed.
    expect(mergeReadiness("x-cut", slice, { ...clearPr, changes_requested_count: 1 }, policy)).toBe("waiting-approval");
    // Not all-clear (failing checks / threads owed / wrong stage) → not-ready.
    expect(mergeReadiness("x-cut", slice, { ...clearPr, checks: "FAIL" }, policy)).toBe("not-ready");
    expect(mergeReadiness("x-cut", slice, { ...clearPr, needs_response_count: 2 }, policy)).toBe("not-ready");
    expect(mergeReadiness("x-cut", { stage: "implementing" }, clearPr, policy)).toBe("not-ready");
  });

  it("summarizeSlicesByStage splits escalated by reason (spawn-failed vs stuck)", () => {
    const slices = {
      a: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed" }, // spawn failed
      b: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed" },
      c: { stage: "escalated", escalated_reason: "needs_human_judgement" }, // steward stuck
      d: { stage: "escalated", escalated_reason: "some_future_reason" }, // unknown → other
      e: { stage: "escalated" }, // no reason → other
      f: { stage: "implementing" }, // not escalated → not counted
    };
    const { byStage, escalatedByReason } = summarizeSlicesByStage(slices);
    expect(escalatedByReason.hatchery_dispatch_failed).toBe(2);
    expect(escalatedByReason.needs_human_judgement).toBe(1);
    expect(escalatedByReason.other).toBe(2); // unknown reason + missing reason
    // Pre-seeded reasons report 0 (stable series), not absent.
    expect(escalatedByReason.real_spawn_error).toBe(0);
    // The reason split sums to the escalated stage tally.
    const reasonSum = Object.values(escalatedByReason).reduce((a, b) => a + b, 0);
    expect(reasonSum).toBe(byStage.escalated);
    expect(reasonSum).toBe(5);
  });

  it("summarizeSlicesByStage pre-seeds all stages to 0 for an empty slice set", () => {
    expect(summarizeSlicesByStage(undefined)).toEqual({
      byStage: {
        "hatchery-pending": 0,
        implementing: 0,
        "pr-open": 0,
        "pr-in-fix": 0,
        "pr-resolving-conflicts": 0,
        escalated: 0,
      },
      readyToMerge: 0,
      waitingOnApproval: 0,
      blockedOnMergeState: 0,
      escalatedByReason: {
        hatchery_dispatch_failed: 0,
        needs_human: 0,
        needs_human_judgement: 0,
        real_spawn_error: 0,
        other: 0,
      },
    });
  });

  void ITEM_BRANCH;
});

describe("recoverableEscalations (#211 bounded auto-recovery)", () => {
  const SID = dispatchSliceId(item);
  const recoverableSlice = () => ({
    stage: "escalated",
    escalated_reason: "hatchery_dispatch_failed",
    command: "smithy.forge",
    arguments: ["docs/x.tasks.md", "1"],
    artifact_path: "docs/x.tasks.md",
  });

  it("escalatedRecoverable is true only for the recoverable allowlist", () => {
    expect(escalatedRecoverable(recoverableSlice())).toBe(true);
    expect(escalatedRecoverable({ stage: "escalated", escalated_reason: "needs_human" })).toBe(false);
    expect(escalatedRecoverable({ stage: "implementing", escalated_reason: "hatchery_dispatch_failed" })).toBe(false);
    expect(escalatedRecoverable(null)).toBe(false);
  });

  it("selects a ready item wedged behind a recoverable escalation, attempt = used+1", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: {} };
    expect(recoverableEscalations(state, [item])).toEqual([
      { item, sliceId: SID, attempt: 1, limit: DISPATCH_RECOVERY_LIMIT },
    ]);
  });

  it("counts the existing budget: a prior attempt yields attempt 2", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: { [recoveryAttemptKey(SID)]: 1 } };
    expect(recoverableEscalations(state, [item])[0]).toMatchObject({ attempt: 2 });
  });

  it("stops at the budget — no decision once the limit is reached", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: { [recoveryAttemptKey(SID)]: DISPATCH_RECOVERY_LIMIT } };
    expect(recoverableEscalations(state, [item])).toEqual([]);
  });

  it("ignores a non-recoverable escalation reason", () => {
    const state = { slices: { [SID]: { ...recoverableSlice(), escalated_reason: "real_spawn_error" } }, archived_slices: {}, transient_retry_counts: {} };
    expect(recoverableEscalations(state, [item])).toEqual([]);
  });

  it("does not fight a terminal archive that also blocks the item", () => {
    const state = {
      slices: { [SID]: recoverableSlice() },
      archived_slices: { [SID]: { terminal_state: "MERGED", command: "smithy.forge", branch: "x" } },
      transient_retry_counts: {},
    };
    expect(recoverableEscalations(state, [item])).toEqual([]);
  });

  it("disjoint from dispatchableReady: the escalated item is never both", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: {} };
    expect(dispatchableReady(state, [item])).toEqual([]);
    expect(recoverableEscalations(state, [item])).toHaveLength(1);
  });

  it("recoveryBudgetExhausted flips only at/over the limit", () => {
    expect(recoveryBudgetExhausted({ transient_retry_counts: {} }, "x")).toBe(false);
    expect(recoveryBudgetExhausted({ transient_retry_counts: { [recoveryAttemptKey("x")]: 0 } }, "x")).toBe(false);
    expect(recoveryBudgetExhausted({ transient_retry_counts: { [recoveryAttemptKey("x")]: DISPATCH_RECOVERY_LIMIT - 1 } }, "x")).toBe(false);
    expect(recoveryBudgetExhausted({ transient_retry_counts: { [recoveryAttemptKey("x")]: DISPATCH_RECOVERY_LIMIT } }, "x")).toBe(true);
  });
});
