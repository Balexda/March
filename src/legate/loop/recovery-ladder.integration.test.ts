/**
 * @l1 @deterministic @ci
 *
 * Multi-tick integration for the graduated-recovery ladder (#413). Drives the
 * REAL coordinator pipeline (castra-recover → relaunch → … → recovery → dispatch)
 * across ticks against a stateful fake world, asserting the ladder walks
 * least-destructive-first: an operator recovery un-escalates a stuck slice so the
 * gentle owner (relaunch / castra-recover) heals it in place, and only descends to
 * the tombstone+fresh-dispatch nuke once the gentle budgets are spent.
 */
import { describe, expect, it, vi } from "vitest";
import { runTick, type CoordinatorDeps } from "./coordinator.js";
import type { HandlerContext, LoopState } from "./state/types.js";
import { relaunchRetryKey } from "./handlers/relaunch.js";

const NOW = "2026-06-21T00:00:00Z";
const GROUP = "legate-workers";

/** A tiny mutable world: the durable `raw` (threaded across ticks like the warm
 *  loop) plus the live Castra session list (mutated by launch/recover/remove). */
interface World {
  raw: any;
  sessions: { id: string; status: string; group: string }[];
  emitted: any[];
  launchAttempts: number;
}

function makeWorld(slice: any): World {
  return {
    raw: {
      slices: { s1: slice },
      archived_slices: {},
      transient_retry_counts: {},
      castra_recover_attempts: {},
      repo: { path: "/repo" },
    },
    sessions: [],
    emitted: [],
    launchAttempts: 0,
  };
}

/** Rebuild the per-tick snapshot from the durable raw + current live sessions —
 *  the warm-loop `sense()` analogue. Smithy stays empty so dispatch is quiet. */
function senseFrom(world: World): LoopState {
  const sessionsById = new Map(world.sessions.map((s) => [s.id, s]));
  return {
    ts: NOW,
    statePresent: true,
    stateError: null,
    raw: world.raw,
    slices: world.raw.slices,
    archived: world.raw.archived_slices,
    repoPath: "/repo",
    workerGroup: GROUP,
    sessions: world.sessions,
    sessionsById,
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice: {},
  };
}

/** A stateful Castra fake: launch adds a live session, recover flips errored →
 *  running, remove drops it. `launchOk:false` makes relaunch fail every attempt. */
function makeCtx(world: World, opts: { launchOk?: boolean } = {}): HandlerContext {
  let n = 0;
  const castra: any = {
    async launchSession() {
      world.launchAttempts++;
      if (opts.launchOk === false) throw new Error("launch failed");
      const id = "relaunched-" + ++n;
      world.sessions.push({ id, status: "running", group: GROUP });
      return { sessionId: id, worktreePath: "/wt/a" };
    },
    async sendPrompt() {},
    async removeSession({ sessionId }: any) {
      world.sessions = world.sessions.filter((s) => s.id !== sessionId);
      return { removed: true };
    },
    async recoverSessions(_p: string, _g: string, ids: string[]) {
      const recovered = ids.map((id) => {
        const s = world.sessions.find((x) => x.id === id);
        if (s) s.status = "running";
        return { sessionId: id, outcome: "recovered", finalStatus: "running", pickerResolved: false };
      });
      return { recovered };
    },
  };
  return {
    meta: { profile: "march", worker_group: GROUP, processor_name: "loop", paired_legate: "legate" } as any,
    ts: NOW,
    castra,
    broodTeardown: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    broodRegister: vi.fn(async () => ({ ok: true, detail: "" })),
    broodRetire: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    emitTransition: (e: any) => world.emitted.push(e),
    emit: vi.fn(),
    log: vi.fn(),
  } as any;
}

function deps(world: World, ctx: HandlerContext, recoveryRequests?: string[]): CoordinatorDeps {
  return {
    sense: async () => ({ ...senseFrom(world), ...(recoveryRequests ? { recoveryRequests } : {}) }),
    makeContext: () => ctx,
    babysit: { sendMessage: vi.fn(async () => {}), requestJudgement: vi.fn(async () => null) } as any,
    dispatch: {
      completePending: vi.fn(async () => ({ actions: [], failures: [], mutated: false, notifications: [] })),
      launchDispatch: vi.fn(async () => ({ actions: [], failures: [], mutated: false })),
      recoverDispatch: vi.fn(async () => ({ actions: [], failures: [], mutated: false })),
      requestJudgement: vi.fn(async () => null),
    } as any,
    relaunch: { worktreeExists: () => true, ensureWorktree: async () => {} },
  };
}

