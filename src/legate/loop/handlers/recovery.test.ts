import { describe, expect, it, vi } from "vitest";
import { apply, assess } from "./recovery.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import { recoveryAttemptKey } from "../pure/slice.js";

function loopState(over: Partial<LoopState> = {}): LoopState {
  const raw = { slices: {}, archived_slices: {}, transient_retry_counts: {}, repo: { path: "/repo" }, ...((over as any).raw || {}) };
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
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice: {},
    ...over,
  };
}

function ctx(): HandlerContext {
  return {
    meta: { processor_name: "loop", paired_legate: "legate" } as any,
    ts: "T",
    castra: {} as any,
    broodTeardown: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  };
}

describe("recovery assess", () => {
  it("emits no decisions when no recovery requests were drained", () => {
    expect(assess(loopState())).toEqual([]);
    expect(assess(loopState({ recoveryRequests: [] }))).toEqual([]);
  });

  it("marks a tracked escalated slice present, an unknown one absent", () => {
    const state = loopState({
      recoveryRequests: ["live", "archived", "ghost"],
      raw: {
        slices: { live: { stage: "escalated" } },
        archived_slices: { archived: { terminal_state: "CLOSED" } },
        transient_retry_counts: {},
        repo: { path: "/repo" },
      },
    });
    expect(assess(state)).toEqual([
      { sliceId: "live", present: true },
      { sliceId: "archived", present: true },
      { sliceId: "ghost", present: false },
    ]);
  });
});

describe("recovery apply", () => {
  it("drops an escalated slice + clears its budget so it is no longer in-flight", async () => {
    const sliceId = "s1";
    const state = loopState({
      recoveryRequests: [sliceId],
      raw: {
        slices: { [sliceId]: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed", branch: "feature/a" } },
        archived_slices: {},
        transient_retry_counts: { [recoveryAttemptKey(sliceId)]: 2 },
        repo: { path: "/repo" },
      },
    });
    const c = ctx();
    const res = await apply(assess(state), c, state);

    expect(state.raw.slices[sliceId]).toBeUndefined();
    // state.slices mirrors raw.slices (same reference), so it is gone there too.
    expect(state.slices[sliceId]).toBeUndefined();
    expect(state.raw.transient_retry_counts[recoveryAttemptKey(sliceId)]).toBeUndefined();
    expect(res.mutated).toBe(true);
    expect(res.actions).toEqual([
      { action: "slice-recovery", sliceId, detail: expect.stringContaining("cleared escalated slice") },
    ]);
    expect(c.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "slice_recovery", slice_id: sliceId }));
  });

  it("drops a slice that was archived (un-archives it for re-dispatch)", async () => {
    const sliceId = "s1";
    const state = loopState({
      recoveryRequests: [sliceId],
      raw: {
        slices: {},
        archived_slices: { [sliceId]: { terminal_state: "CLOSED", branch: "feature/a" } },
        transient_retry_counts: {},
        repo: { path: "/repo" },
      },
    });
    await apply(assess(state), ctx(), state);
    expect(state.raw.archived_slices[sliceId]).toBeUndefined();
  });

  it("is a tolerant no-op (still mutated/logged) for an unknown slice", async () => {
    const state = loopState({ recoveryRequests: ["ghost"] });
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "slice-recovery", sliceId: "ghost" });
    expect(res.actions[0].detail).toContain("no tracked slice");
    expect(c.emit).toHaveBeenCalledOnce();
  });

  it("only clears retry counters keyed to the recovered slice", async () => {
    const state = loopState({
      recoveryRequests: ["s1"],
      raw: {
        slices: { s1: { stage: "escalated" } },
        archived_slices: {},
        transient_retry_counts: {
          [recoveryAttemptKey("s1")]: 2,
          s1: 1,
          [recoveryAttemptKey("s2")]: 1,
        },
        repo: { path: "/repo" },
      },
    });
    await apply(assess(state), ctx(), state);
    expect(state.raw.transient_retry_counts).toEqual({ [recoveryAttemptKey("s2")]: 1 });
  });
});
