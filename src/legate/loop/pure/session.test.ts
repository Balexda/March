import { describe, expect, it } from "vitest";
import {
  addBranchVariants,
  isWorkerSession,
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
