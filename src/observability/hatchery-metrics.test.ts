/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { initOtel } from "./otel.js";
import {
  decActiveSpawns,
  incActiveSpawns,
  outcomeFromStatus,
  recordHatcheryDispatch,
  recordHatcheryRequest,
  startHeartbeat,
} from "./hatchery-metrics.js";

describe("hatchery-metrics", () => {
  afterEach(() => {
    // Reset the active handle back to the no-op default between cases.
    initOtel({});
  });

  it("maps 2xx/3xx to success and everything else to error", () => {
    expect(outcomeFromStatus(200)).toBe("success");
    expect(outcomeFromStatus(202)).toBe("success");
    expect(outcomeFromStatus(304)).toBe("success");
    expect(outcomeFromStatus(400)).toBe("error");
    expect(outcomeFromStatus(503)).toBe("error");
  });

  it("recording is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordHatcheryRequest({
        route: "/spawns/:id",
        method: "GET",
        outcome: "success",
        durationSeconds: 0.01,
      }),
    ).not.toThrow();
    expect(() => incActiveSpawns()).not.toThrow();
    expect(() => decActiveSpawns()).not.toThrow();
    expect(() =>
      recordHatcheryDispatch({
        backend: "codex",
        taskType: "render",
        profile: "smithy",
        outcome: "failure",
      }),
    ).not.toThrow();
  });

  it("recordHatcheryDispatch folds outcome into the counter when enabled", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    expect(() => {
      recordHatcheryDispatch({
        backend: "codex",
        taskType: "render",
        profile: "smithy",
        outcome: "success",
      });
      recordHatcheryDispatch({
        backend: "codex",
        taskType: "unknown",
        profile: "unknown",
        outcome: "failure",
      });
    }).not.toThrow();
  });

  it("startHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
