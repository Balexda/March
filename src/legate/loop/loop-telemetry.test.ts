/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { buildLoopTickActivity, emitActionEventLog, emitActionEventSpan } from "./loop-telemetry.js";

describe("emitActionEventSpan", () => {
  it("ignores non-objects and events without a slice_id", () => {
    const emit = vi.fn();
    emitActionEventSpan(null, emit);
    emitActionEventSpan({ kind: "dispatch_action" }, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits a root legate.dispatch span for a dispatch action", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "dispatch_action", action: "dispatch", slice_id: "s" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "legate.dispatch", traceKey: "s", root: true }));
  });

  it("marks a dispatch_failure as an errored root span", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "dispatch_failure", slice_id: "s", error: "boom" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "legate.dispatch", root: true, error: true }));
  });

  it("emits non-root babysit / cleanup spans", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "babysit_action", slice_id: "s", action: "nudge" }, emit);
    emitActionEventSpan({ kind: "cleanup", slice_id: "s", pr_state: "MERGED" }, emit);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "legate.babysit", root: false }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "legate.cleanup", root: false }));
  });

  it("emits a non-root legate.relaunch span keyed by the slice id", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "steward_relaunch", slice_id: "s", session_id: "w", action: "relaunch-steward" }, emit);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "legate.relaunch", traceKey: "s", root: false, error: false }),
    );
  });

  it("marks a relaunch-failed span errored", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "steward_relaunch", slice_id: "s", action: "relaunch-failed" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "legate.relaunch", root: false, error: true }));
  });

  it("emits a legate.ghost-cleanup span keyed by the session id (no slice_id)", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "ghost_cleanup", session_id: "w", action: "ghost-cleanup" }, emit);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "legate.ghost-cleanup", traceKey: "w", root: false, error: false }),
    );
  });

  it("marks a ghost-cleanup-failed span errored and ignores one with no session id", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "ghost_cleanup", session_id: "w", action: "ghost-cleanup-failed" }, emit);
    emitActionEventSpan({ kind: "ghost_cleanup", action: "ghost-cleanup" }, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "legate.ghost-cleanup", error: true }));
  });
});

describe("emitActionEventLog", () => {
  it("ignores events without a kind", () => {
    const emit = vi.fn();
    emitActionEventLog({ slice_id: "s" }, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it("maps *_failure and sync_warning to ERROR, everything else to INFO", () => {
    const emit = vi.fn();
    emitActionEventLog({ kind: "dispatch_failure", error: "boom", slice_id: "s" }, emit);
    emitActionEventLog({ kind: "sync_warning", detail: "stale" }, emit);
    emitActionEventLog({ kind: "cleanup", slice_id: "s" }, emit);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({ severity: "ERROR", eventKind: "dispatch_failure", sliceId: "s" }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({ severity: "ERROR", eventKind: "sync_warning" }));
    expect(emit).toHaveBeenNthCalledWith(3, expect.objectContaining({ severity: "INFO", eventKind: "cleanup" }));
  });

  it("builds the body from the first available detail field", () => {
    const emit = vi.fn();
    emitActionEventLog({ kind: "dispatch_action", detail: "queued" }, emit);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ body: "dispatch_action: queued" }));
  });
});

describe("buildLoopTickActivity", () => {
  const ctx = { profile: "p", conductor: "c", tickAtMs: 1000, durationMs: 2500 };

  it("returns null when there is no heartbeat record", () => {
    expect(buildLoopTickActivity(null, ctx)).toBeNull();
  });

  it("maps the record into the loop-metrics activity payload", () => {
    const record = {
      workers: { running: 1, idle: 2, error: 0, bogus: "x" },
      dispatchable_count: 3,
      blocked_count: 1,
      pending_total: 5,
      slices_by_stage: { implementing: 2, "pr-open": 1, bogus: "x" },
      ready_to_merge_count: 1,
      escalated_by_reason: { hatchery_dispatch_failed: 2, other: 1, bogus: "x" },
      dispatch_action_count: 2,
      dispatch_failure_count: 1,
      cleanup_count: 4,
      ghost_cleanup_count: 0,
      relaunch_count: 0,
      babysit_action_count: 6,
      steward_nudge_count: 7,
      steward_stranded_count: 1,
    };
    const activity = buildLoopTickActivity(record, ctx)!;
    expect(activity.snapshot).toEqual({
      profile: "p",
      conductor: "c",
      up: 1,
      lastTickAtMs: 1000,
      queueDispatchable: 3,
      queueBlocked: 1,
      queueTotal: 5,
      workersByState: { running: 1, idle: 2, error: 0 }, // non-number 'bogus' dropped
      slicesByStage: { implementing: 2, "pr-open": 1 }, // non-number 'bogus' dropped
      readyToMerge: 1,
      escalatedByReason: { hatchery_dispatch_failed: 2, other: 1 }, // non-number 'bogus' dropped
    });
    expect(activity.tickDurationSeconds).toBe(2.5);
    expect(activity).toMatchObject({
      dispatchActions: 2,
      dispatchFailures: 1,
      cleanups: 4,
      babysitActions: 6,
      stewardNudges: 7,
      stewardStranded: 1,
    });
  });

  it("defaults profile/conductor to 'unknown' and missing counts to 0", () => {
    const activity = buildLoopTickActivity({}, { profile: "", conductor: undefined, tickAtMs: 0, durationMs: 0 })!;
    expect(activity.snapshot).toMatchObject({ profile: "unknown", conductor: "unknown", queueTotal: 0, workersByState: {}, slicesByStage: {}, readyToMerge: 0 });
    expect(activity.dispatchActions).toBe(0);
    expect(activity.stewardNudges).toBe(0);
    expect(activity.stewardStranded).toBe(0);
  });
});
