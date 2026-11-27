/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess, MAX_REQUEUE_ATTEMPTS, type RequeueDeps } from "./requeue.js";
import type { HandlerContext, LoopState, RequeueRequest } from "../state/types.js";
import { classifyReady } from "../pure/slice.js";
import { dispatchSliceId } from "../pure/dispatch-id.js";

function loopState(over: Partial<LoopState> & { raw?: any } = {}): LoopState {
  const raw = { slices: {}, archived_slices: {}, transient_retry_counts: {}, ...((over as any).raw || {}) };
  return {
    ts: "2026-11-18T00:00:00.000Z",
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
    ts: "2026-11-18T00:00:00.000Z",
    castra: { removeSession: vi.fn().mockResolvedValue({ removed: true }) } as any,
    broodTeardown: vi.fn().mockResolvedValue({ ok: true, notTracked: false, detail: "ok" }),
    broodRegister: vi.fn().mockResolvedValue({ ok: true, detail: "ok" }),
    requestJudgement: vi.fn().mockResolvedValue({ kind: "processor_request" }),
    emitTransition: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
    ...over,
  } as any;
}

function deps(over: Partial<RequeueDeps> = {}): RequeueDeps {
  return {
    closePr: vi.fn().mockResolvedValue(undefined),
    deleteRemoteBranch: vi.fn().mockResolvedValue(false),
    ...over,
  };
}

const req = (sliceId: string, over: Partial<RequeueRequest> = {}): RequeueRequest => ({ sliceId, seq: 10, closePr: false, ...over });
const emitted = (c: HandlerContext): any[] => (c.emitTransition as any).mock.calls.map((a: any[]) => a[0]);

/** The #588 shape: escalated, no reason, awaiting_input report, dead session, no PR. */
function askedAndDied(): LoopState {
  return loopState({
    raw: {
      slices: {
        s: {
          stage: "escalated",
          worker_session_id: "dead-1",
          worktree_path: "/wt/s",
          branch: "smithy/cut/s",
        },
      },
    },
    perSlice: { s: { stewardReport: { status: "awaiting_input", classified: true } } },
    requeueRequests: [req("s", { operator: "jb", reason: "asked then died" })],
  });
}

describe("requeue assess", () => {
  it("requeues an awaiting_input slice whose session died (the case recovery refuses)", () => {
    expect(assess(askedAndDied())).toEqual([
      expect.objectContaining({ sliceId: "s", action: "requeue", prNumber: null }),
    ]);
  });

  it("refuses an open PR without closePr, and requeues it (closing the PR) with closePr", () => {
    const base = { raw: { slices: { s: { stage: "pr-open" } } }, perSlice: { s: { pr: { number: 7, state: "OPEN" } } } };
    expect(assess(loopState({ ...base, requeueRequests: [req("s")] }))[0]).toMatchObject({ action: "refuse" });
    expect(assess(loopState({ ...base, requeueRequests: [req("s", { closePr: true })] }))[0]).toMatchObject({
      action: "requeue",
      prNumber: 7,
    });
  });

  it("refuses a merged PR and a slice that is not in flight", () => {
    const merged = loopState({
      raw: { slices: { s: { stage: "pr-open" } } },
      perSlice: { s: { pr: { number: 7, state: "MERGED" } } },
      requeueRequests: [req("s", { closePr: true })],
    });
    expect(assess(merged)[0]).toMatchObject({ action: "refuse", reason: expect.stringMatching(/merged/) });
    expect(assess(loopState({ requeueRequests: [req("gone")] }))[0]).toMatchObject({ action: "refuse" });
  });

  it("refuses a slice whose spawn is still in progress", () => {
    const state = loopState({ raw: { slices: { s: { stage: "hatchery-pending" } } }, requeueRequests: [req("s")] });
    expect(assess(state)[0]).toMatchObject({ action: "refuse", reason: expect.stringMatching(/hatchery-pending/) });
  });

  it("treats a closed PR as nothing to close", () => {
    const state = loopState({
      raw: { slices: { s: { stage: "pr-open" } } },
      perSlice: { s: { pr: { number: 7, state: "CLOSED" } } },
      requeueRequests: [req("s")],
    });
    expect(assess(state)[0]).toMatchObject({ action: "requeue", prNumber: null });
  });

  it("skips a request whose seq was already handled (its tombstone not yet drained back)", () => {
    const state = askedAndDied();
    state.raw.requeue_handled_seq = { s: 10 };
    expect(assess(state)).toEqual([]);
    state.requeueRequests = [req("s", { seq: 11 })];
    expect(assess(state)).toHaveLength(1);
  });
});

