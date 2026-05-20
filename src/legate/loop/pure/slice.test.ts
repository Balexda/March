import { describe, expect, it } from "vitest";
import {
  alreadyArchivedSlice,
  blockingMergedArchive,
  inFlightSliceMatches,
  isStubArchivedSlice,
  isTerminalSlice,
  sliceReleasesArtifact,
} from "./slice.js";

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

  void ITEM_BRANCH;
});
