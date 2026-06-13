/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, assess } from "./adopt-from-fold.js";
import type { HandlerContext, LoopState } from "../state/types.js";

const PR = { number: 240, state: "OPEN", head_branch: "feature/smithy/cut/01-spawn-f5-s2", url: "u" };

function loopState(slices: Record<string, any>, perSlice: Record<string, any> = {}): LoopState {
  const raw = { slices, archived_slices: {}, repo: { path: "/repo" } };
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
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice,
  };
}

function ctx(): { c: HandlerContext; emitTransition: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  const emitTransition = vi.fn();
  const log = vi.fn();
  const c: HandlerContext = {
    meta: { processor_name: "loop", paired_legate: "legate" } as any,
    ts: "T",
    castra: {} as any,
    broodTeardown: vi.fn(),
    emit: vi.fn(),
    emitTransition,
    log,
  };
  return { c, emitTransition, log };
}

describe("adopt-from-fold assess", () => {
  it("selects an escalated slice with an OPEN PR from the folded slice.pr (cold rebuild)", () => {
    expect(assess(loopState({ esc: { stage: "escalated", branch: "b", pr: PR } }))).toEqual([{ sliceId: "esc", pr: PR }]);
  });

  it("selects an escalated slice with the OPEN PR from this tick's perSlice observation (warm loop)", () => {
    const s = loopState({ esc: { stage: "escalated", branch: "b", pr: null } }, { esc: { pr: PR } });
    expect(assess(s)).toEqual([{ sliceId: "esc", pr: PR }]);
  });

  it("does not select: no PR / closed PR / implementing / recovered / archived / already pr-open", () => {
    expect(assess(loopState({ s: { stage: "escalated", branch: "b", pr: null } }))).toEqual([]);
    expect(assess(loopState({ s: { stage: "escalated", branch: "b", pr: { number: 1, state: "CLOSED" } } }))).toEqual([]);
    expect(assess(loopState({ s: { stage: "implementing", branch: "b", pr: PR } }))).toEqual([]);
    expect(assess(loopState({ s: { stage: "escalated", branch: "b", pr: PR, recovered: true } }))).toEqual([]);
    expect(assess(loopState({ s: { stage: "escalated", branch: "b", pr: PR, archived: true } }))).toEqual([]);
    expect(assess(loopState({ s: { stage: "pr-open", branch: "b", pr: PR } }))).toEqual([]);
  });

  it("does not select an escalated OPEN PR with no usable number", () => {
    expect(assess(loopState({ s: { stage: "escalated", branch: "b", pr: { state: "OPEN" } } }))).toEqual([]);
  });
});

describe("adopt-from-fold apply", () => {
  it("transitions escalated → pr-open, emits slice.stage.changed, clears escalation, returns the action", async () => {
    const state = loopState({
      esc: { stage: "escalated", branch: "b", pr: PR, escalated_reason: "hatchery_dispatch_failed", worker_session_id: null },
    });
    const { c, emitTransition, log } = ctx();
    const res = await apply(assess(state), c, state);
    expect(state.slices.esc.stage).toBe("pr-open");
    expect(state.slices.esc.pr.number).toBe(240);
    expect(state.slices.esc.escalated_reason).toBeUndefined();
    expect(emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "esc", stage: "pr-open" });
    expect(res.actions).toEqual([expect.objectContaining({ action: "adopt-from-fold", sliceId: "esc" })]);
    expect(res.mutated).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("adopt-from-fold esc"));
  });

  it("carries the steward sessionId on the transition when the slice still has one", async () => {
    const state = loopState({ esc: { stage: "escalated", branch: "b", pr: PR, worker_session_id: "sess-1" } });
    const { c, emitTransition } = ctx();
    await apply(assess(state), c, state);
    expect(emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "esc", stage: "pr-open", sessionId: "sess-1" });
  });

  it("adopts the perSlice-observed PR and reconciles slice.pr onto the working slice (warm loop)", async () => {
    const state = loopState({ esc: { stage: "escalated", branch: "b", pr: null, worker_session_id: null } }, { esc: { pr: PR } });
    const { c } = ctx();
    await apply(assess(state), c, state);
    expect(state.slices.esc.stage).toBe("pr-open");
    expect(state.slices.esc.pr.number).toBe(240);
  });

  it("is a no-op (idempotent) when nothing matches", async () => {
    const state = loopState({ s: { stage: "pr-open", branch: "b", pr: PR } });
    const { c, emitTransition } = ctx();
    const res = await apply(assess(state), c, state);
    expect(emitTransition).not.toHaveBeenCalled();
    expect(res.actions).toEqual([]);
    expect(res.mutated).toBe(false);
  });
});
