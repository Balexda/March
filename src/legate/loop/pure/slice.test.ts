import { describe, expect, it } from "vitest";
import {
  alreadyArchivedSlice,
  blockingMergedArchive,
  DISPATCH_RECOVERY_LIMIT,
  dispatchableReady,
  escalatedRecoverable,
  inFlightSliceMatches,
  isStubArchivedSlice,
  isTerminalSlice,
  recoverableEscalations,
  recoveryAttemptKey,
  recoveryBudgetExhausted,
  sliceReleasesArtifact,
  summarizeSlicesByStage,
} from "./slice.js";
import { dispatchSliceId } from "./dispatch-id.js";

const item = {
  path: "docs/x.tasks.md",
  next_action: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"] },
};
// branch/key the matchers compute for `item`:
const ITEM_BRANCH = "smithy/forge/docs-x-tasks-md-forge"; // legacy-hash path may vary; not asserted directly

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

  it("summarizeSlicesByStage tallies by stage and derives ready-to-merge (#220)", () => {
    const slices = {
      a: { stage: "hatchery-pending" },
      b: { stage: "implementing" },
      c: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 0 }, // ready
      d: { stage: "pr-open", pr: { checks: "FAIL", mergeable: "MERGEABLE" }, needs_response_count: 0 }, // failing checks
      e: { stage: "pr-open", pr: { checks: "PASS", mergeable: "CONFLICTING" }, needs_response_count: 0 }, // conflicting
      f: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 2 }, // threads owed
      g: { stage: "escalated" },
    };
    const { byStage, readyToMerge } = summarizeSlicesByStage(slices);
    // All canonical stages are pre-seeded to 0 so empty stages still report 0
    // (not "no data") on the dashboard.
    expect(byStage).toEqual({
      "hatchery-pending": 1,
      implementing: 1,
      "pr-open": 4,
      "pr-in-fix": 0,
      "pr-resolving-conflicts": 0,
      escalated: 1,
    });
    // per-stage tallies sum to the non-archived slice count
    expect(Object.values(byStage).reduce((a, b) => a + b, 0)).toBe(Object.keys(slices).length);
    expect(readyToMerge).toBe(1); // only c qualifies
  });

  it("summarizeSlicesByStage buckets unknown stages and gates unknown thread debt (#220)", () => {
    const slices = {
      typo: { stage: "implmenting" }, // typo / unexpected stage → 'other', not a new series
      merged: { stage: "merged" }, // transient terminal stage → 'other'
      // Cold-start pr-open: pr restored from the fold but the flattened
      // needs_response_count is absent → unknown debt, must NOT count as ready.
      cold: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" } },
      // Same, but the PR snapshot still carries the count → falls back to it.
      nested: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 0 } },
    };
    const { byStage, readyToMerge } = summarizeSlicesByStage(slices);
    expect(byStage.other).toBe(2); // typo + merged bucketed together
    expect(byStage).not.toHaveProperty("implmenting");
    expect(byStage).not.toHaveProperty("merged");
    expect(byStage["pr-open"]).toBe(2);
    expect(readyToMerge).toBe(1); // only `nested` (explicit 0); `cold` is unknown
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
