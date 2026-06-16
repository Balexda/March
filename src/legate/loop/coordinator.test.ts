/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { runTick, type CoordinatorDeps } from "./coordinator.js";
import type { HandlerContext, LoopState } from "./state/types.js";
import { dispatchSliceId } from "./pure/dispatch-id.js";

const NOW = "2026-05-20T01:00:00Z";

function makeState(): LoopState {
  const raw = {
    slices: { merged: { worker_session_id: "m", stage: "pr-open" } },
    archived_slices: {},
    repo: { path: "/repo" },
  };
  return {
    ts: NOW,
    statePresent: true,
    stateError: null,
    raw,
    slices: raw.slices,
    archived: raw.archived_slices,
    repoPath: "/repo",
    workerGroup: "legate-workers",
    sessions: [{ id: "m", group: "legate-workers", status: "idle" }],
    sessionsById: new Map([["m", { id: "m" }]]),
    workers: { waiting: 0, running: 0, idle: 1, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    // PR is MERGED → cleanup terminal-PR path fires for this slice.
    perSlice: { merged: { pr: { number: 9, url: "u", state: "MERGED" }, recentOutput: { output: "" } } },
  };
}

function deps(state: LoopState, ctxOver: Partial<HandlerContext> = {}): CoordinatorDeps {
  const ctx: HandlerContext = {
    meta: { profile: "p", worker_group: "legate-workers", processor_name: "loop", paired_legate: "legate" } as any,
    ts: NOW,
    castra: {} as any,
    broodTeardown: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    emit: vi.fn(),
    log: vi.fn(),
    ...ctxOver,
  };
  return {
    sense: async () => state,
    makeContext: () => ctx,
    babysit: { sendMessage: vi.fn(async () => {}), requestJudgement: vi.fn(async () => null) },
    dispatch: {
      completePending: vi.fn(async () => ({ actions: [], failures: [], mutated: false, notifications: [] })),
      launchDispatch: vi.fn(async () => ({ actions: [], failures: [], mutated: false })),
      recoverDispatch: vi.fn(async () => ({ actions: [], failures: [], mutated: false })),
      requestJudgement: vi.fn(async () => null),
    },
  };
}

describe("coordinator runTick", () => {
  it("archives a terminal-PR slice and threads the mutation so babysit can't re-see it", async () => {
    const state = makeState();
    const babysitSend = vi.fn();
    const d = deps(state);
    d.babysit = { sendMessage: babysitSend, requestJudgement: vi.fn(async () => null) };

    const out = await runTick(d);

    // cleanup ran first: slice archived, session dropped from the live snapshot.
    expect(out.results.cleanup.actions).toHaveLength(1);
    expect(state.raw.archived_slices.merged).toMatchObject({ terminal_state: "MERGED" });
    expect(state.sessionsById.has("m")).toBe(false);
    // babysit, running later on the SAME mutated state, no longer sees session "m".
    expect(out.results.babysit.actions).toHaveLength(0);
    expect(babysitSend).not.toHaveBeenCalled();
  });

  it("aggregates a TickResult from the per-handler results + sensed snapshot", async () => {
    const state = makeState();
    state.smithy.queue = { dispatchable: 2, blocked: 1, total: 3 };
    const out = await await runTick(deps(state));

    expect(out.tick).toMatchObject({
      ts: NOW,
      statePresent: true,
      cleanupCount: 1,
      archivedSliceCount: 1,
      sliceCount: 0, // the only slice was archived + dropped
      queue: { dispatchable: 2, blocked: 1, total: 3 },
    });
  });

  it("counts a steward-stage slice with no live session as stranded in the TickResult", async () => {
    const state = makeState();
    // A pr-open slice whose steward session is NOT in the live session list, and
    // no PR/branch so relaunch/babysit leave it untouched — it should surface as
    // stranded (looks active, no resource behind it).
    state.raw.slices = { ghost: { stage: "pr-open", worker_session_id: "vanished" } } as any;
    state.slices = state.raw.slices;
    state.sessions = [{ id: "m", group: "legate-workers", status: "idle" }] as any; // "vanished" absent
    state.perSlice = {};

    const out = await runTick(deps(state));

    expect(out.tick.strandedCount).toBe(1);
  });

  it("drives the dispatch completion + selection seams", async () => {
    const state = makeState();
    const d = deps(state);
    await runTick(d);
    expect(d.dispatch.completePending).toHaveBeenCalledWith(state.raw, NOW);
  });

  it("recovers an escalated slice to a FRESH re-dispatch in the same tick (#238)", async () => {
    // A still-ready smithy item whose deterministic slice is escalated with its
    // recovery budget exhausted — the wedge #238 describes.
    const item = { path: "a.spec.md", next_action: { command: "smithy.forge", arguments: ["a.spec.md", "1"] }, parent_path: "a.spec.md" };
    const sliceId = dispatchSliceId(item);
    const raw = {
      slices: {
        [sliceId]: {
          stage: "escalated",
          escalated_reason: "hatchery_dispatch_failed",
          command: "smithy.forge",
          arguments: ["a.spec.md", "1"],
          artifact_path: "a.spec.md",
        },
      },
      archived_slices: {},
      transient_retry_counts: { ["dispatch-recovery:" + sliceId]: 2 },
      repo: { path: "/repo" },
    };
    const state: LoopState = {
      ts: NOW,
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
      smithy: { ok: true, ready: [item], queue: { dispatchable: 0, blocked: 0, total: 1 } },
      perSlice: {},
      recoveryRequests: [sliceId],
    };

    const d = deps(state);
    const out = await runTick(d);

    // recovery dropped the escalated slice + cleared its budget...
    expect(out.results.recovery.actions).toEqual([
      { action: "slice-recovery", sliceId, detail: expect.stringContaining("cleared escalated slice") },
    ]);
    expect(state.raw.transient_retry_counts["dispatch-recovery:" + sliceId]).toBeUndefined();
    // ...so dispatch re-selected it as a FRESH launch (not the #211 recover path).
    expect(d.dispatch.launchDispatch).toHaveBeenCalledWith(state.raw, NOW, item, sliceId);
    expect(d.dispatch.recoverDispatch).not.toHaveBeenCalled();
  });

  it("counts steward-nudge actions separately from the babysit umbrella (#212)", async () => {
    const raw = {
      // 30min stranded in 'implementing' with no PR → babysit fires a first nudge.
      slices: { stuck: { worker_session_id: "w", stage: "implementing", implementing_started_at: "2026-05-20T00:30:00Z" } },
      archived_slices: {},
      repo: { path: "/repo" },
    };
    const state: LoopState = {
      ts: NOW,
      statePresent: true,
      stateError: null,
      raw,
      slices: raw.slices,
      archived: raw.archived_slices,
      repoPath: "/repo",
      workerGroup: "legate-workers",
      sessions: [{ id: "w", group: "legate-workers", status: "waiting" }],
      sessionsById: new Map([["w", { id: "w" }]]),
      workers: { waiting: 1, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
      smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
      perSlice: { stuck: { recentOutput: { output: "" } } },
    };

    const out = await runTick(deps(state));

    expect(out.results.babysit.actions.map((a) => a.action)).toEqual(["steward-nudge"]);
    expect(out.tick.stewardNudgeCount).toBe(1);
    expect(out.tick.stewardStrandedCount).toBe(0);
    // The nudge is metricized on its own, so it is NOT double-counted as babysit.
    expect(out.tick.babysitActionCount).toBe(0);
    // The slice stays implementing → it shows up in the by-stage tally, with all
    // other canonical stages pre-seeded to 0 (#220).
    expect(out.tick.slicesByStage).toEqual({
      "hatchery-pending": 0,
      implementing: 1,
      "pr-open": 0,
      "pr-in-fix": 0,
      "pr-resolving-conflicts": 0,
      escalated: 0,
    });
    expect(out.tick.readyToMergeCount).toBe(0);
  });
});
