/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess, type DispatchDeps } from "./dispatch.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import { dispatchSliceId } from "../pure/dispatch-id.js";
import { createSpawnBudget, DISPATCH_RECOVERY_LIMIT, liveSpawnCount, recoveryAttemptKey, type SpawnBudget } from "../pure/slice.js";

function loopState(over: Partial<LoopState> = {}): LoopState {
  const raw = { slices: {}, archived_slices: {}, repo: { path: "/repo" }, ...((over as any).raw || {}) };
  return {
    ts: "T",
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
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 }, ...((over as any).smithy || {}) },
    perSlice: {},
    ...over,
  };
}

// A ready item whose dispatchSliceId is derived from its action; a bare forge on
// an unknown artifact falls back to a hash stem — stable per item shape.
const readyItem = (path: string) => ({ path, next_action: { command: "smithy.forge", arguments: [path, "1"] }, parent_path: path });

function ctx(): HandlerContext {
  return {
    meta: {} as any,
    ts: "T",
    castra: {} as any,
    broodTeardown: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    completePending: vi.fn(async () => ({ actions: [], failures: [], mutated: false, notifications: [] })),
    launchDispatch: vi.fn(async () => ({ actions: [{ action: "dispatch" }], failures: [], mutated: true })),
    recoverDispatch: vi.fn(async () => ({ actions: [{ action: "dispatch-recovery" }], failures: [], mutated: true })),
    requestJudgement: vi.fn(async (i) => ({ ...i })),
    ...over,
  };
}

describe("dispatch assess (pure selection)", () => {
  it("selects fresh dispatch for a ready item with no in-flight or archived match", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    expect(assess(state).map((d) => d.kind)).toEqual(["dispatch"]);
  });

  it("skips an item already in flight", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    // Seed an in-flight slice keyed to the same artifact+action.
    const sliceId = assess(state)[0]!.sliceId;
    (state.raw.slices as any)[sliceId] = { stage: "implementing", artifact_path: "a.spec.md", command: "smithy.forge", arguments: ["a.spec.md", "1"] };
    expect(assess(state)).toEqual([]);
  });

  it("returns nothing when smithy read failed", async () => {
    const state = loopState({ smithy: { ok: false, error: "down", ready: [readyItem("a")], queue: { dispatchable: 0, blocked: 0, total: 0 } } });
    expect(assess(state)).toEqual([]);
  });
});

describe("dispatch assess (#211 bounded auto-recovery)", () => {
  // Seed a recoverably-escalated slice at the item's deterministic slice id.
  const seedEscalated = (state: LoopState, item: any, over: any = {}) => {
    const sliceId = dispatchSliceId(item);
    (state.raw.slices as any)[sliceId] = {
      stage: "escalated",
      escalated_reason: "hatchery_dispatch_failed",
      command: "smithy.forge",
      arguments: [item.path, "1"],
      artifact_path: item.path,
      ...over,
    };
    return sliceId;
  };

  it("emits a recover decision for a still-ready item wedged behind a recoverable escalation", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 0, blocked: 0, total: 1 } } });
    const sliceId = seedEscalated(state, item);
    expect(assess(state)).toEqual([{ kind: "recover", sliceId, item, attempt: 1 }]);
  });

  it("does NOT recover once the retry budget is exhausted (stays operator-only)", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 0, blocked: 0, total: 1 } } });
    const sliceId = seedEscalated(state, item);
    (state.raw as any).transient_retry_counts = { [recoveryAttemptKey(sliceId)]: DISPATCH_RECOVERY_LIMIT };
    expect(assess(state)).toEqual([]);
  });

  it("does NOT recover a non-recoverable escalation reason (fail-safe allowlist)", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 0, blocked: 0, total: 1 } } });
    seedEscalated(state, item, { escalated_reason: "needs_human_judgement" });
    expect(assess(state)).toEqual([]);
  });

  it("does NOT recover when a terminal MERGED archive also blocks the item", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 0, blocked: 0, total: 1 } } });
    const sliceId = seedEscalated(state, item);
    (state.raw.archived_slices as any)[sliceId] = { terminal_state: "MERGED", artifact_path: "a.spec.md", command: "smithy.forge", arguments: ["a.spec.md", "1"], pr: { number: 9 } };
    expect(assess(state)).toEqual([]);
  });

  it("routes a recover decision to recoverDispatch (not launchDispatch) in apply", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 0, blocked: 0, total: 1 } } });
    const sliceId = seedEscalated(state, item);
    const d = deps();
    const res = await apply(assess(state), ctx(), state, d);
    expect(d.recoverDispatch).toHaveBeenCalledWith(state.raw, "T", item, sliceId, 1);
    expect(d.launchDispatch).not.toHaveBeenCalled();
    expect(res.actions.some((a) => a.action === "dispatch-recovery")).toBe(true);
  });
});

