/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { initOtel } from "../observability/otel.js";
import { traceIdForDispatch } from "../observability/trace-ids.js";
import {
  recordCastraRequest,
  startCastraHeartbeat,
  statusClass,
  withCastraSpan,
} from "./metrics.js";

describe("castra metrics", () => {
  // Some tests flip telemetry on; always restore the no-op handle afterwards.
  afterEach(() => initOtel({}));

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

  it("passes the castra.<op> span trace context to fn (for explicit log correlation)", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    let captured: { traceId: string; spanId: string } | undefined;
    withCastraSpan({ op: "send", traceKey: "slice-abc" }, (span) => {
      captured = span;
    });
    // The span's trace id is the deterministic per-slice trace, so the log line
    // correlates to the same trace legate/hatchery use for this slice.
    expect(captured?.traceId).toBe(traceIdForDispatch("slice-abc"));
    // ...and its own (real) 16-hex root span id.
    expect(captured?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("passes undefined span context to fn when telemetry is disabled", () => {
    initOtel({});
    let captured: { traceId: string; spanId: string } | undefined = {
      traceId: "x",
      spanId: "y",
    };
    withCastraSpan({ op: "send", traceKey: "k" }, (span) => {
      captured = span;
    });
    expect(captured).toBeUndefined();
  });

  it("startCastraHeartbeat returns a no-op stopper when disabled", () => {
    const stop = startCastraHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});
