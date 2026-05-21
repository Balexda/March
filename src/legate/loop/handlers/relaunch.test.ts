import { describe, expect, it, vi } from "vitest";
import { apply, assess, type RelaunchDeps } from "./relaunch.js";
import type { HandlerContext, LoopState } from "../state/types.js";

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    ts: "T",
    statePresent: true,
    stateError: null,
    raw: { slices: {} },
    slices: {},
    archived: {},
    repoPath: "/home/u/Development/March",
    workerGroup: "legate-workers",
    sessions: [],
    sessionsById: new Map(),
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice: {},
    ...over,
  };
}

function ctx(launch: () => { sessionId: string | null }): HandlerContext & { castra: any } {
  return {
    meta: { profile: "p", worker_group: "legate-workers" } as any,
    ts: "T",
    castra: { launchSession: vi.fn(launch), sendPrompt: vi.fn() } as any,
    broodTeardown: vi.fn(),
    persist: vi.fn(),
    emit: vi.fn(),
    emitTransition: vi.fn(),
    log: vi.fn(),
  };
}

const eligibleSlice = (over: Record<string, any> = {}) => ({
  stage: "pr-open",
  branch: "feat-a",
  pr: { number: 7, url: "http://pr/7" },
  worker_session_id: "dead",
  ...over,
});

describe("relaunch handler", () => {
  it("assess flags eligible slices whose session is gone, respecting filters", async () => {
    const state = loopState({
      slices: {
        gone: eligibleSlice(),
        alive: eligibleSlice({ worker_session_id: "live" }),
        notEligible: eligibleSlice({ stage: "queued" }),
        noPr: eligibleSlice({ pr: {} }),
        noBranch: eligibleSlice({ branch: "" }),
      },
      sessions: [{ id: "live", group: "legate-workers" }],
    });
    const ids = assess(state).map((d) => d.sliceId);
    expect(ids).toEqual(["gone"]);
    const d = assess(state)[0];
    expect(d).toMatchObject({ bareBranch: "feat-a", featureBranch: "feature/feat-a", attempt: 1, limit: 3 });
    expect(d.worktreePath).toBe("/home/u/Development/WorkTrees/March/feature-feat-a");
  });

  it("assess stops after the retry limit", async () => {
    const state = loopState({
      slices: { gone: eligibleSlice() },
      raw: { slices: {}, transient_retry_counts: { "relaunch-steward:gone": 3 } },
    });
    expect(assess(state)).toEqual([]);
  });

  it("apply recreates a missing worktree, launches, sends resume, and rebinds the slice", async () => {
    const slice = eligibleSlice();
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "fresh" }));
    const deps: RelaunchDeps = { worktreeExists: vi.fn(() => false), ensureWorktree: vi.fn(async () => {}) };
    const res = await apply(assess(state), c, state, deps);

    expect(deps.ensureWorktree).toHaveBeenCalledWith(
      "/home/u/Development/WorkTrees/March/feature-feat-a",
      "feature/feat-a",
      "/home/u/Development/March",
    );
    expect(c.castra.launchSession).toHaveBeenCalledWith(expect.objectContaining({ createBranch: false, branch: "feat-a", model: "opus" }));
    expect(c.castra.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "fresh" }));
    expect(slice.worker_session_id).toBe("fresh");
    expect(state.raw.transient_retry_counts["relaunch-steward:gone"]).toBe(1);
    expect(res.actions[0]).toMatchObject({ action: "relaunch-steward", sessionId: "fresh" });
    expect(c.persist).toHaveBeenCalled();
    // #175: Herald steward.relaunched + retry.counted transition events.
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "steward.relaunched", sliceId: "gone", sessionId: "fresh" });
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: "relaunch-steward:gone", count: 1 });
  });

  it("apply records relaunch-failed and skips launch when worktree recreation throws", async () => {
    const slice = eligibleSlice();
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "fresh" }));
    const deps: RelaunchDeps = {
      worktreeExists: () => false,
      ensureWorktree: async () => {
        throw new Error("git boom");
      },
    };
    const res = await apply(assess(state), c, state, deps);
    expect(c.castra.launchSession).not.toHaveBeenCalled();
    expect(res.actions[0]).toMatchObject({ action: "relaunch-failed" });
    expect(slice.worker_session_id).toBe("dead");
  });
});
