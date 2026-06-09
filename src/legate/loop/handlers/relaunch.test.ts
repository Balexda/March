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

function ctx(
  launch: () => { sessionId: string | null; worktreePath?: string },
  over: {
    register?: (input: any) => any;
    teardown?: (id: string, opts?: any) => any;
    retire?: (id: string) => any;
    withRegister?: boolean;
  } = {},
): HandlerContext & { castra: any } {
  const withRegister = over.withRegister ?? true;
  return {
    meta: { profile: "p", worker_group: "legate-workers" } as any,
    ts: "T",
    castra: { launchSession: vi.fn(launch), sendPrompt: vi.fn() } as any,
    broodTeardown: vi.fn(async (id: string, opts?: any) =>
      over.teardown ? over.teardown(id, opts) : { ok: true, notTracked: false, detail: "teardown " + id },
    ),
    broodRegister: withRegister
      ? vi.fn(async (input: any) => (over.register ? over.register(input) : { ok: true, detail: "registered " + input.id }))
      : undefined,
    broodRetire: vi.fn(async (id: string) =>
      over.retire ? over.retire(id) : { ok: true, notTracked: false, detail: "retired " + id },
    ),
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
    // #175: Herald steward.relaunched + retry.counted transition events.
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "steward.relaunched", sliceId: "gone", sessionId: "fresh" });
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: "relaunch-steward:gone", count: 1 });
  });

  it("#308: registers the live steward with Brood under the launch-reported worktree", async () => {
    const slice = eligibleSlice();
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/feature-feat-a-newhash" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(assess(state), c, state, deps);

    expect(c.broodRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fresh",
        kind: "steward",
        status: "running",
        agentDeckSessionId: "fresh",
        profile: "p",
        group: "legate-workers",
        branch: "feature/feat-a",
        worktreePath: "/wt/feature-feat-a-newhash",
      }),
    );
    // The slice tracks the LIVE worktree from the launch response, not the guess.
    expect((slice as any).worktree_path).toBe("/wt/feature-feat-a-newhash");
  });

  it("#308: reaps the prior steward when it sits on a DISTINCT worktree", async () => {
    const slice = eligibleSlice({ worker_session_id: "old", worktree_path: "/wt/feature-feat-a-oldhash" });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "new", worktreePath: "/wt/feature-feat-a-newhash" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    const res = await apply(assess(state), c, state, deps);

    expect(c.broodTeardown).toHaveBeenCalledWith("old", {
      force: true,
      reason: "steward-relaunch",
      traceKey: "gone",
    });
    expect(res.actions[0].detail).toContain("reaped prior steward old");
    expect(slice.worker_session_id).toBe("new");
  });

  it("#308: registers parentId from the slice's Hatchery spawn id (preserves the spawn group)", async () => {
    const slice = eligibleSlice({ hatchery: { spawn_id: "spawn-42", backend: "codex" } });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/feature-feat-a" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(assess(state), c, state, deps);

    expect(c.broodRegister).toHaveBeenCalledWith(expect.objectContaining({ id: "fresh", parentId: "spawn-42" }));
  });

  it("#308: omits parentId when the slice has no Hatchery spawn id", async () => {
    const slice = eligibleSlice();
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/feature-feat-a" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(assess(state), c, state, deps);

    const reg = (c.broodRegister as any).mock.calls[0][0];
    expect(reg).not.toHaveProperty("parentId");
  });

  it("#308: same-worktree relaunch retires the prior row instead of tearing it down", async () => {
    const sharedWorktree = "/wt/feature-feat-a";
    const slice = eligibleSlice({ worker_session_id: "old", worktree_path: sharedWorktree });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "new", worktreePath: sharedWorktree }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    const res = await apply(assess(state), c, state, deps);

    // Never a worktree-pruning teardown on a shared worktree (#304 would reap the live one).
    expect(c.broodTeardown).not.toHaveBeenCalled();
    // New row registered + prior row retired → exactly one active row for the worktree.
    expect(c.broodRegister).toHaveBeenCalledWith(expect.objectContaining({ id: "new", worktreePath: sharedWorktree }));
    expect(c.broodRetire).toHaveBeenCalledWith("old");
    expect(res.actions[0].detail).toContain("retired prior steward old");
  });

  it("#308: relaunch still succeeds and rebinds when Brood register fails (best-effort)", async () => {
    const slice = eligibleSlice({ worker_session_id: "old", worktree_path: "/wt/feature-feat-a-oldhash" });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = ctx(() => ({ sessionId: "new", worktreePath: "/wt/feature-feat-a-newhash" }), {
      register: () => ({ ok: false, detail: "brood down" }),
    });
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    const res = await apply(assess(state), c, state, deps);

    expect(slice.worker_session_id).toBe("new");
    expect(res.actions[0]).toMatchObject({ action: "relaunch-steward", sessionId: "new" });
    expect(res.actions[0].detail).toContain("Brood register failed");
    // A reap still runs (best-effort register failure does not block it).
    expect(c.broodTeardown).toHaveBeenCalledWith("old", expect.objectContaining({ reason: "steward-relaunch" }));
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
