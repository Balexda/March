/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildLoopTickActivity,
  dependencyUnblockOutcome,
  emitActionEventLog,
  emitActionEventSpan,
  recordActionEventMetrics,
} from "./loop-telemetry.js";

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

  it("emits a legate.requeue span on the slice trace, errored unless the requeue completed (#588)", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "requeue", slice_id: "s", action: "requeue-done", operator: "jb" }, emit);
    emitActionEventSpan({ kind: "requeue", slice_id: "s", action: "requeue-refused" }, emit);
    emitActionEventSpan({ kind: "requeue", slice_id: "s", action: "requeue-failed" }, emit);
    expect(emit.mock.calls.map((c) => [c[0].name, c[0].traceKey, c[0].error])).toEqual([
      ["legate.requeue", "s", false],
      ["legate.requeue", "s", true],
      ["legate.requeue", "s", true],
    ]);
    expect(emit.mock.calls[0][0].attributes).toMatchObject({ "march.operator": "jb", "march.action": "requeue-done" });
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

  it("emits a per-PR span for a Dependabot auto-merge and an errored one on failure", () => {
    const emit = vi.fn();
    emitActionEventSpan({ kind: "dependency_merge", processor: "smithy-loop", action: "dependency-auto-merge", pr_number: 606 }, emit);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "legate.dependency-merge", traceKey: "smithy-loop-dependency-pr-606", root: true, error: false }),
    );
    emitActionEventSpan({ kind: "dependency_merge_failure", processor: "smithy-loop", action: "dependency-auto-merge-failed", pr_number: 609 }, emit);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ traceKey: "smithy-loop-dependency-pr-609", error: true }));
    emitActionEventSpan({ kind: "dependency_merge_failure", processor: "smithy-loop", action: "dependency-merge-list-failed" }, emit);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ traceKey: "smithy-loop-dependency-merge", error: true }));
  });

  it("emits conflict-ladder actions as legate.dependency-unblock on the PR's trace, errored on failure or escalation", () => {
    const emit = vi.fn();
    const span = (kind: string, action: string) => {
      emitActionEventSpan({ kind, processor: "smithy-loop", action, pr_number: 609 }, emit);
      return emit.mock.lastCall?.[0];
    };
    expect(span("dependency_merge", "dependency-recreate-requested")).toMatchObject({
      name: "legate.dependency-unblock",
      traceKey: "smithy-loop-dependency-pr-609",
      root: true,
      error: false,
    });
    expect(span("dependency_merge", "dependency-unblock-resolved")).toMatchObject({ name: "legate.dependency-unblock", error: false });
    expect(span("dependency_merge_failure", "dependency-recreate-failed")).toMatchObject({ name: "legate.dependency-unblock", error: true });
    expect(span("dependency_merge_failure", "dependency-unblock-escalated")).toMatchObject({ name: "legate.dependency-unblock", error: true });
    expect(span("dependency_merge_failure", "dependency-unblock-escalate-failed")).toMatchObject({ error: true });
  });
});

describe("review request telemetry", () => {
  it("counts new rate-limit hits without counting deadline refusals as hits", () => {
    const decisions = vi.fn();
    const hits = vi.fn();
    const refusal = { kind: "review_request", outcome: "backoff" };
    recordActionEventMetrics(refusal, vi.fn(), decisions, hits);
    recordActionEventMetrics({ ...refusal, rate_limit_hit: true }, vi.fn(), decisions, hits);
    expect(decisions.mock.calls).toEqual([["coderabbit", "backoff"], ["coderabbit", "backoff"]]);
    expect(hits.mock.calls).toEqual([["coderabbit"]]);
  });

  it.each([
    ["requested", false], ["failed", true], ["cap_exhausted", true], ["backoff", false],
  ])("records %s on the slice trace and counts it by reviewer and outcome", (outcome, error) => {
    const emit = vi.fn();
    const record = vi.fn();
    const event = { kind: "review_request", slice_id: "s", reason: "initial", outcome };
    emitActionEventSpan(event, emit);
    expect(emit).toHaveBeenCalledWith({
      name: "legate.review.request", traceKey: "s", root: false, error,
      attributes: {
        "march.slice_id": "s", "march.task_type": "forge", "march.review.reviewer": "coderabbit",
        "march.review.outcome": outcome, "march.review.reason": "initial",
      },
    });
    recordActionEventMetrics(event, vi.fn(), record);
    expect(record.mock.calls).toEqual([["coderabbit", outcome]]);
  });
});

