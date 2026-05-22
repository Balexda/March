import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/**
 * A herald span. No-op when telemetry is off, so callers can wrap work
 * unconditionally with zero behavioural impact.
 *
 * Two flavours, both produced by {@link startHeraldSpan}:
 *  - **Change spans** (`herald.pr.merged`, `herald.output.changed`, …): one per
 *    state change Herald observes. Slice-scoped changes nest as CHILDREN of the
 *    slice's dispatch trace (via `dispatchKey`) so they share the trace with
 *    `legate.dispatch → hatchery.spawn`; system changes (workers/queue/session)
 *    have no dispatch trace and stand alone.
 *  - **Request spans** (`herald.request`): synthesized at response time for
 *    mutations / 5xx only (reads and health polls are left to metrics).
 */
export interface HeraldSpan {
  readonly enabled: boolean;
  setAttributes(attributes: Attributes): void;
  end(opts?: { error?: boolean; endTimeMs?: number }): void;
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
  /** Span name, e.g. `"herald.pr.merged"` or `"herald.request"`. Low-cardinality. */
  readonly name: string;
  /**
   * Deterministic dispatch key (the slice id). When set, the span nests as a
   * CHILD of that slice's dispatch trace — `traceIdForDispatch(key)` with parent
   * `spanIdForDispatch(key)`, the same virtual parent `legate.dispatch` claims as
   * its root. The child takes a fresh (random) span id, so it is always a child
   * and NEVER the root — the legate stays the trace's sole originator.
   */
  readonly dispatchKey?: string;
  /**
   * Inbound W3C traceparent to nest under. Used only when `dispatchKey` is
   * absent. When both are absent the span starts a fresh root trace.
   */
  readonly traceparent?: string;
  readonly attributes?: Attributes;
  /** Backdated start (epoch ms) — lets a response-time hook give a request span its real duration. */
  readonly startTimeMs?: number;
}

/**
 * Start a herald span. Parent precedence: `dispatchKey` (nest under the slice's
 * dispatch trace) → `traceparent` (nest under the caller) → fresh root. No-op
 * when telemetry is disabled.
 */
export function startHeraldSpan(input: StartHeraldSpanInput): HeraldSpan {
  const otel = getActiveOtel();
  if (!otel.enabled) return NOOP;

  const tracer = otel.getTracer();
  const parent = input.dispatchKey
    ? {
        traceId: traceIdForDispatch(input.dispatchKey),
        spanId: spanIdForDispatch(input.dispatchKey),
      }
    : parseTraceparent(input.traceparent);
  // With a parent, anchor a remote span context on ROOT_CONTEXT so the span
  // nests as a child; without one, ROOT_CONTEXT alone makes it a fresh root
  // (never an accidental child of some ambient active span).
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
    { attributes: input.attributes, startTime: input.startTimeMs },
    parentCtx,
  );

  return {
    enabled: true,
    setAttributes(attributes: Attributes) {
      span.setAttributes(attributes);
    },
    end(opts?: { error?: boolean; endTimeMs?: number }) {
      if (opts?.error) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(opts?.endTimeMs);
    },
  };
}
