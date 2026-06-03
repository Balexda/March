import { describe, expect, it } from "vitest";
import {
  emptyMultiProfileState,
  emptySystemState,
  entityRefOf,
  foldEvents,
  foldEventsMulti,
  reduce,
  reduceMulti,
  type HeraldEvent,
} from "./events.js";

let seq = 0;
function ev(body: any): HeraldEvent {
  seq += 1;
  return { seq, id: `e${seq}`, ts: `2026-05-20T00:00:0${seq % 10}Z`, source: "herald", profile: body.profile ?? "p", ...body };
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

  it("slice.dispatched sets stage to hatchery-pending and clears any escalation (#255)", () => {
    seq = 0;
    // The job-bearing dispatch event itself means the slice is hatchery-pending, so a
    // cold-start fold reproduces the warm-tick stage instead of a stage-less slice the
    // completion poll skips.
    const dispatched = foldEvents([ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-1" })]);
    expect(dispatched.slices.s1.stage).toBe("hatchery-pending");
    // Re-dispatching a previously escalated slice clears the stale escalation reason,
    // so the fold never holds the impossible "pending-but-escalated" state.
    const redispatched = foldEvents([
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-2" }),
    ]);
    expect(redispatched.slices.s1.stage).toBe("hatchery-pending");
    expect(redispatched.slices.s1.escalatedReason).toBeUndefined();
  });

  it("slice.recovery.dispatched does NOT mark the slice pending until the job-bearing dispatch (#255)", () => {
    seq = 0;
    // recoverDispatch emits slice.recovery.dispatched BEFORE launchDispatch queues the
    // new Hatchery job (and its slice.dispatched with the jobId). If recovery.dispatched
    // marked the slice hatchery-pending, a restart in that gap would rebuild a job-less
    // pending slice the completion poll skips forever — and bounded auto-recovery would
    // no longer see it as escalated. So recovery.dispatched must NOT set stage.
    const midRecovery = foldEvents([
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
      ev({ type: "slice.recovery.dispatched", sliceId: "s1", branch: "feature/a" }),
    ]);
    expect(midRecovery.slices.s1.stage).toBe("escalated");
    expect(midRecovery.slices.s1.escalatedReason).toBe("hatchery_dispatch_failed");
    expect(midRecovery.slices.s1.jobId).toBeUndefined();

    // Once the inner slice.dispatched lands (with the new jobId), the slice is pending
    // and pollable, and the stale escalation is cleared.
    const recovered = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-2" }),
    ], midRecovery);
    expect(recovered.slices.s1.stage).toBe("hatchery-pending");
    expect(recovered.slices.s1.jobId).toBe("job-2");
    expect(recovered.slices.s1.escalatedReason).toBeUndefined();
  });

  it("folds slice.pr.changed onto an escalated (not recovered) slice — the #173 adopt-from-fold path", () => {
    seq = 0;
    // An escalated slice whose branch Herald observed an open PR on. The reducer
    // must accept the observation (only recovered/tombstoned slices are skipped, see
    // the #238 test below) so the legate can adopt it from the fold on the next
    // branch-collision.
    const escalated = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-1" }),
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
    ]);
    expect(escalated.slices.s1).toMatchObject({ stage: "escalated", escalatedReason: "hatchery_dispatch_failed" });

    const observed = foldEvents(
      [ev({ type: "slice.pr.changed", sliceId: "s1", pr: { number: 240, state: "OPEN" } })],
      escalated,
    );
    expect(observed.slices.s1.pr).toEqual({ number: 240, state: "OPEN" });
    expect(observed.slices.s1.stage).toBe("escalated");
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

  it("slice.recovery.requested tombstones the escalated slice + clears its budget (#238)", () => {
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
    // The slice is replaced by a bare tombstone carrying no blocking facts, and its
    // bounded-recovery budget is cleared. rebuildWorkingState skips tombstones, so a
    // cold-start rebuild reconstructs nothing blocking.
    expect(recovered.slices.s1).toEqual({ sliceId: "s1", recovered: true });
    expect(recovered.retries["dispatch-recovery:s1"]).toBeUndefined();
  });

  it("slice.recovery.requested tombstones even an unknown slice (guards in-flight stale deltas)", () => {
    seq = 0;
    const state = foldEvents([ev({ type: "slice.recovery.requested", sliceId: "ghost" })]);
    expect(state.slices.ghost).toEqual({ sliceId: "ghost", recovered: true });
    expect(state.seq).toBe(1);
  });

  it("ignores a stale observation delta for a recovered slice — no resurrection (#238)", () => {
    seq = 0;
    // A stale pr/output delta sequenced AFTER the recovery (observe tick snapshotted
    // the slice before it was recovered) must not rebuild a ghost in-flight slice.
    const recovered = foldEvents([
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-1" }),
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
      ev({ type: "slice.recovery.requested", sliceId: "s1" }),
      ev({ type: "slice.pr.changed", sliceId: "s1", pr: { number: 7, state: "OPEN" } }),
      ev({ type: "slice.output.changed", sliceId: "s1", recentOutput: { output: "stale" } }),
    ]);
    // Still a bare tombstone — the stale pr/output were dropped.
    expect(recovered.slices.s1).toEqual({ sliceId: "s1", recovered: true });
  });

  it("a fresh dispatch after recovery clears the tombstone and re-creates the slice clean", () => {
    seq = 0;
    const recovered = foldEvents([
      ev({ type: "slice.escalated", sliceId: "s1", reason: "hatchery_dispatch_failed" }),
      ev({ type: "slice.recovery.requested", sliceId: "s1" }),
      ev({ type: "slice.dispatched", sliceId: "s1", branch: "feature/a", jobId: "job-2" }),
    ]);
    expect(recovered.slices.s1).toMatchObject({ branch: "feature/a", jobId: "job-2", archived: false });
    expect(recovered.slices.s1.recovered).toBeUndefined();
    // The fresh dispatch re-creates the slice in hatchery-pending (#255).
    expect(recovered.slices.s1.stage).toBe("hatchery-pending");
    expect(recovered.slices.s1.escalatedReason).toBeUndefined();
    // A post-redispatch observation delta now updates normally (tombstone cleared).
    const observed = foldEvents([ev({ type: "slice.pr.changed", sliceId: "s1", pr: { number: 8, state: "OPEN" } })], recovered);
    expect(observed.slices.s1.pr).toEqual({ number: 8, state: "OPEN" });
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
    reduce(state, { seq: 42, id: "e", ts: "2026-05-20T12:00:00Z", source: "herald", profile: "p", type: "heartbeat" });
    expect(state.seq).toBe(42);
    expect(state.ts).toBe("2026-05-20T12:00:00Z");
  });
});

