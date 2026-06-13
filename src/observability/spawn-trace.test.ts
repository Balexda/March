/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { getActiveOtel, initOtel } from "./otel.js";
import { startDispatchSpan } from "./spawn-trace.js";

describe("spawn-trace (disabled)", () => {
  it("runs the wrapped function and returns its value when telemetry is off", () => {
    const dispatch = startDispatchSpan({
      traceKey: "my-spec-us1-forge",
      rootName: "hatchery.spawn",
    });
    expect(dispatch.enabled).toBe(false);

    const result = dispatch.span("spawn.start", () => 42);
    expect(result).toBe(42);
  });

  it("spanContext is undefined when disabled", () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "hatchery.spawn" });
    expect(dispatch.spanContext()).toBeUndefined();
  });

  it("propagates exceptions from the wrapped function", () => {
    const dispatch = startDispatchSpan({
      traceKey: "k",
      rootName: "hatchery.spawn",
    });
    expect(() =>
      dispatch.span("spawn.end", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("spanAsync runs the wrapped async function and returns its value when disabled", async () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "hatchery.spawn" });
    await expect(
      dispatch.spanAsync("manager.launch", async () => 7),
    ).resolves.toBe(7);
  });

  it("spanAsync propagates rejections from the wrapped async function", async () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "hatchery.spawn" });
    await expect(
      dispatch.spanAsync("steward.send", async () => {
        throw new Error("send boom");
      }),
    ).rejects.toThrow("send boom");
  });

  it("has no traceparent and a safe no-op end when disabled", () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "r" });
    expect(dispatch.traceparent()).toBeUndefined();
    expect(() => {
      dispatch.setAttributes({ "march.task.type": "forge" });
      dispatch.recordException(new Error("x"));
      dispatch.end({ error: true });
    }).not.toThrow();
  });

  it("passes a no-op span handle to the callback so handle calls are safe", () => {
    const dispatch = startDispatchSpan({ traceKey: "k", rootName: "r" });
    const result = dispatch.span("steward.apply", (span) => {
      // The handle is present even when disabled — these must not throw.
      span.setAttributes({ "march.patch.files": 3 });
      expect(span.spanContext()).toBeUndefined();
      return 99;
    });
    expect(result).toBe(99);
  });
});

describe("spawn-trace (enabled) span handle (#244)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  function captureSpans(): Span[] {
    const tracer = getActiveOtel().getTracer();
    const created: Span[] = [];
    const real = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, "startSpan").mockImplementation((...args: Parameters<typeof real>) => {
      const span = real(...args) as Span;
      created.push(span);
      return span;
    });
    return created;
  }

  it("hands the callback a handle that sets attributes on ITS child span", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const dispatch = startDispatchSpan({ traceKey: "slice-x", rootName: "hatchery.spawn" });
    const created = captureSpans();

    const sc = dispatch.span("steward.apply", (span) => {
      span.setAttributes({ "march.patch.files": 2, "march.patch.strategy": "index-3way" });
      return span.spanContext();
    });

    // The child span carries the attributes set via the handle...
    const child = created.find((s) => s.name === "steward.apply")!;
    expect(child).toBeDefined();
    expect(child.attributes).toMatchObject({
      "march.patch.files": 2,
      "march.patch.strategy": "index-3way",
    });
    // ...and the handle reports the child's own span context (for log correlation).
    expect(sc?.spanId).toBe(child.spanContext().spanId);
  });
});
