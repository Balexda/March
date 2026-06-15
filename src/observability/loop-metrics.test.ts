/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { initOtel } from "./otel.js";
import { recordDwell, recordLoopHeartbeat, recordSpawnBudget, type LoopTickActivity } from "./loop-metrics.js";

function activity(overrides: Partial<LoopTickActivity> = {}): LoopTickActivity {
  return {
    snapshot: {
      profile: "smithy",
      conductor: "demo-legate",
      up: 1,
      lastTickAtMs: Date.now(),
      queueDispatchable: 2,
      queueDispatchableReady: 2,
      queueBlocked: 1,
      queueTotal: 5,
      workersByState: { running: 1, idle: 2 },
      slicesByStage: { implementing: 1, "pr-open": 2 },
      readyToMerge: 1,
      waitingOnApproval: 1,
      blockedOnMergeState: 1,
      escalatedByReason: { hatchery_dispatch_failed: 0, other: 0 },
      prBlocker: { conflicting: 0, owes_review_threads: 0, owes_comments: 0, ci_failing: 0 },
      stewardsAwaitingInput: 2,
    },
    tickDurationSeconds: 0.4,
    dispatchActions: 1,
    dispatchFailures: 0,
    cleanups: 0,
    cleanupFailures: 0,
    ghostCleanups: 0,
    ghostCleanupFailures: 0,
    relaunches: 0,
    relaunchFailures: 0,
    babysitActions: 0,
    stewardNudges: 0,
    stewardStranded: 0,
    ...overrides,
  };
}

describe("loop-metrics", () => {
  afterEach(() => {
    // Reset the active handle back to the no-op default.
    initOtel({});
  });

  it("is a no-op (does not throw) when telemetry is disabled", () => {
    initOtel({});
    expect(() => recordLoopHeartbeat(activity())).not.toThrow();
  });

  it("does not throw when enabled and folds activity into instruments", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    expect(() =>
      recordLoopHeartbeat(
        activity({
          dispatchFailures: 2,
          cleanups: 1,
          cleanupFailures: 1,
          ghostCleanups: 1,
          ghostCleanupFailures: 2,
          relaunchFailures: 1,
          babysitActions: 3,
          stewardNudges: 4,
          stewardStranded: 1,
        }),
      ),
    ).not.toThrow();
  });

  it("recordSpawnBudget is a no-op when disabled and folds when enabled", () => {
    initOtel({});
    expect(() => recordSpawnBudget({ cap: 10, live: 41, deferred: 13 })).not.toThrow();
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    expect(() => recordSpawnBudget({ cap: 10, live: 41, deferred: 13 })).not.toThrow();
  });

  it("recordDwell is a no-op when disabled and folds (gauges + histogram) when enabled", () => {
    const sample = {
      stageAgeMaxSeconds: { "hatchery-pending": 1800, implementing: 0 },
      mergeGateAgeMaxSeconds: { ready: 0, "waiting-approval": 600, "blocked-merge-state": 0 },
      mergeBlockerAgeMaxSeconds: { conflicting: 0, owes_review_threads: 0, owes_comments: 0, ci_failing: 0 },
      completedStageDwells: [{ stage: "implementing", seconds: 1234 }],
    };
    initOtel({});
    expect(() => recordDwell("march", sample)).not.toThrow();
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    expect(() => recordDwell("march", sample)).not.toThrow();
  });
});
