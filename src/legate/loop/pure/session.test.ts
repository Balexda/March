/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  addBranchVariants,
  isWorkerSession,
  looseSessionMatch,
  prMatchesBranches,
  prNumber,
  sessionMatchesSlice,
  summarizeWorkers,
  workerBySessionId,
} from "./session.js";

describe("session pure helpers", () => {
  it("classifies worker sessions by group (exact or sub-group)", () => {
    expect(isWorkerSession({ group: "legate-workers" }, "legate-workers")).toBe(true);
    expect(isWorkerSession({ group: "legate-workers/sub" }, "legate-workers")).toBe(true);
    expect(isWorkerSession({ group: "other" }, "legate-workers")).toBe(false);
  });

  it("matches a session to a slice by id/title/name", () => {
    expect(sessionMatchesSlice({ id: "s1" }, { worker_session_id: "s1" })).toBe(true);
    expect(sessionMatchesSlice({ title: "s1" }, { worker_session_id: "s1" })).toBe(true);
    expect(sessionMatchesSlice({ id: "x" }, { worker_session_id: "s1" })).toBe(false);
    expect(sessionMatchesSlice({ id: "x" }, {})).toBe(false);
  });

  it("loosely matches a session to a slice by worktree, branch variants, or title (#210 gate)", () => {
    // Worktree match.
    expect(
      looseSessionMatch({ worktree_path: "/wt/a" }, { worktree_path: "/wt/a" }),
    ).toBe(true);
    // Branch match, including the feature/ variant the steward actually runs on.
    expect(
      looseSessionMatch({ branch: "feature/smithy/x" }, { branch: "smithy/x" }),
    ).toBe(true);
    expect(
      looseSessionMatch({ branch: "smithy/x" }, { branch: "feature/smithy/x" }),
    ).toBe(true);
    // Title/name equal to the slice id.
    expect(looseSessionMatch({ title: "slice-7" }, { sliceId: "slice-7" })).toBe(true);
    expect(looseSessionMatch({ name: "slice-7" }, { sliceId: "slice-7" })).toBe(true);
    // No common signal → no match (and empties never cross-match).
    expect(looseSessionMatch({ branch: "other" }, { branch: "smithy/x" })).toBe(false);
    expect(looseSessionMatch({ worktree_path: "" }, { worktree_path: "" })).toBe(false);
    expect(looseSessionMatch({}, { sliceId: "" })).toBe(false);
  });

  it("matches the #264 legacy slice once Castra populates session.branch from git", () => {
    // The exact #173/#240 scenario: a slice with only a branch recorded (no
    // sessionId, no worktree_path) against the live steward whose branch — empty
    // in agent-deck's snapshot — is now derived by Castra from the working dir
    // (`feature/` variant). The legate code is unchanged; this asserts the
    // branch-comparison path "just starts working" once the data is present.
    expect(
      looseSessionMatch(
        {
          branch: "feature/smithy/cut/01-spawn-f5-s2",
          worktree_path: "/home/me/Development/WorkTrees/March/feature-smithy-cut-01-spawn-f5-s2",
        },
        { branch: "smithy/cut/01-spawn-f5-s2", sliceId: "01-spawn-f5-s2-cut" },
      ),
    ).toBe(true);
  });

  it("summarizes workers by status, bucketing unknowns to other", () => {
    const list = [
      { group: "legate-workers", status: "running" },
      { group: "legate-workers", status: "idle" },
      { group: "legate-workers", status: "weird" },
      { group: "elsewhere", status: "running" }, // excluded (wrong group)
    ];
    expect(summarizeWorkers(list, "legate-workers")).toMatchObject({ running: 1, idle: 1, other: 1 });
  });

  it("reports unavailable when the list is an error object", () => {
    expect(summarizeWorkers({ error: "down" } as any, "g")).toEqual({ error: "down" });
  });

  it("indexes workers by id, title, and name", () => {
    const map = workerBySessionId([{ group: "g", id: "i", title: "t", name: "n" }], "g");
    expect(map.get("i")).toBeTruthy();
    expect(map.get("t")).toBeTruthy();
    expect(map.get("n")).toBeTruthy();
  });

  it("extracts a positive integer PR number as a string", () => {
    expect(prNumber({ pr: { number: 12 } })).toBe("12");
    expect(prNumber({ pr: { number: "34" } })).toBe("34");
    expect(prNumber({ pr: { number: 0 } })).toBeNull();
    expect(prNumber({})).toBeNull();
  });

  it("expands branch variants and matches PR head branches", () => {
    const branches = new Set<string>();
    addBranchVariants(branches, "refs/heads/feature/x");
    expect(branches.has("feature/x")).toBe(true);
    expect(branches.has("x")).toBe(true);
    expect(prMatchesBranches(branches, { headRefName: "x" })).toBe(true);
    expect(prMatchesBranches(branches, { head_branch: "feature/x" })).toBe(true);
    expect(prMatchesBranches(branches, { headRefName: "other" })).toBe(false);
    expect(prMatchesBranches(new Set(), { headRefName: "x" })).toBe(false);
  });
});
