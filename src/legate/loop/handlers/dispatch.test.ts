import { describe, expect, it, vi } from "vitest";
import { apply, assess, type DispatchDeps } from "./dispatch.js";
import type { HandlerContext, LoopState } from "../state/types.js";

function loopState(over: Partial<LoopState> = {}): LoopState {
  const raw = { slices: {}, archived_slices: {}, repo: { path: "/repo" }, ...((over as any).raw || {}) };
  return {
    ts: "T",
    statePresent: true,
    stateError: null,
    raw,
    slices: raw.slices,
    archived: raw.archived_slices,
    repoPath: "/repo",
    workerGroup: "legate-workers",
    sessions: [],
    sessionsById: new Map(),
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 }, ...((over as any).smithy || {}) },
    perSlice: {},
    ...over,
  };
}

// A ready item whose dispatchSliceId is derived from its action; a bare forge on
// an unknown artifact falls back to a hash stem — stable per item shape.
const readyItem = (path: string) => ({ path, next_action: { command: "smithy.forge", arguments: [path, "1"] }, parent_path: path });

function ctx(): HandlerContext {
  return {
    meta: {} as any,
    ts: "T",
    castra: {} as any,
    broodTeardown: vi.fn(),
    persist: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    completePending: vi.fn(() => ({ actions: [], failures: [], mutated: false, notifications: [] })),
    launchDispatch: vi.fn(() => ({ actions: [{ action: "dispatch" }], failures: [], mutated: true })),
    recoveryDispatch: vi.fn(() => ({ actions: [{ action: "recovery_dispatch" }], failures: [], mutated: true })),
    requestJudgement: vi.fn((i) => ({ ...i })),
    ...over,
  };
}

describe("dispatch assess (pure selection)", () => {
  it("selects fresh dispatch for a ready item with no in-flight or archived match", () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    expect(assess(state).map((d) => d.kind)).toEqual(["dispatch"]);
  });

  it("skips an item already in flight", () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    // Seed an in-flight slice keyed to the same artifact+action.
    const sliceId = assess(state)[0]!.sliceId;
    (state.raw.slices as any)[sliceId] = { stage: "implementing", artifact_path: "a.spec.md", command: "smithy.forge", arguments: ["a.spec.md", "1"] };
    expect(assess(state)).toEqual([]);
  });

  it("returns nothing when smithy read failed", () => {
    const state = loopState({ smithy: { ok: false, error: "down", ready: [readyItem("a")], queue: { dispatchable: 0, blocked: 0, total: 0 } } });
    expect(assess(state)).toEqual([]);
  });
});

describe("dispatch apply (orchestration)", () => {
  it("drains pending then launches the selected fresh dispatch", () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    const c = ctx();
    const d = deps();
    const res = apply(assess(state), c, state, d);
    expect(d.completePending).toHaveBeenCalled();
    expect(d.launchDispatch).toHaveBeenCalledTimes(1);
    expect(res.actions.some((a) => a.action === "dispatch")).toBe(true);
    expect(c.persist).toHaveBeenCalled();
  });

  it("fires legate-judgement requests for completion notifications", () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } } });
    const d = deps({
      completePending: vi.fn(() => ({
        actions: [],
        failures: [],
        mutated: true,
        notifications: [{ slice: {}, sliceId: "s", requestKey: "k", reason: "hatchery_dispatch_failed", detail: "boom" }],
      })),
    });
    const res = apply(assess(state), ctx(), state, d);
    expect(d.requestJudgement).toHaveBeenCalledWith(expect.objectContaining({ requestKey: "k" }));
    expect(res.requests).toHaveLength(1);
    void item;
  });

  it("routes a MERGED-archive collision through recovery, not fresh dispatch", () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    const sliceId = assess(state)[0]!.sliceId;
    (state.raw.archived_slices as any)[sliceId] = { terminal_state: "MERGED", artifact_path: "a.spec.md", command: "smithy.forge", arguments: ["a.spec.md", "1"], pr: { number: 9 } };
    const d = deps();
    apply(assess(state), ctx(), state, d);
    expect(d.recoveryDispatch).toHaveBeenCalledTimes(1);
    expect(d.launchDispatch).not.toHaveBeenCalled();
  });
});
