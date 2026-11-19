/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess, MAX_REQUEUE_ATTEMPTS, type RequeueDeps } from "./requeue.js";
import type { HandlerContext, LoopState, RequeueRequest } from "../state/types.js";

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
        branch: "smithy/cut/s",
      }),
    );
    expect(c.broodTeardown).toHaveBeenLastCalledWith("dead-1", expect.objectContaining({ force: true, reason: "operator-requeue" }));
    expect(d.deleteRemoteBranch).toHaveBeenCalledWith("/repo", "smithy/cut/s", "s");
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
    expect(res.actions[0].detail).toMatch(/closed PR #7; deleted remote branch b/);
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
