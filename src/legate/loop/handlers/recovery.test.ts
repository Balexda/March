/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess, deriveUnescalateStage } from "./recovery.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import { relaunchRetryKey } from "./relaunch.js";

function loopState(over: Partial<LoopState> & { raw?: any } = {}): LoopState {
  const raw = {
    slices: {},
    archived_slices: {},
    transient_retry_counts: {},
    castra_recover_attempts: {},
    repo: { path: "/repo" },
    ...((over as any).raw || {}),
  };
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

function ctx(over: Partial<HandlerContext> = {}): HandlerContext {
  return {
    meta: { profile: "march", processor_name: "loop", paired_legate: "legate" } as any,
    ts: "T",
    castra: { removeSession: vi.fn().mockResolvedValue({ removed: true }) } as any,
    broodTeardown: vi.fn(),
    emitTransition: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
    ...over,
  } as any;
}

/** Register a session into the snapshot the handler reads (`sessionsById`). */
function withSession(state: LoopState, id: string, status: string): LoopState {
  state.sessionsById.set(id, { id, status });
  state.sessions.push({ id, status, group: state.workerGroup });
  return state;
}

const emitted = (c: HandlerContext): any[] => (c.emitTransition as any).mock.calls.map((a: any[]) => a[0]);

describe("deriveUnescalateStage", () => {
  it("returns pr-open when the slice carries a live PR, else implementing", () => {
    expect(deriveUnescalateStage({ pr: { number: 9 } })).toBe("pr-open");
    expect(deriveUnescalateStage({ pr: { number: 0 } })).toBe("implementing");
    expect(deriveUnescalateStage({})).toBe("implementing");
    expect(deriveUnescalateStage(undefined)).toBe("implementing");
  });
});

describe("recovery assess (candidate union)", () => {
  it("emits no decisions with no requests and no mid-walk slices", () => {
    expect(assess(loopState())).toEqual([]);
    expect(assess(loopState({ recoveryRequests: [] }))).toEqual([]);
  });

  it("unions drained requests with mid-walk slices, de-duped by id", () => {
    const state = loopState({
      recoveryRequests: ["a", "a", "b"],
      raw: {
        slices: {
          a: { stage: "escalated" }, // also requested → still one decision
          c: { stage: "pr-open", recovery_rung: 1 }, // mid-walk, not requested
        },
      },
    });
    const ids = assess(state).map((d) => d.sliceId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("a duplicate request never resets a slice already mid-walk (guarded on recovery_rung)", () => {
    // A re-drained inner-rung event puts a rung-1 slice back in recoveryRequests;
    // it must continue descending, not re-init at rung 0.
    const state = withSession(
      loopState({
        recoveryRequests: ["s1"],
        raw: { slices: { s1: { stage: "pr-open", recovery_rung: 1, branch: "feature/a", pr: { number: 7 } } } },
      }),
      "ignored",
      "error",
    );
    const [d] = assess(state);
    expect(d.action).toBe("prepare-relaunch");
  });
});

describe("rung 0b — steward awaiting input (refuse)", () => {
  it("refuses and touches nothing", async () => {
    const state = withSession(
      loopState({
        recoveryRequests: ["s1"],
        raw: { slices: { s1: { stage: "escalated", escalated_reason: "steward_awaiting_input", worker_session_id: "sess1", branch: "feature/a" } } },
        perSlice: { s1: { stewardReport: { status: "awaiting_input", classified: true } } },
      }),
      "sess1",
      "running",
    );
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-awaiting-input" });
    // untouched
    expect(state.slices.s1.stage).toBe("escalated");
    expect(state.slices.s1.recovery_rung).toBeUndefined();
    expect(emitted(c)).toEqual([]);
  });

  it("awaiting_input wins even when the session is also errored", async () => {
    const state = withSession(
      loopState({
        recoveryRequests: ["s1"],
        raw: { slices: { s1: { stage: "escalated", worker_session_id: "sess1", branch: "feature/a" } }, castra_recover_attempts: {} },
        perSlice: { s1: { stewardReport: { status: "awaiting_input", classified: true } } },
      }),
      "sess1",
      "error",
    );
    const [d] = assess(state);
    expect(d.action).toBe("refuse-awaiting-input");
  });
});

describe("rung 0a — errored session (Castra-recover hold)", () => {
  it("un-escalates, sets rung 0, resets the Castra budget on a fresh request, emits stage.changed", async () => {
    const state = withSession(
      loopState({
        recoveryRequests: ["s1"],
        raw: {
          slices: { s1: { stage: "escalated", escalated_reason: "worker_error", worker_session_id: "sess1", branch: "feature/a", pr: { number: 9 } } },
          castra_recover_attempts: { sess1: 3 }, // already spent — fresh request must reset it
        },
      }),
      "sess1",
      "error",
    );
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-hold" });
    expect(state.slices.s1).toMatchObject({ stage: "pr-open", recovery_rung: 0, escalated_reason: undefined });
    expect(state.raw.castra_recover_attempts.sess1).toBeUndefined();
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.stage.changed", stage: "pr-open" }));
  });

  it("holds (does not descend) while the Castra budget remains on a mid-walk slice", async () => {
    const state = withSession(
      loopState({
        raw: {
          slices: { s1: { stage: "pr-open", recovery_rung: 0, worker_session_id: "sess1", branch: "feature/a", pr: { number: 9 } } },
          castra_recover_attempts: { sess1: 1 },
        },
      }),
      "sess1",
      "error",
    );
    const [d] = assess(state);
    expect(d.action).toBe("hold-castra");
  });
});

describe("rung 0a→1 — Castra budget spent, drop the wedged session", () => {
  it("removes the errored session (worktree preserved), un-escalates to rung 1, records the rung durably", async () => {
    const state = withSession(
      loopState({
        raw: {
          slices: { s1: { stage: "pr-open", recovery_rung: 0, worker_session_id: "sess1", branch: "feature/a", pr: { number: 9 } } },
          castra_recover_attempts: { sess1: 3 },
        },
      }),
      "sess1",
      "error",
    );
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(c.castra.removeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess1", pruneWorktree: false }),
    );
    expect(res.actions[0]).toMatchObject({ action: "recovery-descend" });
    expect(state.slices.s1).toMatchObject({ stage: "pr-open", recovery_rung: 1 });
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 1 }));
  });
});

describe("rung 1 — relaunch prep (vanished session)", () => {
  it("un-escalates a vanished-session slice with an open PR to pr-open and records rung 1 once", async () => {
    const state = loopState({
      recoveryRequests: ["s1"],
      raw: { slices: { s1: { stage: "escalated", escalated_reason: "worker_error", worker_session_id: "gone", branch: "feature/a", worktree_path: "/wt/a", pr: { number: 9 } } } },
    });
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-relaunch" });
    expect(state.slices.s1).toMatchObject({ stage: "pr-open", recovery_rung: 1, escalated_reason: undefined });
    // worktree preserved for relaunch
    expect(state.slices.s1.worktree_path).toBe("/wt/a");
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 1 }));
  });

  it("nukes a PR-less vanished slice (no PR to relaunch onto → fresh re-dispatch)", async () => {
    // A spawn that died before opening a PR: relaunch is structurally inapplicable
    // (it requires pr.number), so the ladder degrades straight to the nuke instead
    // of un-escalating to a stage that would strand it (no relaunch, dispatch skips
    // it as in-flight).
    const state = loopState({
      recoveryRequests: ["s1"],
      raw: { slices: { s1: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed", worker_session_id: "gone", branch: "feature/a" } } },
    });
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-nuke" });
    expect(state.slices.s1).toBeUndefined();
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 3 }));
  });

  it("a FRESH request on a stranded slice (relaunch budget already spent) relaunches, not nukes — clears the warm budget", async () => {
    // The live #387 case: pr-open, vanished session, relaunch-steward budget = 3
    // (the loop gave up). A fresh operator recover must mirror the begin-graduated
    // fold reset into the warm raw so the ladder gets a clean relaunch attempt
    // instead of reading the spent budget and descending straight to the nuke.
    const state = loopState({
      recoveryRequests: ["s1"],
      raw: {
        slices: { s1: { stage: "pr-open", escalated_reason: "hatchery_dispatch_failed", worker_session_id: "gone", branch: "feature/a", worktree_path: "/wt/a", pr: { number: 387 } } },
        transient_retry_counts: { [relaunchRetryKey("s1")]: 3, ["dispatch-recovery:s1"]: 2 },
      },
    });
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-relaunch" });
    expect(state.slices.s1).toMatchObject({ stage: "pr-open", recovery_rung: 1 });
    // The spent budgets were cleared so relaunch fires fresh next tick.
    expect(state.raw.transient_retry_counts[relaunchRetryKey("s1")]).toBeUndefined();
    expect(state.raw.transient_retry_counts["dispatch-recovery:s1"]).toBeUndefined();
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 1 }));
  });

  it("does NOT re-emit the rung event on a maintain tick (already rung 1)", async () => {
    const state = loopState({
      raw: { slices: { s1: { stage: "pr-open", recovery_rung: 1, worker_session_id: "gone", branch: "feature/a", pr: { number: 9 } } } },
    });
    const c = ctx();
    await apply(assess(state), c, state);
    expect(emitted(c).filter((e) => e.type === "slice.recovery.requested")).toEqual([]);
  });
});

