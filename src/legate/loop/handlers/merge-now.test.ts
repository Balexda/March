/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess, type MergeNowDeps } from "./merge-now.js";
import type { HandlerContext, LoopState, MergeRequest } from "../state/types.js";

function loopState(over: Partial<LoopState> & { raw?: any } = {}): LoopState {
  const raw = { slices: {}, archived_slices: {}, ...((over as any).raw || {}) };
  return {
    ts: "2026-11-19T00:00:00.000Z",
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

function ctx(): HandlerContext {
  return {
    meta: { profile: "march", processor_name: "loop", paired_legate: "legate" } as any,
    ts: "2026-11-19T00:00:00.000Z",
    castra: {} as any,
    broodTeardown: vi.fn(),
    emitTransition: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  } as any;
}

const HEAD = "a".repeat(40);

function deps(over: Partial<MergeNowDeps> = {}): MergeNowDeps {
  return {
    readPr: vi.fn().mockResolvedValue({ state: "OPEN", headSha: HEAD, mergeable: "MERGEABLE" }),
    mergePr: vi.fn().mockResolvedValue({ merged: true }),
    ...over,
  };
}

const req = (over: Partial<MergeRequest> = {}): MergeRequest => ({ sliceId: "s", seq: 7, prNumber: 42, ...over });
const emitted = (c: HandlerContext): any[] => (c.emitTransition as any).mock.calls.map((a: any[]) => a[0]);

/** An open-PR slice the review gate is holding (unapproved). */
function heldPr(over: Partial<LoopState> = {}): LoopState {
  return loopState({
    raw: { slices: { s: { stage: "pr-open", pr: { number: 42, state: "OPEN" }, worker_session_id: "w1" } } },
    mergeRequests: [req()],
    ...over,
  });
}

describe("merge-now assess (#593)", () => {
  it("decides to merge a pending request on an in-flight slice", () => {
    expect(assess(heldPr())).toEqual([{ sliceId: "s", action: "merge", request: req() }]);
  });

  it("refuses an unknown or already-merged slice", () => {
    expect(assess(loopState({ mergeRequests: [req()] }))[0]).toMatchObject({ action: "refuse" });
    const merged = heldPr();
    merged.slices.s.stage = "merged";
    expect(assess(merged)[0]).toMatchObject({ action: "refuse", reason: expect.stringContaining("already merged") });
  });

  it("skips a request already settled this incarnation (warm handled seq)", () => {
    const state = heldPr();
    state.raw.merge_now_handled_seq = { s: 7 };
    expect(assess(state)).toEqual([]);
    state.mergeRequests = [req({ seq: 9 })];
    expect(assess(state)).toHaveLength(1);
  });
});

describe("merge-now apply (#593)", () => {
  it("re-reads the PR, merges pinned to the live head SHA, and transitions to merged", async () => {
    const state = heldPr();
    const c = ctx();
    const d = deps();
    const res = await apply(assess(state), c, state, d);
    expect(d.readPr).toHaveBeenCalledWith("/repo", 42, "s");
    expect(d.mergePr).toHaveBeenCalledWith({ prNumber: 42, headSha: HEAD, repoPath: "/repo", sliceId: "s" });
    expect(state.slices.s.stage).toBe("merged");
    expect(state.slices.s.pr.state).toBe("MERGED");
    expect(emitted(c)).toEqual([{ type: "slice.stage.changed", sliceId: "s", stage: "merged" }]);
    expect(res.actions[0]).toMatchObject({ action: "operator-merge", slice_id: "s", pr_number: 42 });
    expect(state.raw.merge_now_handled_seq).toEqual({ s: 7 });
  });

  it.each([
    ["a closed PR", { state: "CLOSED", headSha: HEAD }, "not OPEN"],
    ["a conflicting PR", { state: "OPEN", headSha: HEAD, mergeable: "CONFLICTING" }, "merge conflicts"],
    ["a PR with no head SHA", { state: "OPEN", headSha: "" }, "no head SHA"],
  ])("refuses %s without merging", async (_label, live, why) => {
    const state = heldPr();
    const c = ctx();
    const d = deps({ readPr: vi.fn().mockResolvedValue(live) });
    await apply(assess(state), c, state, d);
    expect(d.mergePr).not.toHaveBeenCalled();
    expect(state.slices.s.stage).toBe("pr-open");
    expect(emitted(c)).toEqual([
      { type: "slice.operator.refused", sliceId: "s", action: "merge", reason: expect.stringContaining(why) },
    ]);
  });

  it("refuses (once) when gh merge fails, e.g. the head moved — no retry every tick", async () => {
    const state = heldPr();
    const c = ctx();
    const d = deps({ mergePr: vi.fn().mockRejectedValue(new Error("head commit mismatch")) });
    const res = await apply(assess(state), c, state, d);
    expect(state.slices.s.stage).toBe("pr-open");
    expect(emitted(c)[0]).toMatchObject({ type: "slice.operator.refused", action: "merge", reason: expect.stringContaining("head commit mismatch") });
    expect(res.failures).toHaveLength(1);
    expect(assess(state)).toEqual([]);
  });

  it("refuses when the GitHub seam is not wired", async () => {
    const state = heldPr();
    const c = ctx();
    await apply(assess(state), c, state, undefined);
    expect(emitted(c)[0]).toMatchObject({ type: "slice.operator.refused", action: "merge" });
  });
});
