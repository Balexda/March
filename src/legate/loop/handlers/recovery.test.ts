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

  it("emits one decision per request, in order", () => {
    const state = loopState({ recoveryRequests: ["a", "b"] });
    expect(assess(state)).toEqual([{ sliceId: "a" }, { sliceId: "b" }]);
  });

  it("de-dups repeated requests for the same slice in one tick", () => {
    const state = loopState({ recoveryRequests: ["a", "a", "b", "a"] });
    expect(assess(state)).toEqual([{ sliceId: "a" }, { sliceId: "b" }]);
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
    const res = await apply(assess(state), ctx(), state);

    expect(state.raw.slices[sliceId]).toBeUndefined();
    // state.slices mirrors raw.slices (same reference), so it is gone there too.
    expect(state.slices[sliceId]).toBeUndefined();
    expect(state.raw.transient_retry_counts[recoveryAttemptKey(sliceId)]).toBeUndefined();
    expect(res.mutated).toBe(true);
    // The action is RETURNED (not written directly) so runHeartbeat appends it in
    // pipeline order; "cleared" is derived from the drop, not a pre-apply snapshot.
    expect(res.actions).toEqual([
      { action: "slice-recovery", sliceId, detail: expect.stringContaining("cleared escalated slice") },
    ]);
  });

  it("does not write the action log directly (heartbeat owns ordering)", async () => {
    const state = loopState({
      recoveryRequests: ["s1"],
      raw: { slices: { s1: { stage: "escalated" } }, archived_slices: {}, transient_retry_counts: {}, repo: { path: "/repo" } },
    });
    const c = ctx();
    await apply(assess(state), c, state);
    expect(c.emit).not.toHaveBeenCalled();
    expect(c.log).not.toHaveBeenCalled();
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

  it("is a tolerant no-op (still mutated) reporting no tracked slice for an unknown slice", async () => {
    const state = loopState({ recoveryRequests: ["ghost"] });
    const res = await apply(assess(state), ctx(), state);
    expect(res.actions[0]).toMatchObject({ action: "slice-recovery", sliceId: "ghost" });
    expect(res.actions[0].detail).toContain("no tracked slice");
    expect(res.mutated).toBe(true);
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
