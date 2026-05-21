import { describe, expect, it } from "vitest";
import {
  outcomeFromStatus,
  recordHeraldObserve,
  recordHeraldObserveError,
  recordHeraldRequest,
  startHeraldHeartbeat,
} from "./herald-metrics.js";

describe("herald-metrics", () => {
  it("re-exports outcomeFromStatus (2xx/3xx success, else error)", () => {
    expect(outcomeFromStatus(200)).toBe("success");
    expect(outcomeFromStatus(503)).toBe("error");
  });

  it("recording is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordHeraldRequest({ route: "/events", method: "GET", outcome: "success", durationSeconds: 0.01 }),
    ).not.toThrow();
    expect(() =>
      recordHeraldObserve({ durationSeconds: 0.2, eventsByType: { "slice.pr.changed": 2, heartbeat: 0 } }),
    ).not.toThrow();
    expect(() => recordHeraldObserveError()).not.toThrow();
  });

  it("startHeraldHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startHeraldHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
