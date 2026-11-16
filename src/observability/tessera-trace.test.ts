/**
 * @l0 @deterministic @ci
 */
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveOtel, initOtel } from "./otel.js";
import { emitTesseraIssueSpan, type TesseraIssueSpanInput } from "./tessera-trace.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/** Spy on the active tracer so we can inspect the spans the emitter creates. */
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

const BASE: TesseraIssueSpanInput = {
  startTimeMs: 1_794_800_000_000,
  endTimeMs: 1_794_800_000_042,
  caller: "herald",
  identity: "app",
  provider: "github-app",
  access: "read",
  cache: "miss",
  outcome: "issued",
  reason: null,
};

describe("emitTesseraIssueSpan (telemetry off)", () => {
  it("emits nothing, returns undefined and never throws", () => {
    expect(emitTesseraIssueSpan({ ...BASE, sliceId: "slice-abc" })).toBeUndefined();
    expect(emitTesseraIssueSpan({ ...BASE, outcome: "failed", reason: "internal" })).toBeUndefined();
  });
});

describe("emitTesseraIssueSpan (telemetry on)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initOtel({});
  });

  function enable(): Span[] {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    return captureSpans();
  }

  it("nests as a child on the slice's deterministic trace, never its root", () => {
    const spans = enable();
    const ids = emitTesseraIssueSpan({ ...BASE, sliceId: "slice-abc" });
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("tessera.issue");
    expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-abc"));
    expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-abc"));
    expect(span.spanContext().spanId).not.toBe(spanIdForDispatch("slice-abc"));
    expect(ids).toEqual({ traceId: span.spanContext().traceId, spanId: span.spanContext().spanId });
  });

  it("uses the request's own start and end times", () => {
    const spans = enable();
    emitTesseraIssueSpan(BASE);
    const span = spans[0]!;
    expect(span.startTime).toEqual([1_794_800_000, 0]);
    expect(span.endTime).toEqual([1_794_800_000, 42_000_000]);
  });

  const unsliced: Array<[string, string | undefined]> = [
    ["no slice id", undefined],
    ["an empty slice id", ""],
    ["an invalid slice id", "not a slice id!"],
    ["an over-long slice id", "s".repeat(500)],
  ];
  for (const [label, sliceId] of unsliced) {
    it(`starts a service-local trace for ${label}`, () => {
      const spans = enable();
      const ids = emitTesseraIssueSpan({ ...BASE, ...(sliceId === undefined ? {} : { sliceId }) });
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.parentSpanContext).toBeUndefined();
      if (sliceId) expect(span.spanContext().traceId).not.toBe(traceIdForDispatch(sliceId));
      expect(ids?.traceId).toBe(span.spanContext().traceId);
    });
  }

  it("is OK when issued and errored when denied or failed", () => {
    const spans = enable();
    emitTesseraIssueSpan(BASE);
    emitTesseraIssueSpan({ ...BASE, outcome: "denied", reason: "policy_denied", cache: "n/a" });
    emitTesseraIssueSpan({ ...BASE, outcome: "failed", reason: "mint_failed", cache: "n/a" });
    expect(spans.map((span) => span.status.code)).toEqual([
      SpanStatusCode.UNSET,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
  });

  it("carries only the contract's attributes, never a repository, subject, token or key", () => {
    const spans = enable();
    const input = Object.assign(
      { ...BASE, outcome: "denied" as const, reason: "policy_denied", cache: "n/a" },
      {
        repo: "acme/widgets",
        subject: "subject-sentinel",
        token: "ghs_SENTINEL",
        key: "client-key-sentinel",
      },
    );
    emitTesseraIssueSpan(input);
    const attributes = spans[0]!.attributes;
    expect(attributes).toEqual({
      "tessera.caller": "herald",
      "tessera.identity": "app",
      "tessera.provider": "github-app",
      "tessera.access": "read",
      "tessera.cache": "n/a",
      "tessera.outcome": "denied",
      "tessera.reason": "policy_denied",
    });
    const text = JSON.stringify(attributes);
    for (const leaked of ["acme", "subject-sentinel", "ghs_SENTINEL", "client-key-sentinel"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("records unresolved fields as a fixed placeholder and omits a null reason", () => {
    const spans = enable();
    emitTesseraIssueSpan({
      ...BASE,
      caller: "unknown",
      identity: null,
      provider: null,
      access: null,
      cache: "n/a",
      outcome: "denied",
      reason: "unauthorized",
    });
    expect(spans[0]!.attributes).toEqual({
      "tessera.caller": "unknown",
      "tessera.identity": "none",
      "tessera.provider": "none",
      "tessera.access": "none",
      "tessera.cache": "n/a",
      "tessera.outcome": "denied",
      "tessera.reason": "unauthorized",
    });
    emitTesseraIssueSpan(BASE);
    expect(spans[1]!.attributes["tessera.reason"]).toBeUndefined();
  });

  it("never throws when the tracer does", () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const tracer = getActiveOtel().getTracer();
    vi.spyOn(tracer, "startSpan").mockImplementation(() => {
      throw new Error("tracer broke");
    });
    expect(emitTesseraIssueSpan(BASE)).toBeUndefined();
  });
});
