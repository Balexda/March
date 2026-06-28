/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { deriveUnescalateStage, unescalate, unescalateStep } from "./unescalate.js";

describe("deriveUnescalateStage", () => {
  it("returns pr-open with a live PR, else implementing", () => {
    expect(deriveUnescalateStage({ pr: { number: 9 } })).toBe("pr-open");
    expect(deriveUnescalateStage({ pr: { number: 0 } })).toBe("implementing");
    expect(deriveUnescalateStage({})).toBe("implementing");
    expect(deriveUnescalateStage(undefined)).toBe("implementing");
  });
});

describe("unescalate", () => {
  it("moves the slice to the working stage and clears the escalation latches", () => {
    const slice: any = {
      stage: "escalated",
      escalated_reason: "steward_stuck",
      steward_awaiting_input_at: "t-1",
      steward_stuck_at: "t-2",
      steward_stuck_head_sha: "abc",
      pr: { number: 9 },
      worktree_path: "/wt/a",
      branch: "feature/a",
    };
    const changed = unescalate(slice, "pr-open", "T", "note");
    expect(changed).toBe(true);
    expect(slice.stage).toBe("pr-open");
    expect(slice.escalated_reason).toBeUndefined();
    expect(slice.steward_awaiting_input_at).toBeUndefined();
    expect(slice.steward_stuck_at).toBeUndefined();
    expect(slice.steward_stuck_head_sha).toBeUndefined();
    expect(slice.last_action).toBe("T");
    expect(slice.last_action_note).toBe("note");
    // Non-destructive: the PR / branch / worktree are preserved.
    expect(slice.pr).toEqual({ number: 9 });
    expect(slice.worktree_path).toBe("/wt/a");
    expect(slice.branch).toBe("feature/a");
  });

  it("reports no stage change when already at the target stage (idempotent)", () => {
    const slice: any = { stage: "pr-open", escalated_reason: undefined };
    expect(unescalate(slice, "pr-open", "T", "note")).toBe(false);
    expect(slice.stage).toBe("pr-open");
  });
});

describe("unescalateStep contract", () => {
  it("is a non-destructive step (safe for the automatic self-heal path)", () => {
    expect(unescalateStep).toEqual({ name: "unescalate", destructive: false });
  });
});