describe("dispatch apply (orchestration)", () => {
  it("drains pending then launches the selected fresh dispatch", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    const c = ctx();
    const d = deps();
    const res = await apply(assess(state), c, state, d);
    expect(d.completePending).toHaveBeenCalled();
    expect(d.launchDispatch).toHaveBeenCalledTimes(1);
    expect(res.actions.some((a) => a.action === "dispatch")).toBe(true);
  });

  it("fires legate-judgement requests for completion notifications", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } } });
    const d = deps({
      completePending: vi.fn(async () => ({
        actions: [],
        failures: [],
        mutated: true,
        notifications: [{ slice: {}, sliceId: "s", requestKey: "k", reason: "hatchery_dispatch_failed", detail: "boom" }],
      })),
    });
    const res = await apply(assess(state), ctx(), state, d);
    expect(d.requestJudgement).toHaveBeenCalledWith(expect.objectContaining({ requestKey: "k" }));
    expect(res.requests).toHaveLength(1);
    void item;
  });

  it("skips a MERGED-archive collision rather than re-dispatching (recovery deleted)", async () => {
    const item = readyItem("a.spec.md");
    const state = loopState({ smithy: { ok: true, ready: [item], queue: { dispatchable: 1, blocked: 0, total: 1 } } });
    const sliceId = assess(state)[0]!.sliceId;
    (state.raw.archived_slices as any)[sliceId] = { terminal_state: "MERGED", artifact_path: "a.spec.md", command: "smithy.forge", arguments: ["a.spec.md", "1"], pr: { number: 9 } };
    // The colliding MERGED archive now reads as "already archived" → no decision.
    expect(assess(state)).toEqual([]);
    const d = deps();
    await apply(assess(state), ctx(), state, d);
    expect(d.launchDispatch).not.toHaveBeenCalled();
  });
});

