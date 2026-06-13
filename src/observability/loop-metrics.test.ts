/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { initOtel } from "./otel.js";
import { recordLoopHeartbeat, type LoopTickActivity } from "./loop-metrics.js";

function activity(overrides: Partial<LoopTickActivity> = {}): LoopTickActivity {
  return {
    snapshot: {
      profile: "smithy",
      conductor: "demo-legate",
      up: 1,
      lastTickAtMs: Date.now(),
      queueDispatchable: 2,
      queueBlocked: 1,
      queueTotal: 5,
      workersByState: { running: 1, idle: 2 },
      slicesByStage: { implementing: 1, "pr-open": 2 },
      readyToMerge: 1,
    },
    tickDurationSeconds: 0.4,
    dispatchActions: 1,
    dispatchFailures: 0,
    cleanups: 0,
    ghostCleanups: 0,
    relaunches: 0,
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
          ghostCleanups: 1,
          babysitActions: 3,
          stewardNudges: 4,
          stewardStranded: 1,
        }),
      ),
    ).not.toThrow();
  });
});
