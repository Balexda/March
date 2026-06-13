/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess, MAX_CLEANUP_ATTEMPTS } from "./cleanup.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import type { BroodRegisterResult, BroodTeardownResult } from "../clients/brood.js";

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    ts: "T",
    statePresent: true,
    stateError: null,
    raw: { slices: {}, archived_slices: {} },
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

interface CtxOverrides {
  register?: (input: any) => BroodRegisterResult;
  requestJudgement?: (input: any) => any;
}

/** A teardown stub that can return a different result per call (reconcile retry). */
function ctx(teardowns: BroodTeardownResult | BroodTeardownResult[], over: CtxOverrides = {}): HandlerContext {
  const queue = Array.isArray(teardowns) ? [...teardowns] : null;
  const single = Array.isArray(teardowns) ? null : teardowns;
  return {
    meta: { processor_name: "loop", paired_legate: "legate", profile: "march" } as any,
    ts: "T",
    castra: {} as any,
    broodTeardown: vi.fn(async () => (queue ? (queue.shift() ?? single ?? ok()) : single!)),
    broodRegister: over.register ? vi.fn(async (input: any) => over.register!(input)) : undefined,
    requestJudgement: over.requestJudgement ? vi.fn(async (input: any) => over.requestJudgement!(input)) : undefined,
    emit: vi.fn(),
    emitTransition: vi.fn(),
    log: vi.fn(),
  };
}

const ok = (): BroodTeardownResult => ({ ok: true, notTracked: false, detail: "" });
const notTracked = (): BroodTeardownResult => ({ ok: false, notTracked: true, detail: "not tracked by Brood" });
const failed = (): BroodTeardownResult => ({ ok: false, notTracked: false, detail: "castra unreachable" });
const registered = (): BroodRegisterResult => ({ ok: true, detail: "registered" });

