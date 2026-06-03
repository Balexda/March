import { describe, expect, it, vi } from "vitest";
import type { DispatchIoDeps } from "./dispatch-io.js";
import { completePendingHatcheryDispatches, launchDispatch } from "./dispatch-ops.js";
import { emptySystemState, reduce } from "../../../herald/events.js";

// #173: the legate adopts a slice's own open PR on a branch-collision instead of
// escalating it. Discovery is injected via deps.findOpenPr so these tests never
// shell out; the production fallback (build sense I/O from meta) is covered by the
// branch-variant parity test in observe/sense-io.test.ts.

// The exact error hatchery's #245 self-heal surfaces when it refuses to delete a
// branch that still has an open PR (unsafe: open-pr).
const COLLISION =
  "Castra session launch failed: agent-deck launch failed:\n  Error: branch " +
  "'feature/foo' already exists\nOrphan branch was NOT auto-removed: unsafe to remove (open-pr).";

// A babysit-shaped PR snapshot (what findOpenPr / queryPrForBabysit returns).
const PR = {
  number: 230,
  url: "https://github.com/o/r/pull/230",
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
    findOpenPr: vi.fn(async () => null),
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

describe("launchDispatch branch-collision adopt (#173)", () => {
  it("adopts the slice's open PR on a branch-collision instead of escalating", async () => {
    const findOpenPr = vi.fn(async () => PR);
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error(COLLISION); }), findOpenPr });
    const state: any = { slices: {} };
    const out = await launchDispatch(state, "T", item(), "s", d);

    // Adopted, not escalated.
    expect(state.slices.s.stage).toBe("pr-open");
    expect(state.slices.s.pr.number).toBe(230);
    expect(state.slices.s.escalated_reason).toBeUndefined();
    const transitions = transitionsOf(d);
    expect(transitions.find((t: any) => t.type === "slice.escalated")).toBeFalsy();
    expect(transitions.find((t: any) => t.type === "slice.stage.changed")?.stage).toBe("pr-open");
    expect(transitions.find((t: any) => t.type === "slice.pr.changed")?.pr.number).toBe(230);
    // The adopt action is recorded; no operator notification, no dispatch_failure.
    expect(out.actions.find((a: any) => a.action === "adopt-pr")?.detail).toContain("adopted existing open PR");
    expect(out.notifications).toHaveLength(0);
    expect(recordsOf(d).find((r: any) => r.kind === "dispatch_failure")).toBeFalsy();
  });

  it("falls through to escalate when the collision has no matching open PR", async () => {
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error(COLLISION); }), findOpenPr: vi.fn(async () => null) });
    const state: any = { slices: {} };
    await launchDispatch(state, "T", item(), "s", d);
    // Unchanged escalate behavior for a genuine orphan branch.
    expect(state.slices.s.stage).toBe("escalated");
    expect(transitionsOf(d).find((t: any) => t.type === "slice.escalated")?.reason).toBe("hatchery_dispatch_failed");
    expect(transitionsOf(d).find((t: any) => t.type === "slice.pr.changed")).toBeFalsy();
  });

  it("does not adopt (or even look up a PR) when the failure is not a branch-collision", async () => {
    const findOpenPr = vi.fn(async () => PR);
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error("hatchery 500"); }), findOpenPr });
    const state: any = { slices: {} };
    await launchDispatch(state, "T", item(), "s", d);
    expect(findOpenPr).not.toHaveBeenCalled();
    expect(state.slices.s.stage).toBe("escalated");
  });
});

describe("completePendingHatcheryDispatches branch-collision adopt (#173)", () => {
  const pending = (over: any = {}) => ({
    stage: "hatchery-pending",
    command: "smithy.forge",
    arguments: ["a", "1"],
    hatchery: { backend: "codex", job_id: "job-1" },
    worker_session_id: null,
    ...over,
  });

  it("adopts on a background-spawn branch-collision instead of escalating", async () => {
    const d = deps({
      getJob: vi.fn(async () => ({ status: "failed", error: { message: COLLISION } })),
      findOpenPr: vi.fn(async () => PR),
    });
    const state: any = { slices: { s: pending() } };
    const out = await completePendingHatcheryDispatches(state, "T", d);
    expect(state.slices.s.stage).toBe("pr-open");
    expect(transitionsOf(d).find((t: any) => t.type === "slice.escalated")).toBeFalsy();
    expect(out.actions.find((a: any) => a.action === "adopt-pr")).toBeTruthy();
  });

  it("still escalates a background-spawn failure that is not a branch-collision", async () => {
    const d = deps({
      getJob: vi.fn(async () => ({ status: "failed", error: { message: "git apply --index failed" } })),
      findOpenPr: vi.fn(async () => PR),
    });
    const state: any = { slices: { s: pending() } };
    await completePendingHatcheryDispatches(state, "T", d);
    expect(state.slices.s.stage).toBe("escalated");
    expect((d.findOpenPr as any)).not.toHaveBeenCalled();
  });

  it("carries the steward sessionId on the adopt stage transition when the fold knows it", async () => {
    const d = deps({
      getJob: vi.fn(async () => ({ status: "failed", error: { message: COLLISION } })),
      findOpenPr: vi.fn(async () => PR),
    });
    const state: any = { slices: { s: pending({ worker_session_id: "sess-7" }) } };
    await completePendingHatcheryDispatches(state, "T", d);
    expect(transitionsOf(d).find((t: any) => t.type === "slice.stage.changed")?.sessionId).toBe("sess-7");
  });
});

describe("adopt transitions survive a cold-start fold rebuild (#173/#255)", () => {
  it("rebuilds the slice as pr-open with its PR from the emitted transitions", async () => {
    const d = deps({ postSpawn: vi.fn(async () => { throw new Error(COLLISION); }), findOpenPr: vi.fn(async () => PR) });
    const state: any = { slices: {} };
    await launchDispatch(state, "T", item(), "s", d);

    let folded = emptySystemState();
    for (const event of transitionsOf(d)) folded = reduce(folded, event);
    expect(folded.slices.s.stage).toBe("pr-open");
    expect((folded.slices.s.pr as any).number).toBe(230);
  });
});
