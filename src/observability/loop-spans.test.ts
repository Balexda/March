/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { getActiveOtel, initOtel } from "./otel.js";
import { emitLoopSpan, initLoopSpans } from "./loop-spans.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/** Spy on the active tracer so we can inspect the spans emitLoopSpan creates. */
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

describe("loop spans", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  it("is a no-op (does not throw, does not emit) when telemetry is disabled", () => {
    initOtel({});
    const start = vi.spyOn(getActiveOtel().getTracer(), "startSpan");
    expect(() =>
      emitLoopSpan({ name: "legate.dispatch", traceKey: "slice-1", root: true }),
    ).not.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not emit without a trace key", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();
    emitLoopSpan({ name: "legate.dispatch", traceKey: "", root: true });
    expect(created).toHaveLength(0);
  });

  it("emits legate.dispatch as the deterministic trace root that orchestrator spans nest under", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    initLoopSpans({ profile: "smithy" });
    const created = captureSpans();

    emitLoopSpan({
      name: "legate.dispatch",
      traceKey: "slice-abc",
      root: true,
      attributes: { "march.slice_id": "slice-abc", "march.dispatch_mode": "spawn" },
    });

    expect(created).toHaveLength(1);
    const ctx = created[0]!.spanContext();
    // Same deterministic trace id the orchestrator/in-spawn emitter derive...
    expect(ctx.traceId).toBe(traceIdForDispatch("slice-abc"));
    // ...and it CLAIMS the deterministic span id so hatchery.spawn / spawn.*
    // (which set that id as their parent) nest beneath it.
    expect(ctx.spanId).toBe(spanIdForDispatch("slice-abc"));
    // A root span has no parent.
    expect(created[0]!.parentSpanContext).toBeUndefined();
    expect(created[0]!.status.code).toBe(SpanStatusCode.OK);
    expect(created[0]!.attributes).toMatchObject({
      "march.profile": "smithy",
      "march.slice_id": "slice-abc",
      "march.dispatch_mode": "spawn",
    });
  });

  it("marks a failed dispatch launch as an errored root span", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();

    emitLoopSpan({
      name: "legate.dispatch",
      traceKey: "slice-fail",
      root: true,
      error: true,
      attributes: { "march.error": "dispatch launch failed" },
    });

    expect(created[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("nests legate.babysit / legate.cleanup under the deterministic dispatch parent", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created = captureSpans();

    emitLoopSpan({
      name: "legate.babysit",
      traceKey: "slice-xyz",
      root: false,
      attributes: { "march.slice_id": "slice-xyz" },
    });

    expect(created).toHaveLength(1);
    const ctx = created[0]!.spanContext();
    expect(ctx.traceId).toBe(traceIdForDispatch("slice-xyz"));
    // The child points at the same deterministic parent that legate.dispatch claims.
    expect(created[0]!.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-xyz"));
    // ...with its own (non-deterministic) span id, distinct from that parent.
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.spanId).not.toBe(spanIdForDispatch("slice-xyz"));
    expect(created[0]!.status.code).toBe(SpanStatusCode.OK);
  });

  it("defaults the profile to unknown until initLoopSpans is called", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    initLoopSpans({ profile: "" });
    const created = captureSpans();
    emitLoopSpan({ name: "legate.cleanup", traceKey: "slice-1", root: false });
    expect(created[0]!.attributes["march.profile"]).toBe("unknown");
  });
});