describe("cleanup handler", () => {
  function withTerminalSlice(prState: string, opts: { live?: boolean } = { live: true }): LoopState {
    const session = { id: "sess", group: "legate-workers", branch: "feature/x", worktree_path: "/repo/.wt/x" };
    const sessionsById = new Map<string, any>();
    if (opts.live) sessionsById.set("sess", session);
    return loopState({
      raw: { slices: { s: { worker_session_id: "sess" } }, archived_slices: {} },
      slices: { s: { worker_session_id: "sess" } },
      // assess() matches on state.sessions; sessionsById models the live Castra observation.
      sessions: [session],
      sessionsById,
      perSlice: { s: { pr: { number: 9, url: "u", state: prState } } },
    });
  }

  it("assess flags MERGED/CLOSED PRs on active slices, ignores OPEN + sessionless", async () => {
    expect(assess(withTerminalSlice("MERGED")).map((d) => d.sliceId)).toEqual(["s"]);
    expect(assess(withTerminalSlice("CLOSED")).map((d) => d.terminalState)).toEqual(["CLOSED"]);
    expect(assess(withTerminalSlice("OPEN"))).toEqual([]);
    // no live session → not assessed
    const noSession = withTerminalSlice("MERGED");
    noSession.sessions = [];
    expect(assess(noSession)).toEqual([]);
  });

  it("apply requests Brood teardown then archives the slice on success", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(ok());
    const res = await apply(assess(state), c, state);
    expect(c.broodTeardown).toHaveBeenCalledWith("sess", { reason: "pr-merged", traceKey: "s" });
    expect(res.actions).toHaveLength(1);
    expect(state.raw.archived_slices.s).toMatchObject({ terminal_state: "MERGED", pr_number: 9 });
    expect(state.raw.slices.s).toBeUndefined();
    expect(state.sessionsById.has("sess")).toBe(false);
    // #175: a Herald slice.archived transition event is emitted on archive.
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "slice.archived", sliceId: "s" });
  });

  it("reconciles a live-but-untracked steward into Brood, then reaps + archives (#225)", async () => {
    const state = withTerminalSlice("MERGED");
    // First teardown 404s (untracked); after reconcile, the retry succeeds.
    const c = ctx([notTracked(), ok()], { register: registered });
    const res = await apply(assess(state), c, state);
    // Registered from the Castra observation by EXACT worktree/branch path (#155).
    expect(c.broodRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sess",
        kind: "steward",
        worktreePath: "/repo/.wt/x",
        branch: "feature/x",
        repoPath: "/repo",
        profile: "march",
        group: "legate-workers",
      }),
    );
    // Retry teardown forced after reconcile.
    expect(c.broodTeardown).toHaveBeenNthCalledWith(2, "sess", { force: true, reason: "pr-merged", traceKey: "s" });
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({ removed: true });
    expect(state.raw.archived_slices.s).toMatchObject({ terminal_state: "MERGED" });
    expect(state.raw.slices.s).toBeUndefined();
  });

  it("archives a 404 session that is genuinely gone (idempotent, nothing to tear down) (#225)", async () => {
    // notTracked AND no live session in Castra → nothing to reap.
    const state = withTerminalSlice("MERGED", { live: false });
    const c = ctx(notTracked(), { register: registered });
    const res = await apply(assess(state), c, state);
    expect(c.broodRegister).not.toHaveBeenCalled();
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({ removed: false, note: "untracked-and-absent" });
    expect(state.raw.archived_slices.s).toMatchObject({ terminal_state: "MERGED" });
    expect(state.raw.slices.s).toBeUndefined();
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "slice.archived", sliceId: "s" });
  });

  it("DEFERS (does not archive) when reconcile fails to register", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(notTracked(), { register: () => ({ ok: false, detail: "brood down" }) });
    const res = await apply(assess(state), c, state);
    expect(res.failures).toHaveLength(1);
    expect(res.actions).toHaveLength(0);
    expect(state.raw.slices.s).toBeTruthy();
    expect(state.raw.archived_slices.s).toBeUndefined();
    expect(c.emitTransition).not.toHaveBeenCalled();
  });

  it("DEFERS (does not archive) on a genuine teardown failure", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(failed());
    const res = await apply(assess(state), c, state);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({ attempts: 1 });
    expect(res.actions).toHaveLength(0);
    expect(state.raw.slices.s).toBeTruthy();
    expect(state.raw.archived_slices.s).toBeUndefined();
  });

  it("defers (does not archive) a 404 reconcile when the observation lacks an exact worktree path (#155)", async () => {
    const state = withTerminalSlice("MERGED");
    // Live, but no worktree_path → Brood could not reclaim by exact path.
    state.sessionsById.set("sess", { id: "sess", group: "legate-workers", branch: "feature/x" });
    const c = ctx(notTracked(), { register: registered });
    const res = await apply(assess(state), c, state);
    expect(c.broodRegister).not.toHaveBeenCalled();
    expect(res.failures).toHaveLength(1);
    expect(res.actions).toHaveLength(0);
    expect(state.raw.slices.s).toBeTruthy();
    expect(state.raw.archived_slices.s).toBeUndefined();
  });

  it("reconciles by canonical session id even when the slice matched by alias (P1)", async () => {
    // Slice references the session by its title alias; the canonical id is "real-id".
    const session = { id: "real-id", title: "sess", group: "legate-workers", branch: "feature/x", worktree_path: "/repo/.wt/x" };
    const sessionsById = new Map<string, any>([
      ["real-id", session],
      ["sess", session], // alias key (sense.ts maps id, title, and name)
    ]);
    const state = loopState({
      raw: { slices: { s: { worker_session_id: "sess" } }, archived_slices: {} },
      slices: { s: { worker_session_id: "sess" } },
      sessions: [session],
      sessionsById,
      perSlice: { s: { pr: { number: 9, url: "u", state: "MERGED" } } },
    });
    const c = ctx([notTracked(), ok()], { register: registered });
    await apply(assess(state), c, state);
    // Registered + torn down under the CANONICAL id, never the alias.
    expect(c.broodRegister).toHaveBeenCalledWith(
      expect.objectContaining({ id: "real-id", agentDeckSessionId: "real-id" }),
    );
    expect(c.broodTeardown).toHaveBeenNthCalledWith(2, "real-id", { force: true, reason: "pr-merged", traceKey: "s" });
  });

  it("escalates to the operator after MAX_CLEANUP_ATTEMPTS instead of retrying forever (#225)", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(failed(), { requestJudgement: () => ({ kind: "processor_request" }) });
    // Pre-load the attempt counter so this tick crosses the threshold.
    state.slices.s.cleanup_attempts = MAX_CLEANUP_ATTEMPTS - 1;
    const res = await apply(assess(state), c, state);
    expect(c.requestJudgement).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cleanup-stuck", requestKey: "cleanup-stuck:s", sliceId: "s" }),
    );
    expect(res.failures[0]).toMatchObject({ escalated: true, attempts: MAX_CLEANUP_ATTEMPTS });
    // The fired request is counted (pushed to res.requests), mirroring babysit/dispatch.
    expect(res.requests).toHaveLength(1);
    // Still deferred (not archived) — escalation surfaces it, doesn't archive over an orphan.
    expect(state.raw.slices.s).toBeTruthy();
  });

  it("does not mark escalated (or count a request) when requestJudgement dedups to null", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(failed(), { requestJudgement: () => null });
    state.slices.s.cleanup_attempts = MAX_CLEANUP_ATTEMPTS - 1;
    const res = await apply(assess(state), c, state);
    expect(c.requestJudgement).toHaveBeenCalled();
    expect(res.failures[0].escalated).toBeUndefined();
    expect(res.requests).toHaveLength(0);
  });

  it("does NOT escalate before the threshold", async () => {
    const state = withTerminalSlice("MERGED");
    const c = ctx(failed(), { requestJudgement: () => ({ kind: "processor_request" }) });
    const res = await apply(assess(state), c, state);
    expect(c.requestJudgement).not.toHaveBeenCalled();
    expect(res.failures[0].escalated).toBeUndefined();
  });
});
