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

  it("suppresses a None observation that would null a known PR number (#288)", () => {
    // A slice tracked an open PR by number; the PR then merged and its branch was
    // deleted, so the branch-rediscovery fallback returned a numberless `{skipped}`.
    // Emitting that would overwrite the tracked number and strand the slice — so
    // the diff suppresses it and the PR stays tracked by number.
    const prevState = applyDiff(emptySystemState(), loop({
      perSlice: { s1: { pr: { number: 276, state: "OPEN" } } },
    }));
    expect(diffObserved(prevState, loop({
      perSlice: { s1: { pr: { skipped: true, reason: "missing_pr_number" } } },
    }))).toEqual([]);
  });

  it("still emits the terminal MERGED once the by-number query observes it (#288)", () => {
    // The PR stays tracked by number, so the next tick's by-number query returns
    // MERGED — a concrete observation that is NOT a regression, so it emits and the
    // legate can archive.
    const prevState = applyDiff(emptySystemState(), loop({
      perSlice: { s1: { pr: { number: 276, state: "OPEN" } } },
    }));
    const merged = diffObserved(prevState, loop({
      perSlice: { s1: { pr: { number: 276, state: "MERGED" } } },
    }));
    expect(merged).toEqual([{ type: "slice.pr.changed", sliceId: "s1", pr: { number: 276, state: "MERGED" } }]);
  });

  it("does not suppress the FIRST PR observation when no PR was known (#288 guard is regression-only)", () => {
    // No prior PR → even a numberless snapshot still emits; the guard only blocks
    // regressions of an already-known PR.
    const bodies = diffObserved(emptySystemState(), loop({
      perSlice: { s1: { pr: { skipped: true, reason: "missing_pr_number" } } },
    }));
    expect(bodies).toContainEqual({ type: "slice.pr.changed", sliceId: "s1", pr: { skipped: true, reason: "missing_pr_number" } });
  });

  it("emits a query error against a tracked PR (surfaces query-failed) and keeps the number (#292 review)", () => {
    const prevState = applyDiff(emptySystemState(), loop({
      perSlice: { s1: { pr: { number: 276, state: "OPEN" } } },
    }));
    // The error observation is NOT suppressed — it must reach the legate so babysit
    // can emit query-failed (a real auth/rate failure must surface).
    const errored = diffObserved(prevState, loop({ perSlice: { s1: { pr: { error: "gh: rate limited" } } } }));
    expect(errored).toEqual([{ type: "slice.pr.changed", sliceId: "s1", pr: { error: "gh: rate limited" } }]);
    // …and folding it keeps the number/state while attaching the error.
    const folded = applyDiff(prevState, loop({ perSlice: { s1: { pr: { error: "gh: rate limited" } } } }));
    expect(folded.slices.s1.pr).toEqual({ number: 276, state: "OPEN", error: "gh: rate limited" });
  });

  it("is idempotent on a repeated identical query error (#292 review)", () => {
    const prevState = applyDiff(emptySystemState(), loop({
      perSlice: { s1: { pr: { number: 1, state: "OPEN" } } },
    }));
    const afterErr = applyDiff(prevState, loop({ perSlice: { s1: { pr: { error: "boom" } } } }));
    // The same error again folds to the same snapshot → no second event.
    expect(diffObserved(afterErr, loop({ perSlice: { s1: { pr: { error: "boom" } } } }))).toEqual([]);
  });

  it("no longer emits state.error / state.ok (Herald does not read state.json, #176)", () => {
    // Even with a stateError on the snapshot, the retired emission is gone; the
    // reducer still folds those types for replay of pre-#176 logs.
    const bodies = diffObserved(emptySystemState(), loop({ statePresent: false, stateError: "bad json" }));
    expect(bodies.map((b) => b.type)).not.toContain("state.error");
    expect(bodies.map((b) => b.type)).not.toContain("state.ok");
  });

  it("skips workers when Castra was unavailable ({error})", () => {
    const bodies = diffObserved(emptySystemState(), loop({ workers: { error: "unavailable" } as any }));
    expect(bodies.map((b) => b.type)).not.toContain("workers.changed");
  });
});