describe("rung 1→2→3 — descent on relaunch-budget exhaustion", () => {
  it("rung 1 with the relaunch budget spent + session gone holds one tick at rung 2", async () => {
    const state = loopState({
      raw: {
        slices: { s1: { stage: "pr-open", recovery_rung: 1, worker_session_id: "gone", branch: "feature/a", pr: { number: 9 } } },
        transient_retry_counts: { [relaunchRetryKey("s1")]: 3 },
      },
    });
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-descend" });
    expect(state.slices.s1.recovery_rung).toBe(2);
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 2 }));
  });

  it("rung 2 with the session still gone nukes (tombstone + fresh re-dispatch)", async () => {
    const state = loopState({
      raw: {
        slices: { s1: { stage: "pr-open", recovery_rung: 2, worker_session_id: "gone", branch: "feature/a", pr: { number: 9 } } },
        transient_retry_counts: { [relaunchRetryKey("s1")]: 3 },
      },
    });
    const c = ctx();
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-nuke" });
    expect(state.slices.s1).toBeUndefined();
    expect(emitted(c)).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 3 }));
  });

  it("rung 2 completes (not nukes) when the relaunch turned out to have succeeded", async () => {
    // The relaunched session surfaced healthy in the next sense → walk complete.
    const state = withSession(
      loopState({
        raw: {
          slices: { s1: { stage: "pr-open", recovery_rung: 2, worker_session_id: "new-sess", branch: "feature/a", pr: { number: 9 } } },
          transient_retry_counts: { [relaunchRetryKey("s1")]: 3 },
        },
      }),
      "new-sess",
      "running",
    );
    const res = await apply(assess(state), ctx(), state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-complete" });
    expect(state.slices.s1.recovery_rung).toBeUndefined();
  });
});

