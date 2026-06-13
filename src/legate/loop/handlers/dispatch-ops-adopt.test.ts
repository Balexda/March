/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import type { DispatchIoDeps } from "./dispatch-io.js";
import { completePendingHatcheryDispatches, launchDispatch } from "./dispatch-ops.js";

// #173: the legate adopts a slice's own open PR on a branch-collision instead of
// escalating. This is a FOLD READ — Herald observes the open PR on the slice's
// branch (including escalated slices, src/observe/sense-io.ts + state/sense.ts)
// and emits slice.pr.changed; the legate reads slice.pr from the folded state. No
// gh from the loop, so these tests set slice.pr directly rather than mocking a
// discovery call.

// The exact error hatchery's #245 self-heal surfaces when it refuses to delete a
// branch that still has an open PR (unsafe: open-pr).
const COLLISION =
  "Castra session launch failed: agent-deck launch failed:\n  Error: branch " +
  "'feature/foo' already exists\nOrphan branch was NOT auto-removed: unsafe to remove (open-pr).";

// A babysit-shaped PR snapshot, as Herald folds it into slice.pr.
const PR = {
  number: 240,
  url: "https://github.com/o/r/pull/240",
  state: "OPEN",
  head_branch: "feature/foo",
  checks: "PASS",
  title: "feat: foo",
};

function deps(over: Partial<DispatchIoDeps> = {}): DispatchIoDeps {
  return {
    meta: { profile: "prof", worker_group: "wg", repo: { path: "/repo" }, processor_name: "proc", paired_legate: "leg" },
    emitTransition: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
    postSpawn: vi.fn(async () => ({ id: "job-1" })),
    getJob: vi.fn(async () => ({ status: "running" })),
    ...over,
  };
}

const item = (over: any = {}) => ({
  path: "specs/a.spec.md",
  next_action: { command: "smithy.forge", arguments: ["specs/a.spec.md", "1"] },
  ...over,
});

const transitionsOf = (d: DispatchIoDeps) => (d.emitTransition as any).mock.calls.map((c: any[]) => c[0]);
const recordsOf = (d: DispatchIoDeps) => (d.emit as any).mock.calls.map((c: any[]) => c[0]);

describe("launchDispatch branch-collision adopt (#173, fold read)", () => {
  it("adopts the slice's Herald-observed open PR on a collision and preserves it across the re-create", async () => {
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error(COLLISION); }) });
    // Herald already observed the open PR on this escalated slice's branch (folded
    // onto the prior incarnation). launchDispatch must carry it across the re-create
    // so the collision catch can read it.
    const state: any = { slices: { s: { stage: "escalated", branch: "feature/foo", pr: PR } } };
    const out = await launchDispatch(state, "T", item(), "s", d);

    expect(state.slices.s.stage).toBe("pr-open");
    expect(state.slices.s.pr.number).toBe(240); // survived the hatchery-pending re-create
    expect(state.slices.s.escalated_reason).toBeUndefined();
    const transitions = transitionsOf(d);
    expect(transitions.find((t: any) => t.type === "slice.escalated")).toBeFalsy();
    expect(transitions.find((t: any) => t.type === "slice.stage.changed")?.stage).toBe("pr-open");
    // The legate does NOT re-emit slice.pr.changed — Herald owns that event class.
    expect(transitions.find((t: any) => t.type === "slice.pr.changed")).toBeFalsy();
    expect(out.actions.find((a: any) => a.action === "adopt-pr")?.detail).toContain("adopted existing open PR");
    expect(out.notifications).toHaveLength(0);
    expect(recordsOf(d).find((r: any) => r.kind === "dispatch_failure")).toBeFalsy();
  });

  it("escalates (the eventual-consistency window) when Herald has not observed the PR yet", async () => {
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error(COLLISION); }) });
    // Fresh slice — no observed PR in the fold yet → slice.pr is null → no adopt.
    const state: any = { slices: {} };
    await launchDispatch(state, "T", item(), "s", d);
    expect(state.slices.s.stage).toBe("escalated");
    expect(transitionsOf(d).find((t: any) => t.type === "slice.escalated")?.reason).toBe("hatchery_dispatch_failed");
  });

  it("does not adopt when the failure is not a branch-collision, even with a known PR", async () => {
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }) });
    const state: any = { slices: { s: { stage: "escalated", branch: "feature/foo", pr: PR } } };
    await launchDispatch(state, "T", item(), "s", d);
    expect(state.slices.s.stage).toBe("escalated");
  });
});

describe("completePendingHatcheryDispatches branch-collision adopt (#173, fold read)", () => {
  const pending = (over: any = {}) => ({
    stage: "hatchery-pending",
    command: "smithy.forge",
    arguments: ["a", "1"],
    hatchery: { backend: "codex", job_id: "job-1" },
    worker_session_id: null,
    pr: null,
    ...over,
  });

  it("adopts when the background spawn collides and the fold carries the open PR", async () => {
    const d = deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: COLLISION } })) });
    const state: any = { slices: { s: pending({ pr: PR }) } };
    const out = await completePendingHatcheryDispatches(state, "T", d);
    expect(state.slices.s.stage).toBe("pr-open");
    expect(transitionsOf(d).find((t: any) => t.type === "slice.escalated")).toBeFalsy();
    expect(transitionsOf(d).find((t: any) => t.type === "slice.pr.changed")).toBeFalsy();
    expect(out.actions.find((a: any) => a.action === "adopt-pr")).toBeTruthy();
  });

  it("escalates (the eventual-consistency window) when the fold has not observed the PR yet", async () => {
    const d = deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: COLLISION } })) });
    const state: any = { slices: { s: pending({ pr: null }) } };
    await completePendingHatcheryDispatches(state, "T", d);
    expect(state.slices.s.stage).toBe("escalated");
  });

  it("still escalates a background-spawn failure that is not a branch-collision", async () => {
    const d = deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: "git apply --index failed" } })) });
    const state: any = { slices: { s: pending({ pr: PR }) } };
    await completePendingHatcheryDispatches(state, "T", d);
    expect(state.slices.s.stage).toBe("escalated");
  });

  it("carries the steward sessionId on the adopt stage transition when the fold knows it", async () => {
    const d = deps({ getJob: vi.fn(async () => ({ status: "failed", error: { message: COLLISION } })) });
    const state: any = { slices: { s: pending({ pr: PR, worker_session_id: "sess-7" }) } };
    await completePendingHatcheryDispatches(state, "T", d);
    expect(transitionsOf(d).find((t: any) => t.type === "slice.stage.changed")?.sessionId).toBe("sess-7");
  });
});