describe("reduceMulti / foldEventsMulti", () => {
  it("folds events into disjoint per-profile buckets — colliding sliceIds never clash", () => {
    seq = 0;
    const multi = foldEventsMulti([
      ev({ profile: "a", type: "slice.dispatched", sliceId: "s1", branch: "a/s1" }),
      ev({ profile: "b", type: "slice.dispatched", sliceId: "s1", branch: "b/s1" }),
      ev({ profile: "a", type: "slice.stage.changed", sliceId: "s1", stage: "pr-open" }),
    ]);
    // Same sliceId "s1" in both profiles, but isolated state: profile A advanced
    // to pr-open while B holds its own dispatch stage (hatchery-pending, #255) —
    // A's stage.changed never leaked into B's bucket.
    expect(multi.byProfile.a.slices.s1.branch).toBe("a/s1");
    expect(multi.byProfile.a.slices.s1.stage).toBe("pr-open");
    expect(multi.byProfile.b.slices.s1.branch).toBe("b/s1");
    expect(multi.byProfile.b.slices.s1.stage).toBe("hatchery-pending");
  });

  it("tracks the global seq/ts across profiles", () => {
    seq = 0;
    const multi = foldEventsMulti([
      ev({ profile: "a", type: "heartbeat" }),
      ev({ profile: "b", type: "heartbeat" }),
    ]);
    expect(multi.seq).toBe(2);
    expect(Object.keys(multi.byProfile).sort()).toEqual(["a", "b"]);
  });

  it("reduceMulti mutates and returns the same multi-state", () => {
    const multi = emptyMultiProfileState();
    const out = reduceMulti(multi, ev({ profile: "z", type: "heartbeat" }));
    expect(out).toBe(multi);
    expect(multi.byProfile.z).toBeDefined();
  });

  it("foldEventsMulti does not mutate the base", () => {
    seq = 0;
    const base = foldEventsMulti([ev({ profile: "a", type: "heartbeat" })]);
    const baseSeq = base.seq;
    const next = foldEventsMulti([ev({ profile: "b", type: "heartbeat" })], base);
    expect(base.seq).toBe(baseSeq);
    expect(Object.keys(base.byProfile)).toEqual(["a"]);
    expect(Object.keys(next.byProfile).sort()).toEqual(["a", "b"]);
  });
});
