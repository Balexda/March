import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { validStatioSliceId } from "./statio-trace.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/** Span name for one Tessera token request (contracts "Events / Hooks"). */
export const TESSERA_ISSUE_SPAN = "tessera.issue";

/** Attribute value for a field the request never resolved. */
export const TESSERA_UNRESOLVED = "none";

/**
 * One token request, as the span reports it. Every field is low-cardinality;
 * there is deliberately no repository, subject, token or key field.
 */
export interface TesseraIssueSpanInput {
  /** The request's `x-march-slice-id`, if any; used only when valid. */
  readonly sliceId?: string;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly caller: string;
  readonly identity: string | null;
  readonly provider: string | null;
  readonly access: string | null;
  readonly cache: string;
  readonly outcome: "issued" | "denied" | "failed";
  /** The error code (a closed set); `null` when issued. */
  readonly reason: string | null;
}

export interface TesseraSpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * Emit one after-the-fact `tessera.issue` span with the request's own start
 * and end times. With a valid slice id the span is a CHILD on that slice's
 * deterministic trace — parented on `spanIdForDispatch(sliceId)`, the virtual
 * parent `legate.dispatch` claims as root — and takes a fresh span id, so it
 * never claims the root. Otherwise it starts a service-local trace. Errored
 * unless a token was issued. Attributes are copied by name from the input, so
 * nothing else on it reaches the span. A no-op returning `undefined` when
 * telemetry is off; never throws.
 */
export function emitTesseraIssueSpan(
  input: TesseraIssueSpanInput,
): TesseraSpanContext | undefined {
  try {
    const otel = getActiveOtel();
    if (!otel.enabled) return undefined;

    const attributes: Attributes = {
      "tessera.caller": input.caller,
      "tessera.identity": input.identity ?? TESSERA_UNRESOLVED,
      "tessera.provider": input.provider ?? TESSERA_UNRESOLVED,
      "tessera.access": input.access ?? TESSERA_UNRESOLVED,
      "tessera.cache": input.cache,
      "tessera.outcome": input.outcome,
      ...(input.reason === null ? {} : { "tessera.reason": input.reason }),
    };

    const sliceId = validStatioSliceId(input.sliceId);
    const parentCtx = sliceId
      ? trace.setSpanContext(ROOT_CONTEXT, {
          traceId: traceIdForDispatch(sliceId),
          spanId: spanIdForDispatch(sliceId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        })
      : ROOT_CONTEXT;

    const span = otel
      .getTracer()
      .startSpan(TESSERA_ISSUE_SPAN, { attributes, startTime: input.startTimeMs }, parentCtx);
    if (input.outcome !== "issued") span.setStatus({ code: SpanStatusCode.ERROR });
    const spanContext = span.spanContext();
    span.end(input.endTimeMs);
    return { traceId: spanContext.traceId, spanId: spanContext.spanId };
  } catch {
    // Telemetry must never fail or alter a token request.
    return undefined;
  }
}
