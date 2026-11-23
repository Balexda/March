/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_RECOVER_ATTEMPTS } from "./castra-recover.js";
import { apply, assess, relaunchBackoffMs, RELAUNCH_BACKOFF_MAX_MS, type RelaunchDeps } from "./relaunch.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import { relaunchGeneration, resendStillCurrent } from "../http.js";
import { resendWithDeps } from "../operator-resend.js";

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

  it("no longer hard-stops at a retry count — it keeps retrying (backs off instead)", async () => {
    // With the old hard cap a slice at count 3 was parked forever. Now it stays
    // selectable (the backoff timer, not a fixed limit, paces it). ts is not a
    // real date here so the backoff gate can't fire → eligible, attempt 4.
    const state = loopState({
      slices: { gone: eligibleSlice() },
      raw: { slices: {}, transient_retry_counts: { "relaunch-steward:gone": 3 } },
    });
    const decisions = assess(state);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ sliceId: "gone", mode: "auto", attempt: 4 });
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
    // #175: Herald steward.relaunched + retry.counted transition events. The
    // relaunch now records the LIVE worktree (#410/#412) — here the launch reported
    // none, so it falls back to the decision's worktree path.
    expect(c.emitTransition).toHaveBeenCalledWith({
      type: "steward.relaunched",
      sliceId: "gone",
      sessionId: "fresh",
      worktreePath: "/home/u/Development/WorkTrees/March/feature-feat-a",
    });
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
    // …and the steward.relaunched event records that SAME live worktree so a
    // cold-start rebuild keeps it (#410/#412), not the assess-time guess.
    expect(c.emitTransition).toHaveBeenCalledWith({
      type: "steward.relaunched",
      sliceId: "gone",
      sessionId: "fresh",
      worktreePath: "/wt/feature-feat-a-newhash",
    });
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

  it("retries deferred prior-steward teardown without relaunching again", async () => {
    const slice = eligibleSlice({ worker_session_id: "old", worktree_path: "/wt/feature-feat-a-oldhash" });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    let ok = false;
    const c = ctx(() => ({ sessionId: "new", worktreePath: "/wt/feature-feat-a-newhash" }), {
      teardown: () => ok
        ? { ok: true, notTracked: false, detail: "" }
        : { ok: false, notTracked: false, deferred: true, detail: "tearing-down" },
    });
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };

    await apply(assess(state), c, state, deps);
    expect(slice.worker_session_id).toBe("new");
    ok = true;
    await apply([], c, state, deps);
    await apply([], c, state, deps);
    expect(c.broodTeardown).toHaveBeenCalledTimes(2);
    expect(c.broodTeardown).toHaveBeenLastCalledWith("old", {
      force: true, reason: "steward-relaunch", traceKey: "gone",
    });
    expect(c.castra.launchSession).toHaveBeenCalledTimes(1);
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
    // FIX 2: the FAILED attempt is counted against the budget (else it would
    // retry every tick forever) and durably recorded via retry.counted.
    expect(state.raw.transient_retry_counts["relaunch-steward:gone"]).toBe(1);
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "retry.counted", key: "relaunch-steward:gone", count: 1 });
  });

  it("a failing auto relaunch backs off, then becomes eligible again after the cooldown", async () => {
    const t0 = "2026-06-26T00:00:00.000Z";
    const slice = eligibleSlice();
    const state = loopState({ ts: t0, slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const c = { ...ctx(() => { throw new Error("castra down"); }), ts: t0 };
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };

    const res = await apply(assess(state), c, state, deps);
    expect(res.actions[0]).toMatchObject({ action: "relaunch-failed" });
    // A backoff window was scheduled in the future…
    const until = state.raw.relaunch_backoff_until.gone;
    expect(until).toBeGreaterThan(Date.parse(t0));
    // …so an immediate re-assess (same tick time) skips it — no churn.
    expect(assess(state)).toEqual([]);
    // Once the cooldown elapses it is selectable again (retries indefinitely).
    state.ts = "2026-06-26T01:00:00.000Z";
    const later = assess(state);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ sliceId: "gone", attempt: 2 });
  });

  it("auto path: AIMD caps attempts at the rate and increases it after a clean sweep", async () => {
    // Three stranded slices but rate 1 → only the longest-waiting is attempted,
    // flagged rate-limited; a clean success bumps the rate to 2.
    const mk = () => eligibleSlice();
    const slices = { a: mk(), b: mk(), c: mk() };
    const state = loopState({ slices, raw: { slices, recovery_rate: 1 } });
    const decisions = assess(state);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ mode: "auto", autoRateLimited: true });

    const c = ctx(() => ({ sessionId: "fresh" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(decisions, c, state, deps);
    expect(state.raw.recovery_rate).toBe(2); // additive increase
  });

  it("auto path: any failure halves the AIMD rate (multiplicative decrease)", async () => {
    const slice = eligibleSlice();
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice }, recovery_rate: 4 } });
    const c = ctx(() => { throw new Error("castra down"); });
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(assess(state), c, state, deps);
    expect(state.raw.recovery_rate).toBe(2); // 4 → 2
  });

  it("auto path: covers an escalated-infra slice with a dead steward by un-escalating it", async () => {
    const slice = eligibleSlice({ stage: "escalated", escalated_reason: "hatchery_dispatch_failed" });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const decisions = assess(state);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ mode: "auto", unescalateStage: "pr-open" });

    const c = ctx(() => ({ sessionId: "fresh" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(decisions, c, state, deps);
    expect(slice.stage).toBe("pr-open");
    expect((slice as any).escalated_reason).toBeUndefined();
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "gone", stage: "pr-open" });
    expect(slice.worker_session_id).toBe("fresh");
  });

  it("auto path: recovers a human-hold (awaiting_input) slice once its steward session is GONE", async () => {
    // A dead session has no live prompt for the operator to answer, so the
    // human-hold reason no longer holds — the slice is un-escalated + relaunched
    // (non-destructive). Drains the false-positive backlog with no operator input.
    const slice = eligibleSlice({ stage: "escalated", escalated_reason: "steward_awaiting_input" });
    const state = loopState({ slices: { gone: slice }, raw: { slices: { gone: slice } } });
    const decisions = assess(state);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ mode: "auto", unescalateStage: "pr-open" });

    const c = ctx(() => ({ sessionId: "fresh" }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(decisions, c, state, deps);
    expect(slice.stage).toBe("pr-open");
    expect((slice as any).escalated_reason).toBeUndefined();
    expect(slice.worker_session_id).toBe("fresh");
  });

  it("auto path: still HOLDS an awaiting_input slice whose steward session is LIVE (operator can answer)", async () => {
    const slice = eligibleSlice({
      stage: "escalated",
      escalated_reason: "steward_awaiting_input",
      worker_session_id: "live",
    });
    const state = loopState({
      slices: { hold: slice },
      raw: { slices: { hold: slice } },
      sessions: [{ id: "live", group: "legate-workers" }],
    });
    expect(assess(state)).toEqual([]);
  });

  it("ladder path: a recovery_rung slice keeps the bounded, backoff-free behavior", async () => {
    // Even with a future backoff timer, an operator-driven (ladder) slice is
    // selected every tick until RELAUNCH_LIMIT — the operator path stays prompt.
    const slice = eligibleSlice({ recovery_rung: 1 });
    const state = loopState({
      ts: "2026-06-26T00:00:00.000Z",
      slices: { gone: slice },
      raw: {
        slices: { gone: slice },
        relaunch_backoff_until: { gone: Date.parse("2030-01-01T00:00:00.000Z") },
      },
    });
    const decisions = assess(state);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ mode: "ladder", attempt: 1, limit: 3 });
  });

  it("relaunchBackoffMs grows exponentially and is deterministic per slice", async () => {
    const a1 = relaunchBackoffMs(1, "slice-x");
    const a2 = relaunchBackoffMs(2, "slice-x");
    const a3 = relaunchBackoffMs(3, "slice-x");
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    // Deterministic: same inputs → same output (cold-start / test stable).
    expect(relaunchBackoffMs(1, "slice-x")).toBe(a1);
    // Plateaus at the cap (with up to +20% jitter).
    expect(relaunchBackoffMs(99, "slice-x")).toBeLessThanOrEqual(Math.round(RELAUNCH_BACKOFF_MAX_MS * 1.2));
  });
});