describe("recordActionEventMetrics", () => {
  it("counts each conflict-ladder action by outcome and ignores everything else", () => {
    const record = vi.fn();
    recordActionEventMetrics({ kind: "dependency_merge", processor: "smithy-loop", action: "dependency-recreate-requested" }, record);
    recordActionEventMetrics({ kind: "dependency_merge_failure", processor: "smithy-loop", action: "dependency-unblock-escalated" }, record);
    recordActionEventMetrics({ kind: "dependency_merge", processor: "smithy-loop", action: "dependency-auto-merge" }, record);
    recordActionEventMetrics({ kind: "cleanup", action: "dependency-recreate-requested" }, record);
    recordActionEventMetrics(null, record);
    expect(record.mock.calls).toEqual([
      ["recreate_requested", "smithy-loop"],
      ["escalated", "smithy-loop"],
    ]);
  });

  it("maps every ladder action to a bounded outcome", () => {
    expect(dependencyUnblockOutcome("dependency-recreate-failed")).toBe("recreate_failed");
    expect(dependencyUnblockOutcome("dependency-unblock-escalate-failed")).toBe("escalate_failed");
    expect(dependencyUnblockOutcome("dependency-unblock-resolved")).toBe("resolved");
    expect(dependencyUnblockOutcome("toString")).toBeNull();
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
      dispatchable_ready_count: 2,
      blocked_count: 1,
      pending_total: 5,
      slices_by_stage: { implementing: 2, "pr-open": 1, bogus: "x" },
      ready_to_merge_count: 1,
      waiting_on_approval_count: 3,
      blocked_on_merge_state_count: 2,
      stranded_count: 4,
      escalated_by_reason: { hatchery_dispatch_failed: 2, other: 1, bogus: "x" },
      dispatch_action_count: 2,
      dispatch_failure_count: 1,
      cleanup_count: 4,
      cleanup_failure_count: 2,
      ghost_cleanup_count: 0,
      ghost_cleanup_failure_count: 5,
      relaunch_count: 0,
      relaunch_failure_count: 3,
      recovery_rate: 2,
      babysit_action_count: 6,
      babysit_actions_by_kind: { conflict_fix: 1, comment_fix: 2, bogus: "x" },
      steward_nudge_count: 7,
      steward_stranded_count: 1,
      pr_blocker_counts: { conflicting: 1, owes_comments: 2, bogus: "x" },
    };
    const activity = buildLoopTickActivity(record, ctx)!;
    expect(activity.snapshot).toEqual({
      profile: "p",
      conductor: "c",
      up: 1,
      lastTickAtMs: 1000,
      queueDispatchable: 3,
      queueDispatchableReady: 2,
      queueBlocked: 1,
      queueTotal: 5,
      workersByState: { running: 1, idle: 2, error: 0 }, // non-number 'bogus' dropped
      slicesByStage: { implementing: 2, "pr-open": 1 }, // non-number 'bogus' dropped
      readyToMerge: 1,
      waitingOnApproval: 3,
      blockedOnMergeState: 2,
      stranded: 4,
      recoveryRate: 2,
      escalatedByReason: { hatchery_dispatch_failed: 2, other: 1 }, // non-number 'bogus' dropped
      prBlocker: { conflicting: 1, owes_comments: 2 }, // non-number 'bogus' dropped
    });
    expect(activity.tickDurationSeconds).toBe(2.5);
    expect(activity).toMatchObject({
      dispatchActions: 2,
      dispatchFailures: 1,
      cleanups: 4,
      cleanupFailures: 2,
      ghostCleanupFailures: 5,
      relaunchFailures: 3,
      babysitActions: 6,
      babysitActionsByKind: { conflict_fix: 1, comment_fix: 2 }, // non-number 'bogus' dropped
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
    expect(activity.cleanupFailures).toBe(0);
    expect(activity.ghostCleanupFailures).toBe(0);
    expect(activity.relaunchFailures).toBe(0);
  });
});
