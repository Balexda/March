import { describe, expect, it } from "vitest";
import {
  decActiveSpawns,
  incActiveSpawns,
  outcomeFromStatus,
  recordHatcheryRequest,
  startHeartbeat,
} from "./hatchery-metrics.js";

describe("hatchery-metrics", () => {
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
  });

  it("startHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