describe("operator relaunch (#593)", () => {
  const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn(async () => {}) };
  const emitted = (c: HandlerContext): any[] => (c.emitTransition as any).mock.calls.map((a: any[]) => a[0]);

  it("replaces a LIVE steward: removes its session (keeping the worktree) then launches a fresh one", async () => {
    const raw = { slices: { s: eligibleSlice({ worker_session_id: "live", worktree_path: "/wt/s" }) } };
    const live = { id: "live", group: "legate-workers" };
    const state = loopState({
      raw,
      slices: raw.slices,
      sessions: [live],
      sessionsById: new Map([["live", live]]),
      relaunchRequests: [{ sliceId: "s", seq: 12 }],
    });
    const decisions = assess(state);
    expect(decisions).toEqual([expect.objectContaining({ sliceId: "s", mode: "operator", requestSeq: 12 })]);

    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/s" }));
    c.castra.removeSession = vi.fn(async () => ({ removed: true }));
    const res = await apply(decisions, c, state, deps);
    expect(c.castra.removeSession).toHaveBeenCalledWith({ profile: "p", sessionId: "live", pruneWorktree: false, traceKey: "s" });
    expect(c.castra.launchSession).toHaveBeenCalledTimes(1);
    expect(state.slices.s.worker_session_id).toBe("fresh");
    expect(emitted(c)).toContainEqual({ type: "steward.relaunched", sliceId: "s", sessionId: "fresh", worktreePath: "/wt/s", requestSeq: 12 });
    expect(res.actions[0]).toMatchObject({ action: "relaunch-steward", detail: expect.stringContaining("operator request") });
    // No retry budget is spent, and the settled request is not re-read next tick.
    expect((state.raw as any).transient_retry_counts).toBeUndefined();
    expect(assess(state).filter((d) => d.mode === "operator")).toEqual([]);
  });

  it("marks the slice relaunching across its awaits, so an overlapping resend is not recorded", async () => {
    const raw = { slices: { s: eligibleSlice({ worker_session_id: "live", worktree_path: "/wt/s" }) } };
    const live = { id: "live", group: "legate-workers" };
    const state = loopState({
      raw,
      slices: raw.slices,
      sessions: [live],
      sessionsById: new Map([["live", live]]),
      relaunchRequests: [{ sliceId: "s", seq: 12 }],
    });
    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/s" }));
    c.castra.removeSession = vi.fn(async () => ({ removed: true }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const launch = c.castra.launchSession as any;
    c.castra.launchSession = vi.fn(async (...args: any[]) => {
      await gate;
      return launch(...args);
    }) as any;
    const slice = state.slices.s;
    const before = relaunchGeneration(slice); // what a resend captures before its send
    const running = apply(assess(state), c, state, deps);
    await vi.waitFor(() => expect(c.castra.launchSession).toHaveBeenCalled());
    // Mid-relaunch: the old session is still bound, but a resend that delivered
    // to it now must not record its comment ids as handled.
    expect(slice.worker_session_id).toBe("live");
    expect(slice.relaunch_in_progress).toBe(true);
    expect(resendStillCurrent(slice, slice, "live", before)).toBe(false);
    release();
    await running;
    expect(slice.worker_session_id).toBe("fresh");
    expect(slice.relaunch_in_progress).toBeUndefined();
    expect(resendStillCurrent(slice, slice, "fresh", relaunchGeneration(slice))).toBe(true);
  });

  it("removal succeeds, launch fails, then a pending resend returns: it is not recorded", async () => {
    const raw = { slices: { s: eligibleSlice({ worker_session_id: "live", worktree_path: "/wt/s" }) } };
    const live = { id: "live", group: "legate-workers" };
    const state = loopState({
      raw,
      slices: raw.slices,
      sessions: [live],
      sessionsById: new Map([["live", live]]),
      relaunchRequests: [{ sliceId: "s", seq: 3 }],
    });
    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/s" }));
    c.castra.removeSession = vi.fn(async () => ({ removed: true }));
    c.castra.launchSession = vi.fn(async () => {
      throw new Error("castra down");
    }) as any;
    const slice = state.slices.s;
    const before = relaunchGeneration(slice); // resend captured this, then awaited its send
    c.broodRetire = vi.fn(async () => ({ ok: true }) as any);
    await apply(assess(state), c, state, deps);
    expect(c.castra.removeSession).toHaveBeenCalled();
    // The removed steward's Brood row is retired even though no replacement launched.
    expect(c.broodRetire).toHaveBeenCalledWith("live");
    // The relaunch is over and the removed session is still bound, but the
    // generation moved, so the resend's late return refuses to record.
    expect(slice.relaunch_in_progress).toBeUndefined();
    expect(slice.worker_session_id).toBe("live");
    expect(resendStillCurrent(slice, slice, "live", before)).toBe(false);
  });

  it("resendReviewThreads: a send held across a removal-then-failed-launch relaunch returns 409 and records nothing", async () => {
    const raw = {
      slices: {
        s: eligibleSlice({ worker_session_id: "live", worktree_path: "/wt/s", stage: "pr-open", pr: { number: 9 } }),
      },
    };
    const live = { id: "live", group: "legate-workers" };
    const state = loopState({
      raw,
      slices: raw.slices,
      sessions: [live],
      sessionsById: new Map([["live", live]]),
      relaunchRequests: [{ sliceId: "s", seq: 3 }],
    });
    const c = ctx(() => ({ sessionId: "fresh", worktreePath: "/wt/s" }));
    c.castra.removeSession = vi.fn(async () => ({ removed: true }));
    c.castra.launchSession = vi.fn(async () => {
      throw new Error("castra down");
    }) as any;
    const slice = state.slices.s;
    const observed = { number: 9, unresolved_threads: [{ id: "t1", comment_ids: ["c1"] }] };

    // Hold the steward send open until the relaunch has removed the session and
    // failed to launch a replacement.
    let delivered!: () => void;
    const sendHeld = new Promise<void>((r) => (delivered = r));
    const send = vi.fn(async () => sendHeld);
    const record = vi.fn(async () => null);
    const resend = resendWithDeps({ profile: "p", sliceId: "s", threadIds: ["t1"] }, slice, observed, {
      send,
      currentSlice: () => state.raw.slices.s,
      record,
      now: () => "T",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("live", expect.any(String)));

    await apply(assess(state), c, state, deps);
    expect(c.castra.removeSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live" }));
    expect(slice.worker_session_id).toBe("live"); // the removed session is still bound
    expect(slice.relaunch_in_progress).toBeUndefined();

    delivered();
    const { result, attributes } = await resend;
    expect(result).toMatchObject({ ok: false, status: 409, delivered: true, threadIds: ["t1"], commentIds: ["c1"] });
    expect(attributes).toEqual({ "march.failure_stage": "incarnation" });
    // Nothing recorded: no handled ids on the warm slice and no feedback event.
    expect(record).not.toHaveBeenCalled();
    expect(slice.review_fix_seen_comment_ids).toBeUndefined();
    expect(slice.review_fix_rounds).toBeUndefined();
    expect(slice.stage).toBe("pr-open");
  });

  it("resendReviewThreads records the resend when nothing overlapped it", async () => {
    const slice: any = eligibleSlice({ worker_session_id: "live", stage: "pr-open", pr: { number: 9 } });
    const record = vi.fn(async () => null);
    const { result } = await resendWithDeps(
      { profile: "p", sliceId: "s" },
      slice,
      { number: 9, unresolved_threads: [{ id: "t1", comment_ids: ["c1"] }] },
      { send: vi.fn(async () => {}), currentSlice: () => slice, record, now: () => "T" },
    );
    expect(result).toMatchObject({ ok: true, delivered: true, commentIds: ["c1"] });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "slice.stage.changed", handledFeedback: expect.objectContaining({ commentIds: ["c1"] }) }));
    expect(slice.review_fix_seen_comment_ids).toEqual(["c1"]);
  });

  it("un-escalates an escalated slice and ignores the self-heal backoff", async () => {
    // An ACTIVE backoff window: a real tick time, a deadline after it, and a prior
    // attempt (coolingDown needs all three).
    const ts = "2026-11-21T00:00:00.000Z";
    const raw = {
      slices: { s: eligibleSlice({ stage: "escalated", escalated_reason: "needs_human_judgement" }) },
      relaunch_backoff_until: { s: Date.parse(ts) + 60 * 60_000 },
      transient_retry_counts: { "relaunch-steward:s": 1 },
    };
    // Without the request the auto path holds the slice while it cools down…
    expect(assess(loopState({ ts, raw, slices: raw.slices })).filter((x) => x.sliceId === "s")).toEqual([]);
    // …and the operator request bypasses that same backoff.
    const state = loopState({ ts, raw, slices: raw.slices, relaunchRequests: [{ sliceId: "s", seq: 3 }] });
    const [d] = assess(state);
    expect(d).toMatchObject({ mode: "operator", unescalateStage: "pr-open" });
    const c = ctx(() => ({ sessionId: "fresh" }));
    await apply([d], c, state, deps);
    expect(state.slices.s.stage).toBe("pr-open");
    expect(emitted(c)).toContainEqual({ type: "slice.stage.changed", sliceId: "s", stage: "pr-open" });
  });

  it("refuses a slice with nothing to re-attach to, and a launch failure, without spending retry budget", async () => {
    const raw = { slices: { noPr: eligibleSlice({ pr: {} }), boom: eligibleSlice() } };
    const state = loopState({
      raw,
      slices: raw.slices,
      relaunchRequests: [{ sliceId: "noPr", seq: 1 }, { sliceId: "boom", seq: 2 }, { sliceId: "ghost", seq: 3 }],
    });
    const decisions = assess(state);
    expect(decisions.map((d) => [d.sliceId, d.refusal ? "refuse" : "go"])).toEqual([
      ["noPr", "refuse"],
      ["boom", "go"],
      ["ghost", "refuse"],
    ]);
    const c = ctx(() => {
      throw new Error("castra down");
    });
    await apply(decisions, c, state, deps);
    const refusals = emitted(c).filter((e) => e.type === "slice.operator.refused");
    expect(refusals.map((e) => e.sliceId)).toEqual(["noPr", "boom", "ghost"]);
    expect(refusals.every((e) => e.action === "relaunch")).toBe(true);
    expect(refusals[1].reason).toContain("castra down");
    expect(emitted(c).some((e) => e.type === "retry.counted")).toBe(false);
    expect(assess(state).filter((d) => d.mode === "operator")).toEqual([]);
  });

  it("an operator-owned slice is not also picked up by the auto path", () => {
    const raw = { slices: { s: eligibleSlice() } };
    const state = loopState({ raw, slices: raw.slices, relaunchRequests: [{ sliceId: "s", seq: 1 }] });
    expect(assess(state).map((d) => d.mode)).toEqual(["operator"]);
  });
});

