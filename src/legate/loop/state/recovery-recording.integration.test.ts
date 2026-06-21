/**
 * @l1 @deterministic @ci
 *
 * Graduated-recovery RECORDING seams (#412 PR1), tested as round-trips rather than
 * in isolation. The recovery ladder is defined by the seams BETWEEN modules — a
 * handler emits a transition event, Herald folds it, the legate rebuilds its
 * working state from that fold on a cold start, and the next handler acts on the
 * rebuilt state. The unit tests in `events.test.ts` / `sense.test.ts` /
 * `relaunch.test.ts` each cover one module; these chain the real functions across
 * the module boundary so a regression in the HAND-OFF (not the individual fold or
 * rebuild) is caught.
 *
 * Scope note (per docs/rfcs/2026-002-layered-testing-framework): the ladder's
 * TRUE cross-service coverage — legate↔Herald↔Castra over HTTP, and the multi-tick
 * descent through the rungs — is an L2/L3 cassette concern whose substrate (M3+)
 * is not yet built. These are the in-process (`@l1`) round-trips that are
 * affordable on the $0 PR gate today; they exercise the same recording seams the
 * future L2 cassette scenario will, minus the wire.
 */
import { describe, expect, it, vi } from "vitest";
import { foldEvents, reduce, type HeraldEvent, type SystemState } from "../../../herald/events.js";
import { rebuildWorkingState } from "./sense.js";
import { apply, assess, type RelaunchDeps } from "../handlers/relaunch.js";
import type { HandlerContext, LoopState } from "./types.js";
import type { LoopMeta } from "../meta.js";

const meta = { worker_group: "legate-workers", repo: { name: "march", path: "/repo" } } as unknown as LoopMeta;

let seq = 0;
function ev(body: any): HeraldEvent {
  seq += 1;
  return { seq, id: `e${seq}`, ts: `2026-06-20T00:00:0${seq % 10}Z`, source: "legate", profile: "p", ...body };
}