describe("dispatch apply (#313 global concurrent-spawn cap)", () => {
  // A handler context carrying the shared global spawn budget.
  const ctxWithBudget = (budget: SpawnBudget): HandlerContext => ({ ...ctx(), spawnBudget: budget });

  // A launchDispatch that, like the real one, seeds a live (non-terminal) slice
  // keyed by sliceId — so a launched item drops out of the next assess() while a
  // SKIPPED item, never seeded, stays dispatchable.
  const seedingDeps = (over: Partial<DispatchDeps> = {}): DispatchDeps =>
    deps({
      launchDispatch: vi.fn(async (raw: any, _ts: string, _item: any, sliceId: string) => {
        raw.slices[sliceId] = { stage: "hatchery-pending" };
        return { actions: [{ action: "dispatch", sliceId }], failures: [], mutated: true };
      }),
      ...over,
    });

  const readyItems = (n: number) => Array.from({ length: n }, (_, i) => readyItem(`s${i}.tasks.md`));

  it("CAP=10, 0 live, 30 dispatchable → exactly 10 launched, 20 deferred (still dispatchable)", async () => {
    const ready = readyItems(30);
    const state = loopState({ smithy: { ok: true, ready, queue: { dispatchable: 30, blocked: 0, total: 30 } } });
    const budget = createSpawnBudget(10, 0);
    const d = seedingDeps();
    await apply(assess(state), ctxWithBudget(budget), state, d);
    expect(d.launchDispatch).toHaveBeenCalledTimes(10);
    expect(budget.remaining).toBe(0);
    expect(budget.deferred).toBe(20);
    // The 20 unlaunched items created no slice → they remain dispatchable next tick.
    expect(assess(state)).toHaveLength(20);
    expect(liveSpawnCount(state.raw)).toBe(10);
  });

  it("CAP=10 with 7 already live → at most 3 new launched", async () => {
    // Seed 7 live slices from a prior tick.
    const rawSlices: Record<string, any> = {};
    for (let i = 0; i < 7; i++) rawSlices[`live${i}`] = { stage: "implementing" };
    const ready = readyItems(10);
    const state = loopState({
      raw: { slices: rawSlices, archived_slices: {}, repo: { path: "/repo" } },
      smithy: { ok: true, ready, queue: { dispatchable: 10, blocked: 0, total: 10 } },
    });
    const budget = createSpawnBudget(10, liveSpawnCount(state.raw)); // 10 − 7 = 3
    const d = seedingDeps();
    await apply(assess(state), ctxWithBudget(budget), state, d);
    expect(d.launchDispatch).toHaveBeenCalledTimes(3);
    expect(budget.remaining).toBe(0);
    expect(budget.deferred).toBe(7);
  });

  it("GLOBAL pool: spawns on one profile reduce the budget left for others in the SAME tick", async () => {
    // ONE budget threaded across two profiles' dispatch (sequential, like the tick).
    const budget = createSpawnBudget(10, 0);

    // Profile A (e.g. march): 6 dispatchable → consumes 6 of 10.
    const stateA = loopState({ smithy: { ok: true, ready: readyItems(6), queue: { dispatchable: 6, blocked: 0, total: 6 } } });
    const dA = seedingDeps();
    await apply(assess(stateA), ctxWithBudget(budget), stateA, dA);
    expect(dA.launchDispatch).toHaveBeenCalledTimes(6);
    expect(budget.remaining).toBe(4);

    // Profile B (e.g. smithy): 10 dispatchable but only 4 slots remain globally.
    const stateB = loopState({ smithy: { ok: true, ready: readyItems(10), queue: { dispatchable: 10, blocked: 0, total: 10 } } });
    const dB = seedingDeps();
    await apply(assess(stateB), ctxWithBudget(budget), stateB, dB);
    expect(dB.launchDispatch).toHaveBeenCalledTimes(4);
    expect(budget.remaining).toBe(0);
    expect(budget.deferred).toBe(6); // B's 6 unlaunched
    expect(assess(stateB)).toHaveLength(6); // B's deferred stay dispatchable
  });

  it("budget exhausted (remaining 0) → no launch, items NOT dropped (stay dispatchable)", async () => {
    const ready = readyItems(5);
    const state = loopState({ smithy: { ok: true, ready, queue: { dispatchable: 5, blocked: 0, total: 5 } } });
    const budget = createSpawnBudget(10, 10); // fully drawn — remaining 0
    const d = seedingDeps();
    await apply(assess(state), ctxWithBudget(budget), state, d);
    expect(d.launchDispatch).not.toHaveBeenCalled();
    expect(budget.deferred).toBe(5);
    // Nothing dispatched, nothing archived → all 5 still dispatchable next tick.
    expect(assess(state)).toHaveLength(5);
  });

  it("uncapped when no budget on the context (pre-#313 behavior preserved)", async () => {
    const ready = readyItems(30);
    const state = loopState({ smithy: { ok: true, ready, queue: { dispatchable: 30, blocked: 0, total: 30 } } });
    const d = seedingDeps();
    await apply(assess(state), ctx(), state, d); // ctx() has no spawnBudget
    expect(d.launchDispatch).toHaveBeenCalledTimes(30);
  });

  it("refunds the reservation when a launch escalates or adopts an existing PR (no fresh spawn = no slot consumed)", async () => {
    // CAP=2, 0 live. The first two launches fail to queue a fresh spawn — one
    // escalates (dispatch threw → slice left escalated, no action) and one adopts an
    // existing open PR on a branch collision (`adopt-pr`, not a new spawn). Neither
    // creates a live spawn, so reserve-then-refund must NOT spend global budget on
    // them; both genuine spawns that follow still launch under the cap of 2. Without
    // the refund the two non-spawns would have eaten the budget and starved them.
    // `assess` preserves `ready` order (filter→map), so s0/s1 are processed first.
    const ready = readyItems(4); // s0..s3
    const state = loopState({ smithy: { ok: true, ready, queue: { dispatchable: 4, blocked: 0, total: 4 } } });
    const budget = createSpawnBudget(2, 0);
    const nonSpawn: Record<string, any> = {
      [dispatchSliceId(ready[0]!)]: { actions: [], failures: [{ error: "boom" }], mutated: true }, // escalated
      [dispatchSliceId(ready[1]!)]: { actions: [{ action: "adopt-pr" }], failures: [], mutated: true }, // adopted
    };
    const launched: string[] = [];
    const d = deps({
      launchDispatch: vi.fn(async (raw: any, _ts: string, _item: any, sliceId: string) => {
        if (nonSpawn[sliceId]) return nonSpawn[sliceId];
        raw.slices[sliceId] = { stage: "hatchery-pending" };
        launched.push(sliceId);
        return { actions: [{ action: "dispatch", sliceId }], failures: [], mutated: true };
      }),
    });
    await apply(assess(state), ctxWithBudget(budget), state, d);
    expect(d.launchDispatch).toHaveBeenCalledTimes(4); // all four attempted
    expect(launched).toHaveLength(2); // only the two real spawns
    expect(budget.remaining).toBe(0); // exactly the cap of 2 consumed
    expect(budget.deferred).toBe(0); // a refund is not a throttle — nothing deferred
  });

  it("the cap throttles only FRESH dispatches — recovery (#211) is never starved", async () => {
    // A recoverably-escalated slice is ready; budget is fully exhausted. The fresh
    // dispatch is deferred, but the recover decision still fires.
    const fresh = readyItem("fresh.tasks.md");
    const wedged = readyItem("wedged.tasks.md");
    const state = loopState({ smithy: { ok: true, ready: [fresh, wedged], queue: { dispatchable: 1, blocked: 0, total: 2 } } });
    const wedgedId = dispatchSliceId(wedged);
    (state.raw.slices as any)[wedgedId] = {
      stage: "escalated",
      escalated_reason: "hatchery_dispatch_failed",
      command: "smithy.forge",
      arguments: [wedged.path, "1"],
      artifact_path: wedged.path,
    };
    const budget = createSpawnBudget(10, 10); // remaining 0
    const d = seedingDeps();
    await apply(assess(state), ctxWithBudget(budget), state, d);
    expect(d.launchDispatch).not.toHaveBeenCalled(); // fresh deferred by the cap
    expect(d.recoverDispatch).toHaveBeenCalledTimes(1); // recovery uncapped
    expect(budget.deferred).toBe(1);
  });
});
