import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/** A brood lifecycle span (e.g. `brood.teardown`). No-op when telemetry is off. */
export interface BroodSpan {
  readonly enabled: boolean;
  /** Record an ordered, timestamped step on the span. */
  event(name: string, attributes?: Attributes): void;
  setAttributes(attributes: Attributes): void;
  end(opts?: { error?: boolean }): void;
}

const NOOP: BroodSpan = {
  enabled: false,
  event: () => {},
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

export interface StartBroodSpanInput {
  readonly name: string;
  /** Stable key used to derive a deterministic trace id when no parent is given. */
  readonly key: string;
  /** Inbound W3C traceparent (from the caller) to nest this span under. */
  readonly traceparent?: string;
  readonly attributes?: Attributes;
}

/**
 * Start a brood lifecycle span. When the caller supplies a `traceparent` the
 * span nests under that trace (so a loop-initiated teardown lands in the
 * originating dispatch trace); otherwise the trace id is derived
 * deterministically from `key`. Per-step detail is attached via {@link
 * BroodSpan.event}.
 */
export function startBroodSpan(input: StartBroodSpanInput): BroodSpan {
  const otel = getActiveOtel();
  if (!otel.enabled) return NOOP;

  const tracer = otel.getTracer();
  const parent = parseTraceparent(input.traceparent) ?? {
    traceId: traceIdForDispatch(input.key),
    spanId: spanIdForDispatch(input.key),
  };
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  const span = tracer.startSpan(
    input.name,
    { attributes: input.attributes },
    parentCtx,
  );

  return {
    enabled: true,
    event(name: string, attributes?: Attributes) {
      span.addEvent(name, attributes);
    },
    setAttributes(attributes: Attributes) {
      span.setAttributes(attributes);
    },
    end(opts?: { error?: boolean }) {
      if (opts?.error) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  };
}