/** A LoopState carrying just the fields the relaunch handler reads. */
function loopState(over: Partial<LoopState>): LoopState {
  return {
    ts: "T",
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

/** A relaunch HandlerContext whose castra launch is stubbed and whose emitted
 *  transition events are captured so they can be folded back into a projection. */
function relaunchCtx(
  launch: () => { sessionId: string | null; worktreePath?: string },
): { ctx: HandlerContext; emitted: any[] } {
  const emitted: any[] = [];
  const ctx = {
    meta: { profile: "p", worker_group: "legate-workers" } as any,
    ts: "T",
    castra: { launchSession: vi.fn(launch), sendPrompt: vi.fn(async () => {}) } as any,
    broodTeardown: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    broodRegister: vi.fn(async () => ({ ok: true, detail: "registered" })),
    broodRetire: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    emit: vi.fn(),
    emitTransition: vi.fn((body: any) => emitted.push(body)),
    log: vi.fn(),
  } as unknown as HandlerContext;
  return { ctx, emitted };
}

describe("steward.relaunched worktree round-trip (relaunch → fold → rebuild → assess) (#410/#412)", () => {
  it("the live worktree survives a cold-start rebuild and the next assess reuses it, not the colliding guess", async () => {
    seq = 0;
    const sliceId = "s1";
    // The path the assess-time fallback WOULD guess for branch feat-a + repo /repo,
    // and the DIFFERENT real path agent-deck minted at launch. The whole #410 bug is
    // that the guess collides with the branch's real worktree.
    const guessed = "/WorkTrees/repo/feature-feat-a";
    const live = "/wt/agentdeck-feat-a-9f3c";

    // ── Step 1: a slice whose steward vanished — relaunch fires and learns `live`.
    const slice = {
      stage: "pr-open",
      branch: "feat-a",
      pr: { number: 7, url: "http://pr/7" },
      worker_session_id: "dead",
      worktree_path: guessed,
    };
    const warm = loopState({ slices: { [sliceId]: slice }, raw: { slices: { [sliceId]: slice } } });
    const { ctx, emitted } = relaunchCtx(() => ({ sessionId: "fresh", worktreePath: live }));
    const deps: RelaunchDeps = { worktreeExists: () => true, ensureWorktree: vi.fn() };
    await apply(assess(warm), ctx, warm, deps);

    // The emitted transition carries the LIVE worktree (the recording fix).
    const relaunched = emitted.find((e) => e.type === "steward.relaunched");
    expect(relaunched).toMatchObject({ sliceId, sessionId: "fresh", worktreePath: live });

    // ── Step 2: fold the prior history + the emitted transitions into a projection,
    // exactly as Herald would (the legate POSTs these; Herald sequences + folds).
    const sys = foldEvents([
      ev({ type: "slice.dispatched", sliceId, branch: "feat-a", worktreePath: guessed, jobId: "job-1" }),
      ev({ type: "slice.stage.changed", sliceId, stage: "pr-open" }),
      ev({ type: "slice.pr.changed", sliceId, pr: { number: 7, state: "OPEN", url: "http://pr/7" } }),
      ...emitted.map((body) => ev(body)),
    ]);
    // The fold now records the live worktree, overwriting the dispatch-time guess.
    expect(sys.slices[sliceId]).toMatchObject({ sessionId: "fresh", worktreePath: live });

    // ── Step 3: cold-start rebuild — the worktree the relaunch learned is preserved.
    const rebuilt = rebuildWorkingState(sys, meta);
    expect(rebuilt.slices[sliceId]).toMatchObject({ worker_session_id: "fresh", worktree_path: live });

    // ── Step 4 (the payoff): if the steward vanishes AGAIN after the restart, a
    // fresh assess targets the RECORDED live worktree — not the colliding guess it
    // would have fallen back to before #412, which is the exact #410 dead-end.
    const cold = loopState({
      slices: rebuilt.slices,
      raw: rebuilt,
      sessions: [], // "fresh" is gone too → eligible for another relaunch
    });
    const decision = assess(cold).find((d) => d.sliceId === sliceId);
    expect(decision?.worktreePath).toBe(live);
    expect(decision?.worktreePath).not.toBe(guessed);
  });
});

describe("recovery preserve round-trip (fold → rebuild) (#412)", () => {
  // An escalated slice still carrying the facts the gentle rungs need.
  function escalatedFold(): SystemState {
    seq = 0;
    return foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", worktreePath: "/wt/a", jobId: "job-1" }),
      ev({ type: "slice.stage.changed", sliceId: "s1", stage: "pr-open" }),
      ev({ type: "slice.pr.changed", sliceId: "s1", pr: { number: 7, state: "OPEN", url: "http://pr/7" } }),
      ev({ type: "slice.escalated", sliceId: "s1", reason: "steward_stuck" }),
      ev({ type: "retry.counted", key: "relaunch-steward:s1", count: 2 }),
    ]);
  }

  it("begin-graduated recovery preserves durable facts through a cold-start rebuild", () => {
    const sys = foldEvents([ev({ type: "slice.recovery.requested", sliceId: "s1" })], escalatedFold());
    const rebuilt = rebuildWorkingState(sys, meta);
    // The slice is reconstructed (NOT dropped) with its branch/worktree/pr intact
    // and recovery_rung carried so the rung driver (PR2) resumes in place. The
    // escalation note is gone (execution state reset); the retry budget is cleared.
    expect(rebuilt.slices.s1).toMatchObject({
      branch: "feature/a",
      worktree_path: "/wt/a",
      pr: { number: 7, state: "OPEN", url: "http://pr/7" },
      recovery_rung: 0,
    });
    expect(rebuilt.slices.s1.escalated_reason).toBeUndefined();
    expect(rebuilt.transient_retry_counts["relaunch-steward:s1"]).toBeUndefined();
  });

  it("an inner-rung recovery resumes the ladder at that rung after a cold start", () => {
    const sys = foldEvents([ev({ type: "slice.recovery.requested", sliceId: "s1", rung: 2 })], escalatedFold());
    const rebuilt = rebuildWorkingState(sys, meta);
    expect(rebuilt.slices.s1).toMatchObject({ worktree_path: "/wt/a", recovery_rung: 2 });
  });

  it("rung:3 (last-resort nuke) tombstones the slice so the rebuild reconstructs nothing blocking", () => {
    const sys = foldEvents([ev({ type: "slice.recovery.requested", sliceId: "s1", rung: 3 })], escalatedFold());
    const rebuilt = rebuildWorkingState(sys, meta);
    // The tombstone is skipped by the rebuild — neither a live nor an archived entry —
    // so the still-ready smithy work re-dispatches fresh (the #238 behavior).
    expect(rebuilt.slices.s1).toBeUndefined();
    expect(rebuilt.archived_slices.s1).toBeUndefined();
  });
});
