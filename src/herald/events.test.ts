import { describe, expect, it } from "vitest";
import {
  emptySystemState,
  entityRefOf,
  foldEvents,
  reduce,
  type HeraldEvent,
} from "./events.js";

let seq = 0;
function ev(body: any): HeraldEvent {
  seq += 1;
  return { seq, id: `e${seq}`, ts: `2026-05-20T00:00:0${seq % 10}Z`, source: "herald", ...body };
}

describe("entityRefOf", () => {
  it("maps each event body to its indexed entity", () => {
    expect(entityRefOf({ type: "slice.pr.changed", sliceId: "s1", pr: {} })).toEqual({ kind: "slice", id: "s1" });
    expect(entityRefOf({ type: "session.changed", session: { id: "x", present: true } })).toEqual({ kind: "session", id: "x" });
    expect(entityRefOf({ type: "smithy.queue.changed", dispatchable: 0, blocked: 0, total: 0 })).toEqual({ kind: "smithy", id: "queue" });
    expect(entityRefOf({ type: "workers.changed", workers: {} as any })).toEqual({ kind: "workers", id: "all" });
    expect(entityRefOf({ type: "heartbeat" })).toEqual({ kind: "system", id: "all" });
  });
});

describe("reduce / fold", () => {
  it("folds observation events into a projection", () => {
    seq = 0;
    const state = foldEvents([
      ev({ type: "smithy.queue.changed", dispatchable: 2, blocked: 1, total: 5 }),
      ev({ type: "workers.changed", workers: { waiting: 0, running: 2, idle: 1, error: 0, stopped: 0, other: 0 } }),
      ev({ type: "slice.pr.changed", sliceId: "s1", pr: { number: 7, state: "OPEN" } }),
      ev({ type: "slice.output.changed", sliceId: "s1", recentOutput: { output: "hi" } }),
    ]);
    expect(state.smithy).toEqual({ dispatchable: 2, blocked: 1, total: 5 });
    expect(state.workers).toMatchObject({ running: 2 });
    expect(state.slices.s1.pr).toEqual({ number: 7, state: "OPEN" });
    expect(state.slices.s1.recentOutput).toEqual({ output: "hi" });
    expect(state.statePresent).toBe(true);
    expect(state.seq).toBe(4);
  });

  it("tracks session presence (appear then disappear)", () => {
    seq = 0;
    const appeared = foldEvents([
      ev({ type: "session.changed", session: { id: "a", present: true, status: "running" } }),
    ]);
    expect(appeared.sessions.a).toMatchObject({ status: "running" });
    const gone = foldEvents([ev({ type: "session.changed", session: { id: "a", present: false } })], appeared);
    expect(gone.sessions.a).toBeUndefined();
  });

  it("folds transition events into slice stage + archive", () => {
    seq = 0;
    const state = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", worktreePath: "/wt/a", sessionId: "sess1" }),
      ev({ type: "slice.stage.changed", sliceId: "s1", stage: "pr-open" }),
      ev({ type: "retry.counted", key: "spawn-error:s1", count: 2 }),
    ]);
    expect(state.slices.s1).toMatchObject({ branch: "feature/a", worktreePath: "/wt/a", sessionId: "sess1", stage: "pr-open", archived: false });
    expect(state.retries["spawn-error:s1"]).toBe(2);

    const archived = foldEvents([ev({ type: "slice.archived", sliceId: "s1" })], state);
    expect(archived.slices.s1.archived).toBe(true);
  });

  it("folds slice.steward.attached into sessionId/spawnId/branch/worktree (#213)", () => {
    seq = 0;
    const state = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-1" }),
      ev({
        type: "slice.steward.attached",
        sliceId: "s1",
        sessionId: "sess-9",
        spawnId: "sp-1",
        branch: "march/spawn/sp-1",
        worktreePath: "/wt/sp-1",
      }),
    ]);
    expect(state.slices.s1).toMatchObject({
      sessionId: "sess-9",
      spawnId: "sp-1",
      branch: "march/spawn/sp-1",
      worktreePath: "/wt/sp-1",
      jobId: "job-1",
      archived: false,
    });
  });

  it("slice.stage.changed carries the steward sessionId into the fold (#210)", () => {
    seq = 0;
    const state = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-1" }),
      ev({ type: "slice.stage.changed", sliceId: "s1", stage: "implementing", sessionId: "sess-9" }),
    ]);
    expect(state.slices.s1).toMatchObject({ stage: "implementing", sessionId: "sess-9" });

    // A later stage change without a sessionId must not clobber the known link.
    const next = foldEvents([ev({ type: "slice.stage.changed", sliceId: "s1", stage: "pr-open" })], state);
    expect(next.slices.s1).toMatchObject({ stage: "pr-open", sessionId: "sess-9" });
  });

  it("entityRefOf maps slice.steward.attached to its slice", () => {
    expect(
      entityRefOf({ type: "slice.steward.attached", sliceId: "s1", sessionId: "x" }),
    ).toEqual({ kind: "slice", id: "s1" });
  });

  it("slice.recovery.requested drops the escalated slice + clears its budget from the fold (#238)", () => {
    seq = 0;
    // An escalated slice with an exhausted recovery budget — no internal re-dispatch path.
    const escalated = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-1" }),
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
      ev({ type: "retry.counted", key: "dispatch-recovery:s1", count: 2 }),
    ]);
    expect(escalated.slices.s1).toMatchObject({ stage: "escalated", escalatedReason: "hatchery_dispatch_failed" });
    expect(escalated.retries["dispatch-recovery:s1"]).toBe(2);

    const recovered = foldEvents([ev({ type: "slice.recovery.requested", sliceId: "s1" })], escalated);
    // The slice is gone from the fold so a cold-start rebuild reconstructs nothing
    // blocking, and its bounded-recovery budget is cleared.
    expect(recovered.slices.s1).toBeUndefined();
    expect(recovered.retries["dispatch-recovery:s1"]).toBeUndefined();
  });

  it("slice.recovery.requested is a no-op for an unknown slice", () => {
    seq = 0;
    const state = foldEvents([ev({ type: "slice.recovery.requested", sliceId: "ghost" })]);
    expect(state.slices.ghost).toBeUndefined();
    expect(state.seq).toBe(1);
  });

  it("a fresh dispatch after recovery re-creates the slice clean", () => {
    seq = 0;
    const recovered = foldEvents([
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
      ev({ type: "slice.recovery.requested", sliceId: "s1" }),
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-2" }),
    ]);
    expect(recovered.slices.s1).toMatchObject({ branch: "feature/a", jobId: "job-2", archived: false });
    expect(recovered.slices.s1.stage).toBeUndefined();
    expect(recovered.slices.s1.escalatedReason).toBeUndefined();
  });

  it("entityRefOf maps slice.recovery.requested to its slice", () => {
    expect(entityRefOf({ type: "slice.recovery.requested", sliceId: "s1" })).toEqual({ kind: "slice", id: "s1" });
  });

  it("state.error sets the error and clears statePresent", () => {
    seq = 0;
    const state = foldEvents([ev({ type: "state.error", message: "boom" })]);
    expect(state.stateError).toBe("boom");
    expect(state.statePresent).toBe(false);
  });

  it("foldEvents does not mutate the base projection (state-at-a-point is isolated)", () => {
    seq = 0;
    const base = foldEvents([ev({ type: "smithy.queue.changed", dispatchable: 1, blocked: 0, total: 1 })]);
    const baseSeq = base.seq;
    const next = foldEvents([ev({ type: "smithy.queue.changed", dispatchable: 9, blocked: 0, total: 9 })], base);
    expect(base.seq).toBe(baseSeq);
    expect(base.smithy.dispatchable).toBe(1);
    expect(next.smithy.dispatchable).toBe(9);
  });

  it("reduce advances seq/ts to the last event", () => {
    const state = emptySystemState();
    reduce(state, { seq: 42, id: "e", ts: "2026-05-20T12:00:00Z", source: "herald", type: "heartbeat" });
    expect(state.seq).toBe(42);
    expect(state.ts).toBe("2026-05-20T12:00:00Z");
  });
});
