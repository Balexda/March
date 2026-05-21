import { describe, expect, it, vi } from "vitest";
import { runTick, type CoordinatorDeps } from "./coordinator.js";
import type { HandlerContext, LoopState } from "./state/types.js";

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

  it("drives the dispatch completion + selection seams", async () => {
    const state = makeState();
    const d = deps(state);
    await runTick(d);
    expect(d.dispatch.completePending).toHaveBeenCalledWith(state.raw, NOW);
  });
});