describe("completion + edge cases", () => {
  it("a non-escalated slice with a live session completes the walk and clears the rung", async () => {
    const state = withSession(
      loopState({ raw: { slices: { s1: { stage: "pr-open", recovery_rung: 1, worker_session_id: "sess1" } } } }),
      "sess1",
      "running",
    );
    const res = await apply(assess(state), ctx(), state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-complete" });
    expect(state.slices.s1.recovery_rung).toBeUndefined();
  });

  it("an operator request on an unknown slice is a tolerant complete (no throw)", async () => {
    const state = loopState({ recoveryRequests: ["ghost"] });
    const res = await apply(assess(state), ctx(), state);
    expect(res.actions[0]).toMatchObject({ action: "recovery-complete", sliceId: "ghost" });
    expect(res.actions[0].detail).toContain("no tracked slice");
  });

  it("de-dups repeated requests for the same slice into one decision", () => {
    const state = loopState({
      recoveryRequests: ["s1", "s1", "s1"],
      raw: { slices: { s1: { stage: "escalated", worker_session_id: "gone", branch: "feature/a" } } },
    });
    expect(assess(state).filter((d) => d.sliceId === "s1")).toHaveLength(1);
  });

  it("does not write the action log directly (heartbeat owns ordering)", async () => {
    const state = loopState({
      recoveryRequests: ["s1"],
      raw: { slices: { s1: { stage: "escalated", worker_session_id: "gone", branch: "feature/a" } } },
    });
    const c = ctx();
    await apply(assess(state), c, state);
    expect(c.log).not.toHaveBeenCalled();
  });
});