describe("requeue apply", () => {
  it("dead untracked session: registers the slice's workspace into Brood, tears it down, tombstones", async () => {
    const state = askedAndDied();
    const c = ctx({
      broodTeardown: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, notTracked: true, detail: "404" })
        .mockResolvedValueOnce({ ok: true, notTracked: false, detail: "ok" }),
    });
    const d = deps();
    const res = await apply(assess(state), c, state, d);

    expect(c.broodRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dead-1",
        kind: "steward",
        agentDeckSessionId: "dead-1",
        repoPath: "/repo",
        worktreePath: "/wt/s",
        branch: "feature/smithy/cut/s",
      }),
    );
    expect(c.broodTeardown).toHaveBeenLastCalledWith("dead-1", expect.objectContaining({ force: true, reason: "operator-requeue" }));
    expect(d.deleteRemoteBranch).toHaveBeenCalledWith("/repo", "feature/smithy/cut/s", "s");
    expect(d.closePr).not.toHaveBeenCalled();
    expect(state.raw.slices.s).toBeUndefined();
    expect(state.perSlice.s).toBeUndefined();
    expect(state.raw.requeue_handled_seq).toEqual({ s: 10 });
    expect(emitted(c)).toEqual([{ type: "slice.recovery.requested", sliceId: "s", rung: 3 }]);
    expect(res.actions[0]).toMatchObject({ kind: "requeue", action: "requeue-done", slice_id: "s", operator: "jb", reason: "asked then died" });
  });

  it("live tracked session: tears down through Brood directly and drops the session from the snapshot", async () => {
    const state = askedAndDied();
    state.sessionsById.set("dead-1", { id: "dead-1", status: "running" });
    state.sessions.push({ id: "dead-1", status: "running" });
    const c = ctx();
    await apply(assess(state), c, state, deps());
    expect(c.broodTeardown).toHaveBeenCalledTimes(1);
    expect(c.broodRegister).not.toHaveBeenCalled();
    expect(state.sessionsById.has("dead-1")).toBe(false);
  });

  it("closePr: closes the open PR with an attribution comment after teardown", async () => {
    const state = loopState({
      raw: { slices: { s: { stage: "pr-open", worker_session_id: "x", worktree_path: "/wt/s", branch: "b" } } },
      perSlice: { s: { pr: { number: 7, state: "OPEN" } } },
      requeueRequests: [req("s", { closePr: true, operator: "jb", reason: "off the rails" })],
    });
    const d = deps({ deleteRemoteBranch: vi.fn().mockResolvedValue(true) });
    const res = await apply(assess(state), ctx(), state, d);
    expect(d.closePr).toHaveBeenCalledWith("/repo", 7, expect.stringMatching(/by jb: off the rails/), "s");
    expect(res.actions[0].detail).toMatch(/closed PR #7; deleted remote branch feature\/b/);
  });

  it("failed spawn (no session, worktree or PR recorded): reclaims agent-deck's real feature/ branch + git's worktree for it", async () => {
    // The branch_collision incident: the fold kept only the symbolic dispatch
    // branch, so the old handler registered `smithy/forge/x` with no worktree and
    // Brood "tore down" a branch that never existed — the orphan survived.
    const state = loopState({
      repoPath: "/home/u/Dev/March",
      raw: { slices: { x: { stage: "escalated", branch: "smithy/forge/x" } } },
      requeueRequests: [req("x")],
    });
    const c = ctx();
    const findWorktreeForBranch = vi.fn().mockReturnValue("/home/u/Dev/WorkTrees/March/feature-smithy-forge-x");
    const d = deps({ findWorktreeForBranch });
    const res = await apply(assess(state), c, state, d);
    expect(findWorktreeForBranch).toHaveBeenCalledWith("/home/u/Dev/March", "feature/smithy/forge/x");
    expect(c.broodRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/home/u/Dev/March",
        worktreePath: "/home/u/Dev/WorkTrees/March/feature-smithy-forge-x",
        branch: "feature/smithy/forge/x",
      }),
    );
    expect(d.deleteRemoteBranch).toHaveBeenCalledWith("/home/u/Dev/March", "feature/smithy/forge/x", "x");
    expect(res.actions[0]).toMatchObject({ action: "requeue-done" });
  });

  it("never registers a name-derived worktree: no git record for the branch means branch-only teardown", async () => {
    // `smithy/forge/a/b` and `smithy/forge/a-b` derive the same directory; Brood
    // force-removes what it is given, so a guess could delete another checkout.
    const state = loopState({
      repoPath: "/home/u/Dev/March",
      raw: { slices: { x: { stage: "escalated", branch: "smithy/forge/a/b" } } },
      requeueRequests: [req("x")],
    });
    const c = ctx();
    await apply(assess(state), c, state, deps({ findWorktreeForBranch: vi.fn().mockReturnValue(undefined) }));
    const registered = (c.broodRegister as any).mock.calls[0][0];
    expect(registered).toMatchObject({ branch: "feature/smithy/forge/a/b" });
    expect(registered.worktreePath).toBeUndefined();
  });

  it("refusal clears the request and records it", async () => {
    const state = loopState({
      raw: { slices: { s: { stage: "pr-open" } } },
      perSlice: { s: { pr: { number: 7, state: "OPEN" } } },
      requeueRequests: [req("s")],
    });
    const c = ctx();
    const res = await apply(assess(state), c, state, deps());
    expect(emitted(c)).toEqual([expect.objectContaining({ type: "slice.requeue.refused", sliceId: "s" })]);
    expect(res.actions[0]).toMatchObject({ action: "requeue-refused" });
    expect(state.raw.slices.s).toBeDefined();
  });

  it("failed teardown does not tombstone; gives up and rings the operator after the attempt budget", async () => {
    const state = askedAndDied();
    const c = ctx({ broodTeardown: vi.fn().mockResolvedValue({ ok: false, notTracked: false, detail: "castra down" }) });
    for (let i = 1; i < MAX_REQUEUE_ATTEMPTS; i++) {
      const res = await apply(assess(state), c, state, deps());
      expect(res.actions[0]).toMatchObject({ action: "requeue-failed", attempts: i });
      expect(state.raw.slices.s).toBeDefined();
      expect(emitted(c)).toEqual([]);
    }
    const res = await apply(assess(state), c, state, deps());
    expect(res.actions[0]).toMatchObject({ action: "requeue-failed", attempts: MAX_REQUEUE_ATTEMPTS });
    expect(emitted(c)).toEqual([expect.objectContaining({ type: "slice.requeue.refused", sliceId: "s" })]);
    expect(c.requestJudgement).toHaveBeenCalledWith(expect.objectContaining({ reason: "requeue-failed", requestKey: "requeue-failed:s" }));
    expect(res.requests).toHaveLength(1);
    expect(state.raw.slices.s).toBeDefined();
    // Handled: the same request is not retried again.
    expect(assess(state)).toEqual([]);
  });

  it("nothing on disk and no session: tombstones without touching Brood", async () => {
    const state = loopState({ raw: { slices: { s: { stage: "implementing" } } }, requeueRequests: [req("s")] });
    const c = ctx();
    const res = await apply(assess(state), c, state, deps());
    expect(c.broodTeardown).not.toHaveBeenCalled();
    expect(res.actions[0]).toMatchObject({ action: "requeue-done" });
  });
});

