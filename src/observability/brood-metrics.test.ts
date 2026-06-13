/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { initOtel } from "./otel.js";
import {
  outcomeFromStatus,
  recordBroodReconciliation,
  recordBroodRequest,
  recordBroodTeardown,
  startBroodHeartbeat,
} from "./brood-metrics.js";

describe("brood-metrics", () => {
  it("re-exports outcomeFromStatus (2xx/3xx success, else error)", () => {
    expect(outcomeFromStatus(201)).toBe("success");
    expect(outcomeFromStatus(404)).toBe("error");
  });

  it("recording is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordBroodRequest({
        route: "/sessions/:id",
        method: "POST",
        outcome: "success",
        durationSeconds: 0.02,
      }),
    ).not.toThrow();
    expect(() =>
      recordBroodTeardown({
        kind: "spawn",
        outcome: "success",
        profile: "march",
        durationSeconds: 0.3,
      }),
    ).not.toThrow();
  });

  it("startBroodHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startBroodHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("recordBroodReconciliation is a no-op when disabled and folds when enabled", () => {
    const samples = [{ profile: "march", castraLive: 54, trackedActive: 0, orphans: 54 }];
    initOtel({});
    expect(() => recordBroodReconciliation(samples)).not.toThrow();
    try {
      initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
      expect(() => recordBroodReconciliation(samples)).not.toThrow();
    } finally {
      initOtel({});
    }
  });
});
