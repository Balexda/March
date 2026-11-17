/** @l1 @deterministic @ci */
import { expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { getActiveOtel, initOtel } from "./otel.js";
import { emitTesseraSpan } from "./tessera-trace.js";
import { traceIdForDispatch, spanIdForDispatch } from "./trace-ids.js";
it("nests errored issuance under the deterministic slice and records discovery failure safely", async () => {
  initOtel({MARCH_OTEL:"1"});
  const tracer = getActiveOtel().getTracer(); const real = tracer.startSpan.bind(tracer); const spans: Span[] = [];
  vi.spyOn(tracer,"startSpan").mockImplementation((...args: Parameters<typeof real>) => { const span = real(...args) as Span; spans.push(span); return span; });
  try {
    emitTesseraSpan("tessera.issue",{sliceId:"slice-1",error:true,attributes:{outcome:"denied"}});
    emitTesseraSpan("tessera.discovery",{error:true});
    expect(spans[0].spanContext().traceId).toBe(traceIdForDispatch("slice-1"));
    expect(spans[0].parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-1"));
    expect(spans.map(span => span.status.code)).toEqual([SpanStatusCode.ERROR,SpanStatusCode.ERROR]);
    expect(spans[0].attributes).toEqual({outcome:"denied"});
  // Repo convention: reset to the no-op handle without awaiting shutdown(); its OTLP flush blocks past the test timeout when no collector runs (CI).
  } finally { vi.restoreAllMocks(); initOtel({}); }
});
