import { describe, expect, it } from "vitest";
import { diffObserved } from "./diff.js";
import { emptySystemState, foldEvents, type HeraldEvent, type SystemState } from "../events.js";
import type { LoopState } from "../../legate/loop/state/types.js";

function loop(over: Partial<LoopState> = {}): LoopState {
  return {
    ts: "2026-05-20T00:00:00Z",
    statePresent: true,
    stateError: null,
    raw: {},
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
  } as LoopState;
}

/** Apply the diff bodies onto a projection so we can assert the folded result. */
function applyDiff(prev: SystemState, l: LoopState): SystemState {
  const events: HeraldEvent[] = diffObserved(prev, l).map((body, i) => ({
    seq: prev.seq + i + 1,
    id: `d${i}`,
    ts: l.ts,
    source: "herald",
    ...body,
  })) as HeraldEvent[];
  return foldEvents(events, prev);
}

describe("diffObserved", () => {
  it("emits nothing when nothing changed (idempotent)", () => {
    const prev = applyDiff(emptySystemState(), loop({
      smithy: { ok: true, ready: [], queue: { dispatchable: 2, blocked: 1, total: 4 } },
      workers: { waiting: 1, running: 1, idle: 0, error: 0, stopped: 0, other: 0 },
    }));
    expect(diffObserved(prev, loop({
      smithy: { ok: true, ready: [], queue: { dispatchable: 2, blocked: 1, total: 4 } },
      workers: { waiting: 1, running: 1, idle: 0, error: 0, stopped: 0, other: 0 },
    }))).toEqual([]);
  });

  it("emits smithy.queue.changed and workers.changed on a delta", () => {
    const bodies = diffObserved(emptySystemState(), loop({
      smithy: { ok: true, ready: [], queue: { dispatchable: 3, blocked: 0, total: 3 } },
      workers: { waiting: 0, running: 2, idle: 0, error: 0, stopped: 0, other: 0 },
    }));
    const types = bodies.map((b) => b.type);
    expect(types).toContain("smithy.queue.changed");
    expect(types).toContain("workers.changed");
  });

  it("emits session appearances (worker group only) and departures", () => {
    const appeared = applyDiff(emptySystemState(), loop({
      sessions: [
        { id: "w1", group: "legate-workers", status: "running", worktree_path: "/wt/1" },
        { id: "x1", group: "other-group", status: "running" },
      ],
    }));
    // only the worker-group session is projected
    expect(Object.keys(appeared.sessions)).toEqual(["w1"]);

    // now w1 is gone → a present:false event
    const gone = diffObserved(appeared, loop({ sessions: [] }));
    expect(gone).toEqual([{ type: "session.changed", session: { id: "w1", present: false } }]);
  });

  it("emits slice.pr.changed only when the PR snapshot actually changes", () => {
    const prevState = applyDiff(emptySystemState(), loop({
      perSlice: { s1: { pr: { number: 1, state: "OPEN" } } },
    }));
    // same pr → no event
    expect(diffObserved(prevState, loop({ perSlice: { s1: { pr: { number: 1, state: "OPEN" } } } }))).toEqual([]);
    // changed pr → one event
    const changed = diffObserved(prevState, loop({ perSlice: { s1: { pr: { number: 1, state: "MERGED" } } } }));
    expect(changed).toEqual([{ type: "slice.pr.changed", sliceId: "s1", pr: { number: 1, state: "MERGED" } }]);
  });

  it("emits state.error on transition into an error", () => {
    const bodies = diffObserved(emptySystemState(), loop({ statePresent: false, stateError: "bad json" }));
    expect(bodies).toContainEqual({ type: "state.error", message: "bad json" });
  });

  it("emits state.ok when a prior error recovers (and the reducer clears it)", () => {
    const errored = applyDiff(emptySystemState(), loop({ statePresent: false, stateError: "bad json" }));
    expect(errored.stateError).toBe("bad json");
    // A later healthy read with no slice change must clear the latched error.
    const bodies = diffObserved(errored, loop({ statePresent: true, stateError: null }));
    expect(bodies).toContainEqual({ type: "state.ok" });
    const recovered = applyDiff(errored, loop({ statePresent: true, stateError: null }));
    expect(recovered.stateError).toBeNull();
    expect(recovered.statePresent).toBe(true);
  });

  it("skips workers when Castra was unavailable ({error})", () => {
    const bodies = diffObserved(emptySystemState(), loop({ workers: { error: "unavailable" } as any }));
    expect(bodies.map((b) => b.type)).not.toContain("workers.changed");
  });
});
