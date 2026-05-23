import { describe, expect, it } from "vitest";
import { recentActionEventLines } from "./replay.js";

const jsonl = (...events: any[]) => events.map((e) => JSON.stringify(e)).join("\n");

describe("recentActionEventLines", () => {
  it("returns no lines for empty / whitespace input", () => {
    expect(recentActionEventLines("")).toEqual([]);
    expect(recentActionEventLines("   \n  ")).toEqual([]);
  });

  it("drops malformed lines and unknown kinds", () => {
    const raw = [
      "{not json}",
      JSON.stringify({ kind: "heartbeat", ts: "T" }), // not replayable
      JSON.stringify({ kind: "dispatch_action", ts: "T", slice_id: "s", detail: "queued" }),
    ].join("\n");
    expect(recentActionEventLines(raw)).toEqual(["[T] recent action: dispatch s: queued"]);
  });

  it("keeps only the last `limit` replayable events, in log order", () => {
    const raw = jsonl(
      { kind: "dispatch_action", ts: "1", slice_id: "a", detail: "x" },
      { kind: "dispatch_action", ts: "2", slice_id: "b", detail: "y" },
      { kind: "dispatch_action", ts: "3", slice_id: "c", detail: "z" },
    );
    const lines = recentActionEventLines(raw, 2);
    expect(lines).toEqual([
      "[2] recent action: dispatch b: y",
      "[3] recent action: dispatch c: z",
    ]);
  });

  it("formats each replayable kind with the 'recent action: ' prefix", () => {
    const raw = jsonl(
      { kind: "cleanup", ts: "T", slice_id: "s", pr_number: 1, pr_state: "MERGED", session_id: "sess" },
      { kind: "cleanup_failure", ts: "T", slice_id: "s", error: "boom" },
      { kind: "babysit_action", ts: "T", action: "nudge", slice_id: "s", pr_number: 2, detail: "d" },
      { kind: "recovery_dispatch", ts: "T", slice_id: "s", detail: "re" },
      { kind: "slice_recovery", ts: "T", slice_id: "s", detail: "operator recovery: cleared escalated slice for fresh re-dispatch" },
      { kind: "processor_request", ts: "T", slice_id: "s", reason: "needs review" },
    );
    expect(recentActionEventLines(raw)).toEqual([
      "[T] recent action: cleaned up s PR #1 MERGED: removed session sess, pruned worktree",
      "[T] recent action: cleanup failed s: boom",
      "[T] recent action: babysit nudge s PR #2: d",
      "[T] recent action: recovery-dispatch s: re",
      "[T] recent action: slice-recovery s: operator recovery: cleared escalated slice for fresh re-dispatch",
      "[T] recent action: requested legate judgement for s: needs review",
    ]);
  });
});