describe("relaunch stopped stewards (#587)", () => {
  const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };

  it("leaves a stopped session alone while castra-recover still has budget (recovery_pending)", () => {
    const state = loopState({
      slices: { s: eligibleSlice({ worker_session_id: "w1" }) },
      sessions: [{ id: "w1", group: "legate-workers", status: "stopped", recovery_pending: true }],
    });
    expect(assess(state)).toEqual([]);
  });

  it("never replaces a stopped session whose restart budget isn't confirmed spent", () => {
    // e.g. a stale `stopped` observation of a session Castra already sees as live
    // (so the sweep returned no result for it and no recovery_pending was set).
    const state = loopState({
      slices: { s: eligibleSlice({ worker_session_id: "w1" }) },
      raw: { slices: {}, castra_recover_attempts: { w1: 1 } },
      sessions: [{ id: "w1", group: "legate-workers", status: "stopped" }],
    });
    expect(assess(state)).toEqual([]);
    const untouched = loopState({
      slices: { s: eligibleSlice({ worker_session_id: "w1" }) },
      sessions: [{ id: "w1", group: "legate-workers", status: "stopped" }],
    });
    expect(assess(untouched)).toEqual([]);
  });

  it("skips a budget-spent stopped session the sweep just touched (recovery_pending)", () => {
    const state = loopState({
      slices: { s: eligibleSlice({ worker_session_id: "w1" }) },
      raw: { slices: {}, castra_recover_attempts: { w1: MAX_RECOVER_ATTEMPTS } },
      sessions: [{ id: "w1", group: "legate-workers", status: "stopped", recovery_pending: true }],
    });
    expect(assess(state)).toEqual([]);
  });

  it("still treats errored and running listed sessions as present", () => {
    const state = loopState({
      slices: {
        e: eligibleSlice({ worker_session_id: "w-err" }),
        r: eligibleSlice({ worker_session_id: "w-run" }),
      },
      sessions: [
        { id: "w-err", group: "legate-workers", status: "error" },
        { id: "w-run", group: "legate-workers", status: "running" },
      ],
    });
    expect(assess(state)).toEqual([]);
  });

  it("relaunches a stopped steward whose restart budget is spent, dropping the stale session first", async () => {
    const slice = eligibleSlice({ worker_session_id: "w1", worktree_path: "/wt/feature-feat-a" });
    const state = loopState({
      slices: { s: slice },
      raw: { slices: { s: slice }, castra_recover_attempts: { w1: MAX_RECOVER_ATTEMPTS } },
      sessions: [{ id: "w1", group: "legate-workers", status: "stopped" }],
    });
    const decisions = assess(state);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ sliceId: "s", removeStaleSessionId: "w1" });

    const order: string[] = [];
    const c = ctx(() => {
      order.push("launch");
      return { sessionId: "fresh" };
    });
    c.castra.removeSession = vi.fn(async () => {
      order.push("remove");
    });
    const res = await apply(decisions, c, state, deps);

    expect(c.castra.removeSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "p", sessionId: "w1", pruneWorktree: false, traceKey: "s" }),
    );
    expect(order).toEqual(["remove", "launch"]);
    expect(slice.worker_session_id).toBe("fresh");
    expect(res.actions[0]).toMatchObject({ action: "relaunch-steward", sessionId: "fresh" });
    expect(res.actions[0].detail).toContain("dropped stopped session w1");
  });

  it("still relaunches when dropping the stale stopped session fails", async () => {
    const slice = eligibleSlice({ worker_session_id: "w1" });
    const state = loopState({
      slices: { s: slice },
      raw: { slices: { s: slice }, castra_recover_attempts: { w1: MAX_RECOVER_ATTEMPTS } },
      sessions: [{ id: "w1", group: "legate-workers", status: "stopped" }],
    });
    const c = ctx(() => ({ sessionId: "fresh" }));
    c.castra.removeSession = vi.fn(async () => {
      throw new Error("castra down");
    });
    const res = await apply(assess(state), c, state, deps);
    expect(c.castra.launchSession).toHaveBeenCalled();
    expect(res.actions[0]).toMatchObject({ action: "relaunch-steward", sessionId: "fresh" });
    expect(res.actions[0].detail).toContain("could not drop stopped session w1");
  });

  it("does not drop anything for a vanished session", async () => {
    const slice = eligibleSlice();
    const state = loopState({ slices: { s: slice }, raw: { slices: { s: slice } } });
    const decisions = assess(state);
    expect(decisions[0].removeStaleSessionId).toBeUndefined();
    const c = ctx(() => ({ sessionId: "fresh" }));
    c.castra.removeSession = vi.fn();
    await apply(decisions, c, state, deps);
    expect(c.castra.removeSession).not.toHaveBeenCalled();
  });
});
