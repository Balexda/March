import { describe, expect, it } from "vitest";
import {
  bumpRetry,
  parseSessionCollisionError,
  parseSpawnPatchError,
  parseWrongWorktreeRaceError,
  transientRetryCounts,
  type RetryCounts,
} from "./recovery.js";

describe("parseSessionCollisionError", () => {
  it("extracts a uuid-suffixed session id from the agent-deck collision message", () => {
    expect(
      parseSessionCollisionError("session already exists: my title (abc123-7)"),
    ).toBe("abc123-7");
  });

  it("extracts a non-uuid trailing parenthetical id", () => {
    expect(
      parseSessionCollisionError("session already exists: my title (sess-xyz)"),
    ).toBe("sess-xyz");
  });

  it("is case-insensitive on the marker", () => {
    expect(
      parseSessionCollisionError("Session Already Exists: t (deadbeef-1)"),
    ).toBe("deadbeef-1");
  });

  it("returns null when the error is not a session collision", () => {
    expect(parseSessionCollisionError("fatal: a branch named 'x' already exists")).toBeNull();
    expect(parseSessionCollisionError("")).toBeNull();
    expect(parseSessionCollisionError(null)).toBeNull();
    expect(parseSessionCollisionError(undefined)).toBeNull();
  });
});

describe("parseWrongWorktreeRaceError", () => {
  it("matches the launch-race refusal contract", () => {
    const msg =
      'agent-deck manager session "worker-3" attached to worktree "/wt/feature-a" but this launch requested branch feature/b';
    expect(parseWrongWorktreeRaceError(msg)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(parseWrongWorktreeRaceError("session already exists: t (x-1)")).toBe(false);
    expect(parseWrongWorktreeRaceError("git apply --index failed")).toBe(false);
    expect(parseWrongWorktreeRaceError(null)).toBe(false);
  });
});

describe("parseSpawnPatchError", () => {
  it("matches the three codex patch-failure shapes", () => {
    expect(parseSpawnPatchError("git apply --index failed")).toBe(true);
    expect(parseSpawnPatchError("error: corrupt patch at line 42")).toBe(true);
    expect(parseSpawnPatchError("error: foo.ts: already exists in index")).toBe(true);
  });

  it("returns false for non-patch errors", () => {
    expect(parseSpawnPatchError("branch already exists")).toBe(false);
    expect(parseSpawnPatchError("")).toBe(false);
    expect(parseSpawnPatchError(undefined)).toBe(false);
  });
});

describe("transientRetryCounts", () => {
  it("creates the counts object when absent and returns the same reference", () => {
    const state: { transient_retry_counts?: unknown } = {};
    const counts = transientRetryCounts(state);
    expect(counts).toEqual({});
    expect(state.transient_retry_counts).toBe(counts);
    // Idempotent: returns the existing object on subsequent calls.
    counts["k"] = 2;
    expect(transientRetryCounts(state)).toBe(counts);
  });

  it("replaces a non-object value with a fresh map", () => {
    const state = { transient_retry_counts: "corrupt" as unknown };
    const counts = transientRetryCounts(state);
    expect(counts).toEqual({});
  });
});

describe("bumpRetry", () => {
  it("counts attempts up to the limit, persisting each on the counts map", () => {
    const counts: RetryCounts = {};
    expect(bumpRetry(counts, "slice-1", 3)).toEqual({ exhausted: false, count: 1 });
    expect(counts["slice-1"]).toBe(1);
    expect(bumpRetry(counts, "slice-1", 3)).toEqual({ exhausted: false, count: 2 });
    expect(bumpRetry(counts, "slice-1", 3)).toEqual({ exhausted: false, count: 3 });
    expect(counts["slice-1"]).toBe(3);
  });

  it("reports exhaustion and clears the key once the count exceeds the limit", () => {
    const counts: RetryCounts = { "slice-1": 3 };
    expect(bumpRetry(counts, "slice-1", 3)).toEqual({ exhausted: true, count: 4 });
    expect(counts["slice-1"]).toBeUndefined();
  });

  it("treats a missing or non-finite prior count as zero", () => {
    const counts: RetryCounts = { bad: Number.NaN as unknown as number };
    expect(bumpRetry(counts, "bad", 2)).toEqual({ exhausted: false, count: 1 });
    expect(bumpRetry(counts, "fresh", 2)).toEqual({ exhausted: false, count: 1 });
  });

  it("keeps per-key budgets independent", () => {
    const counts: RetryCounts = {};
    bumpRetry(counts, "a", 5);
    bumpRetry(counts, "a", 5);
    bumpRetry(counts, "b", 5);
    expect(counts).toEqual({ a: 2, b: 1 });
  });
});