describe("requeue of an archived hold (#592)", () => {
  const archivedState = (terminal_state: string, request: RequeueRequest) =>
    loopState({
      raw: { archived_slices: { s: { command: "smithy.forge", branch: "smithy/forge/s", pr_number: 333, terminal_state } } },
      requeueRequests: [request],
    });

  it("releases an archived CLOSED slice: no teardown, deletes the leftover branch, tombstones", async () => {
    const state = archivedState("CLOSED", req("s"));
    const c = ctx();
    const d = deps({ deleteRemoteBranch: vi.fn().mockResolvedValue(true) });
    const decisions = assess(state);
    expect(decisions).toEqual([expect.objectContaining({ sliceId: "s", action: "release-archived", terminal: "CLOSED" })]);
    const res = await apply(decisions, c, state, d);
    expect(c.broodTeardown).not.toHaveBeenCalled();
    expect(d.closePr).not.toHaveBeenCalled();
    expect(d.deleteRemoteBranch).toHaveBeenCalledWith("/repo", "feature/smithy/forge/s", "s");
    expect(emitted(c)).toEqual([{ type: "slice.recovery.requested", sliceId: "s", rung: 3 }]);
    expect(state.raw.archived_slices.s).toBeUndefined();
    expect(res.actions[0]).toMatchObject({ action: "requeue-done", archived: true, terminal: "CLOSED" });
  });

  it("refuses an archived MERGED slice without releaseMerged, and releases it with it", async () => {
    const refused = archivedState("MERGED", req("s"));
    expect(assess(refused)).toEqual([expect.objectContaining({ action: "refuse", reason: expect.stringMatching(/releaseMerged/) })]);

    const state = archivedState("MERGED", req("s", { releaseMerged: true }));
    const c = ctx();
    const d = deps();
    await apply(assess(state), c, state, d);
    expect(d.deleteRemoteBranch).toHaveBeenCalledWith("/repo", "feature/smithy/forge/s", "s");
    expect(emitted(c)).toEqual([{ type: "slice.recovery.requested", sliceId: "s", rung: 3 }]);
  });

  it("reads the fold's PR state when the archive lacks a terminal outcome", () => {
    const state = loopState({
      raw: { archived_slices: { s: { command: "smithy.forge", branch: "b" } } },
      perSlice: { s: { pr: { number: 9, state: "CLOSED" } } },
      requeueRequests: [req("s")],
    });
    expect(assess(state)).toEqual([expect.objectContaining({ action: "release-archived", terminal: "CLOSED" })]);
  });
});

describe("releasing an archived hold frees the plan row (#592 end to end)", () => {
  it("a row held as archived_closed dispatches once its archive is requeued", async () => {
    const item = { path: "docs/x.tasks.md", next_action: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"] } };
    const sid = dispatchSliceId(item);
    const state = loopState({
      raw: {
        archived_slices: {
          [sid]: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md", terminal_state: "CLOSED", pr_number: 333 },
        },
      },
      requeueRequests: [req(sid)],
    });
    expect(classifyReady(state.raw, [item])[0]).toMatchObject({ decision: "archived_closed", heldBy: { sliceId: sid, prNumber: 333 } });
    await apply(assess(state), ctx(), state, deps());
    expect(classifyReady(state.raw, [item])[0].decision).toBe("dispatch");
  });
});
