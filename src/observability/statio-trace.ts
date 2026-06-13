import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

export interface StatioRequestSpanInput {
  readonly method: string;
  /** Matched route pattern, never the raw URL. */
  readonly route: string;
  readonly statusCode: number;
  readonly sliceId?: string;
  readonly startTimeMs?: number;
  readonly endTimeMs?: number;
}

const MAX_SLICE_ID_BYTES = 200;
const SLICE_ID_PATTERN = /^[A-Za-z0-9._:/@-]+$/;

function validSliceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_SLICE_ID_BYTES) return undefined;
  return SLICE_ID_PATTERN.test(value) ? value : undefined;
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Emit one Statio HTTP request span. With a valid slice id, the span is a child
 * of that deterministic slice trace; otherwise it is a service-local span.
 * Telemetry remains a no-op unless MARCH_OTEL=1.
 */
export function emitStatioRequestSpan(input: StatioRequestSpanInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const sliceId = validSliceId(input.sliceId);
  const attributes: Attributes = {
    "statio.method": input.method,
    "statio.route": input.route,
    "statio.status_class": statusClass(input.statusCode),
    "statio.outcome": input.statusCode >= 500 ? "failure" : "success",
  };

  const parentCtx = sliceId
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: traceIdForDispatch(sliceId),
        spanId: spanIdForDispatch(sliceId),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      })
    : ROOT_CONTEXT;

  const span = otel.getTracer().startSpan(
    "statio.request",
    { attributes, startTime: input.startTimeMs },
    parentCtx,
  );
  if (input.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(input.endTimeMs);
}