const recoveryActions = (out: any): string[] => out.results.recovery.actions.map((a: any) => a.action);

describe("graduated recovery ladder — multi-tick", () => {
  it("vanished session + open PR: un-escalate → relaunch on the PRESERVED worktree → complete (no drop)", async () => {
    const world = makeWorld({
      stage: "escalated",
      escalated_reason: "steward_stuck",
      worker_session_id: "dead",
      branch: "feature/a",
      worktree_path: "/wt/a",
      pr: { number: 9, url: "u", state: "OPEN" },
    });
    const ctx = makeCtx(world);

    // Tick 1: operator request → recovery un-escalates to pr-open at rung 1.
    let out = await runTick(deps(world, ctx, ["s1"]));
    expect(recoveryActions(out)).toContain("recovery-relaunch");
    expect(world.raw.slices.s1).toMatchObject({ stage: "pr-open", recovery_rung: 1, escalated_reason: undefined });
    expect(world.raw.slices.s1.worktree_path).toBe("/wt/a");
    expect(world.emitted).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 1 }));

    // Tick 2: relaunch (runs before recovery) re-attaches a steward on /wt/a.
    out = await runTick(deps(world, ctx));
    expect(out.results.relaunch.actions.map((a: any) => a.action)).toContain("relaunch-steward");
    expect(world.raw.slices.s1.worker_session_id).toBe("relaunched-1");
    expect(world.sessions.find((s) => s.id === "relaunched-1")?.status).toBe("running");

    // Tick 3: the relaunched session is now live in the snapshot → walk completes.
    out = await runTick(deps(world, ctx));
    expect(recoveryActions(out)).toContain("recovery-complete");
    expect(world.raw.slices.s1.recovery_rung).toBeUndefined();
    // The slice was never dropped — same incarnation throughout.
    expect(world.raw.slices.s1.stage).toBe("pr-open");
  });

  it("errored session: castra-recover restarts it in place — no drop, walk completes", async () => {
    const world = makeWorld({
      stage: "escalated",
      escalated_reason: "worker_error",
      worker_session_id: "sess1",
      branch: "feature/a",
      worktree_path: "/wt/a",
      pr: { number: 9, url: "u", state: "OPEN" },
    });
    world.sessions.push({ id: "sess1", status: "error", group: GROUP });
    const ctx = makeCtx(world);

    // Tick 1: castra-recover restarts the errored session (runs before recovery);
    // recovery sees a now-healthy, un-escalated slice → completes.
    let out = await runTick(deps(world, ctx, ["s1"]));
    expect(out.results.castraRecover.actions.map((a: any) => a.action)).toContain("castra-recover");
    expect(world.sessions.find((s) => s.id === "sess1")?.status).toBe("running");

    // Drive one more tick to settle: slice un-escalated, session live, no drop.
    out = await runTick(deps(world, ctx));
    expect(world.raw.slices.s1).toBeDefined();
    expect(world.raw.slices.s1.stage).not.toBe("escalated");
    expect(world.raw.slices.s1.recovery_rung).toBeUndefined();
  });

  it("full descent: relaunch never succeeds → rung 1 → 2 → 3 nuke (tombstone for fresh dispatch)", async () => {
    const world = makeWorld({
      stage: "escalated",
      escalated_reason: "steward_stuck",
      worker_session_id: "dead",
      branch: "feature/a",
      worktree_path: "/wt/a",
      pr: { number: 9, url: "u", state: "OPEN" },
    });
    const ctx = makeCtx(world, { launchOk: false }); // every relaunch attempt fails

    // Walk many ticks: rung-1 un-escalate, then 3 failing relaunch attempts, then
    // the rung-2 confirm hold, then the rung-3 nuke. Bounded loop guards runaway.
    let nuked = false;
    for (let i = 0; i < 8 && !nuked; i++) {
      const out = await runTick(deps(world, ctx, i === 0 ? ["s1"] : undefined));
      if (recoveryActions(out).includes("recovery-nuke")) nuked = true;
    }

    expect(nuked).toBe(true);
    // 3 relaunch attempts were genuinely made (budget exhausted) before the nuke.
    expect(world.launchAttempts).toBe(3);
    // The slice was tombstoned (dropped from the live set) for a fresh re-dispatch;
    // the nuke's dropRecoveredSlice then clears the slice's spent counters.
    expect(world.raw.slices.s1).toBeUndefined();
    expect(world.raw.transient_retry_counts[relaunchRetryKey("s1")]).toBeUndefined();
    expect(world.emitted).toContainEqual(expect.objectContaining({ type: "slice.recovery.requested", rung: 3 }));
  });
});
