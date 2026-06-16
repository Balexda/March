/**
 * @l0 @deterministic @ci
 */
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
    broodTeardown: vi.fn(async () => teardown()),
    emit: vi.fn(),
    emitTransition: vi.fn(),
    log: vi.fn(),
  };
}

describe("ghost-cleanup handler", () => {
  it("assess flags old orphan workers, not active/young/non-worker ones", async () => {
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

  it("apply tears down ghosts via Brood and drops them from the snapshot", async () => {
    const state = loopState({
      sessions: [{ id: "ghost", group: "legate-workers", worktree_path: "/wt/feature-orphan", created_at: OLD }],
      sessionsById: new Map([["ghost", {}]]),
    });
    const c = ctx(() => ({ ok: true, notTracked: false, detail: "" }));
    const res = await apply(assess(state), c, state);
    expect(c.broodTeardown).toHaveBeenCalledWith("ghost", { force: true, reason: "ghost-steward", traceKey: "ghost" });
    expect(res.actions[0]).toMatchObject({ action: "ghost-cleanup", sessionId: "ghost" });
    expect(state.sessionsById.has("ghost")).toBe(false);
  });

  it("defers (no drop) and tombstones when Brood does not track the session (404)", async () => {
    const state = loopState({
      sessions: [{ id: "ghost", group: "legate-workers", worktree_path: "/wt/feature-orphan", created_at: OLD }],
      sessionsById: new Map([["ghost", {}]]),
    });
    const c = ctx(() => ({ ok: false, notTracked: true, detail: "not tracked by Brood" }));
    const res = await apply(assess(state), c, state);
    // notTracked is a Brood reconciliation gap, not a failure: deferred, not failed.
    expect(res.actions[0]).toMatchObject({ action: "ghost-cleanup-deferred", sessionId: "ghost" });
    expect(state.sessionsById.has("ghost")).toBe(true); // live session NOT dropped
    // Tombstone persisted (durable via retry.counted) so the next tick skips it.
    expect(state.raw.transient_retry_counts).toMatchObject({ "ghost-cleanup:ghost": 1 });
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: "ghost-cleanup:ghost", count: 1 });
    // assess no longer re-selects the tombstoned session → no 404 storm.
    expect(assess(state)).toEqual([]);
  });

  it("records a failure and retries (no tombstone) on a transient Brood error", async () => {
    const state = loopState({
      sessions: [{ id: "ghost", group: "legate-workers", worktree_path: "/wt/feature-orphan", created_at: OLD }],
      sessionsById: new Map([["ghost", {}]]),
    });
    const c = ctx(() => ({ ok: false, notTracked: false, detail: "Brood unreachable" }));
    const res = await apply(assess(state), c, state);
    expect(res.actions[0]).toMatchObject({ action: "ghost-cleanup-failed" });
    expect(state.sessionsById.has("ghost")).toBe(true);
    // No tombstone — a transient failure must be retried next tick.
    expect(state.raw.transient_retry_counts?.["ghost-cleanup:ghost"]).toBeUndefined();
    expect(assess(state).map((d) => d.sessionId)).toEqual(["ghost"]);
  });
});
