import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

/**
 * A herald span (e.g. `herald.request`, `herald.observe`). No-op when telemetry
 * is off, so callers can wrap work unconditionally with zero behavioural impact.
 */
export interface HeraldSpan {
  readonly enabled: boolean;
  setAttributes(attributes: Attributes): void;
  end(opts?: { error?: boolean }): void;
}

const NOOP: HeraldSpan = {
  enabled: false,
  setAttributes: () => {},
  end: () => {},
};

/** Parse a W3C traceparent into its trace/span ids, or undefined if malformed. */
function parseTraceparent(
  traceparent?: string,
): { traceId: string; spanId: string } | undefined {
  if (!traceparent) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(
    traceparent.trim(),
  );
  return match ? { traceId: match[1], spanId: match[2] } : undefined;
}

export interface StartHeraldSpanInput {
  /** Span name, e.g. `"herald.request"` or `"herald.observe"`. */
  readonly name: string;
  /**
   * Inbound W3C traceparent (from the caller) to nest this span under. When it
   * is absent or malformed the span starts a FRESH root trace — which is what
   * surfaces march-herald in Tempo for internally-initiated work like the
   * periodic observe tick.
   */
  readonly traceparent?: string;
  readonly attributes?: Attributes;
}

/**
 * Start a herald span. When the caller supplies a valid `traceparent` the span
 * nests under that remote trace (so a legate-initiated request lands in the
 * originating trace); otherwise it begins a new root trace. No-op when telemetry
 * is disabled.
 */
export function startHeraldSpan(input: StartHeraldSpanInput): HeraldSpan {
  const otel = getActiveOtel();
  if (!otel.enabled) return NOOP;

  const tracer = otel.getTracer();
  const parent = parseTraceparent(input.traceparent);
  // Anchor on ROOT_CONTEXT either way: with a parent span context to nest under
  // the inbound trace, or bare so the span is a fresh root (never accidentally a
  // child of some ambient active span).
  const parentCtx = parent
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parent.traceId,
        spanId: parent.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      })
    : ROOT_CONTEXT;
  const span = tracer.startSpan(
    input.name,
    { attributes: input.attributes },
    parentCtx,
  );

  return {
    enabled: true,
    setAttributes(attributes: Attributes) {
      span.setAttributes(attributes);
    },
    end(opts?: { error?: boolean }) {
      if (opts?.error) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  };
}
