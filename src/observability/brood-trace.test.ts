import { afterEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { startBroodSpan } from "./brood-trace.js";
import { getActiveOtel, initOtel } from "./otel.js";

/** Spy on the active tracer so we can inspect the spans startBroodSpan creates. */
function captureSpans(): Span[] {
  const tracer = getActiveOtel().getTracer();
  const created: Span[] = [];
  const real = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, "startSpan").mockImplementation(
    (...args: Parameters<typeof real>) => {
      const span = real(...args) as Span;
      created.push(span);
      return span;
    },
  );
  return created;
}

describe("startBroodSpan", () => {
  it("returns a disabled no-op span when telemetry is off", () => {
    const span = startBroodSpan({ name: "brood.teardown", key: "s1" });
    expect(span.enabled).toBe(false);
    expect(() => span.event("teardown.container", { outcome: "ok" })).not.toThrow();
    expect(() => span.setAttributes({ "march.session.id": "s1" })).not.toThrow();
    const child = span.startChild("brood.teardown.worktree");
    expect(() => child.setAttributes({ "march.teardown.outcome": "removed" })).not.toThrow();
    expect(() => child.end({ error: true })).not.toThrow();
    expect(() => span.end({ error: true })).not.toThrow();
  });

  it("accepts an inbound traceparent without throwing (no-op when disabled)", () => {
    const span = startBroodSpan({
      name: "brood.teardown",
      key: "s1",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(span.enabled).toBe(false);
    span.end();
  });
});

describe("startBroodSpan (telemetry on)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  it("nests a child span under the parent span's context", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();

    const span = startBroodSpan({ name: "brood.teardown", key: "s1" });
    const child = span.startChild("brood.teardown.worktree", {
      "march.worktree.path": "/wt/s1",
    });
    child.end();
    span.end();

    expect(created).toHaveLength(2);
    const [parent, kid] = created;
    // The child shares the parent's trace and points at the parent's span id.
    expect(kid!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(kid!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
    expect(kid!.attributes["march.worktree.path"]).toBe("/wt/s1");
  });
});
