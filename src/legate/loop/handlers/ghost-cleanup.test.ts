import { describe, expect, it, vi } from "vitest";
import { apply, assess } from "./ghost-cleanup.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import type { BroodTeardownResult } from "../clients/brood.js";

const NOW = "2026-05-20T01:00:00Z";
const OLD = "2026-05-20T00:00:00Z"; // 1h before NOW → past the 5min grace
const FRESH = "2026-05-20T00:59:00Z"; // 1m before NOW → within grace

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    ts: NOW,
    statePresent: true,
    stateError: null,
    raw: { slices: {} },
    slices: {},
    archived: {},
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

function ctx(teardown: () => BroodTeardownResult): HandlerContext {
  return {
    meta: {} as any,
    ts: NOW,
    castra: {} as any,
    broodTeardown: vi.fn(teardown),
    persist: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  };
}

describe("ghost-cleanup handler", () => {
  it("assess flags old orphan workers, not active/young/non-worker ones", () => {
    const state = loopState({
      slices: { live: { branch: "keep", worker_session_id: "active" } },
      sessions: [
        { id: "ghost", group: "legate-workers", worktree_path: "/wt/feature-orphan", created_at: OLD },
        { id: "active", group: "legate-workers", worktree_path: "/wt/feature-keep", created_at: OLD }, // tracked by live slice's session
        { id: "tracked-dir", group: "legate-workers", worktree_path: "/wt/feature-keep", created_at: OLD }, // dir tracked
        { id: "young", group: "legate-workers", worktree_path: "/wt/feature-new", created_at: FRESH }, // within grace
        { id: "other", group: "elsewhere", worktree_path: "/wt/feature-x", created_at: OLD }, // wrong group
      ],
    });
    expect(assess(state).map((d) => d.sessionId)).toEqual(["ghost"]);
  });

  it("apply tears down ghosts via Brood and drops them from the snapshot", () => {
    const state = loopState({
      sessions: [{ id: "ghost", group: "legate-workers", worktree_path: "/wt/feature-orphan", created_at: OLD }],
      sessionsById: new Map([["ghost", {}]]),
    });
    const c = ctx(() => ({ ok: true, notTracked: false, detail: "" }));
    const res = apply(assess(state), c, state);
    expect(c.broodTeardown).toHaveBeenCalledWith("ghost", { force: true, reason: "ghost-steward" });
    expect(res.actions[0]).toMatchObject({ action: "ghost-cleanup", sessionId: "ghost" });
    expect(state.sessionsById.has("ghost")).toBe(false);
  });

  it("apply records a failure (no drop) when teardown can't confirm", () => {
    const state = loopState({
      sessions: [{ id: "ghost", group: "legate-workers", worktree_path: "/wt/feature-orphan", created_at: OLD }],
      sessionsById: new Map([["ghost", {}]]),
    });
    const c = ctx(() => ({ ok: false, notTracked: true, detail: "not tracked by Brood" }));
    const res = apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "ghost-cleanup-failed" });
    expect(state.sessionsById.has("ghost")).toBe(true);
  });
});
