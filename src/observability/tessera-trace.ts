import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Attributes } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { traceIdForDispatch, spanIdForDispatch } from "./trace-ids.js";

/** Only fixed, validated classifications belong in attributes; never attach errors or bodies. */
export function emitTesseraSpan(name: "tessera.issue" | "tessera.discovery", options: {
  sliceId?: string; error?: boolean; attributes?: Attributes; startTimeMs?: number;
} = {}): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const slice = options.sliceId;
  const valid = slice && Buffer.byteLength(slice) <= 200 && /^[A-Za-z0-9._:/@-]+$/.test(slice);
  const parent = valid ? trace.setSpanContext(ROOT_CONTEXT, {
    traceId: traceIdForDispatch(slice), spanId: spanIdForDispatch(slice),
    traceFlags: TraceFlags.SAMPLED, isRemote: true,
  }) : ROOT_CONTEXT;
  const span = otel.getTracer().startSpan(name, { attributes: options.attributes, startTime: options.startTimeMs }, parent);
  if (options.error) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}
