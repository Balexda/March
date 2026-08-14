/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { initOtel } from "./otel.js";
import {
  recordStatioRequest,
  startStatioHeartbeat,
  statusClass,
} from "./statio-metrics.js";

describe("statio-metrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    initOtel({});
  });

  it("maps status codes to low-cardinality classes", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(502)).toBe("5xx");
  });

  it("recording and heartbeat are no-ops when telemetry is disabled", () => {
    expect(() =>
      recordStatioRequest({
        route: "/v1/prs/:number",
        method: "GET",
        statusClass: "2xx",
        operation: "get_pr",
        outcome: "success",
        durationSeconds: 0.01,
      }),
    ).not.toThrow();

    const stop = startStatioHeartbeat(10);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("records RED metrics with route-pattern labels when telemetry is enabled", () => {
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    const add = vi.fn();
    const record = vi.fn();
    vi.spyOn(meter, "createCounter").mockReturnValue({ add } as never);
    vi.spyOn(meter, "createHistogram").mockReturnValue({ record } as never);
    vi.spyOn(meter, "createObservableGauge").mockReturnValue({
      addCallback: vi.fn(),
    } as never);

    recordStatioRequest({
      route: "/v1/prs/:number",
      method: "GET",
      statusClass: "5xx",
      operation: "get_pr",
      outcome: "failure",
      durationSeconds: 0.25,
    });

    expect(add).toHaveBeenCalledWith(1, {
      route: "/v1/prs/:number",
      method: "GET",
      status_class: "5xx",
      operation: "get_pr",
      outcome: "failure",
    });
    expect(record).toHaveBeenCalledWith(0.25, {
      route: "/v1/prs/:number",
      method: "GET",
      status_class: "5xx",
      operation: "get_pr",
      outcome: "failure",
    });
  });

  it("starts and stops the heartbeat when telemetry is enabled", () => {
    vi.useFakeTimers();
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    const add = vi.fn();
    vi.spyOn(meter, "createCounter").mockReturnValue({ add } as never);
    vi.spyOn(meter, "createHistogram").mockReturnValue({ record: vi.fn() } as never);
    vi.spyOn(meter, "createObservableGauge").mockReturnValue({
      addCallback: vi.fn(),
    } as never);

    const stop = startStatioHeartbeat(100);
    expect(add).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    expect(add).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(250);
    expect(add).toHaveBeenCalledTimes(3);
  });
});
