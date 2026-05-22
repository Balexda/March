import { describe, expect, it } from "vitest";
import {
  recordCastraRequest,
  startCastraHeartbeat,
  statusClass,
  withCastraSpan,
} from "./metrics.js";

describe("castra metrics", () => {
  it("maps status codes to a status class", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(502)).toBe("5xx");
  });

  it("is a no-op (does not throw) when telemetry is disabled", () => {
    expect(() =>
      recordCastraRequest({
        route: "/v1/sessions",
        method: "POST",
        statusClass: "2xx",
        profile: "march",
        outcome: "success",
        durationSeconds: 0.1,
      }),
    ).not.toThrow();
  });

  it("runs the wrapped fn and returns its value when telemetry is disabled", () => {
    const result = withCastraSpan({ op: "launch", traceKey: "k" }, () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the wrapped fn", () => {
    expect(() =>
      withCastraSpan({ op: "remove", traceKey: "k" }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("startCastraHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startCastraHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
