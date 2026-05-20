import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "../observability/otel.js";
import { startDispatchSpan } from "../observability/spawn-trace.js";

/**
 * Castra request telemetry. Metrics use only low-cardinality labels (route
 * pattern, method, status class, profile, outcome) — never session ids, paths,
 * or prompt content, which belong in spans/logs. All no-ops when telemetry is
 * disabled (MARCH_OTEL!=1), mirroring `spawn-metrics.ts`.
 */

export interface RecordCastraRequestInput {
  /** The matched route pattern (e.g. "/v1/sessions/:id"), NOT the raw URL. */
  readonly route: string;
  readonly method: string;
  /** "2xx" | "4xx" | "5xx" — the response status class. */
  readonly statusClass: string;
  /** The agent-deck profile the request targeted, or "unknown". */
  readonly profile: string;
  /** "success" for <500, "failure" otherwise. */
  readonly outcome: "success" | "failure";
  readonly durationSeconds: number;
}

// OTel expects each instrument created once and reused; cache keyed by Meter so
// a fresh initOtel (e.g. between tests) rebuilds against the new provider.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;

function castraInstruments(meter: Meter): { counter: Counter; histogram: Histogram } {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    requestsCounter = meter.createCounter("march.castra.requests", {
      description: "Count of Castra API requests by route and outcome",
      unit: "1",
    });
    durationHistogram = meter.createHistogram("march.castra.request.duration", {
      description: "Castra API request wall-clock duration",
      unit: "s",
    });
  }
  return { counter: requestsCounter!, histogram: durationHistogram! };
}

export function recordCastraRequest(input: RecordCastraRequestInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const { counter, histogram } = castraInstruments(otel.getMeter());
  const attributes: Attributes = {
    route: input.route,
    method: input.method,
    status_class: input.statusClass,
    profile: input.profile,
    outcome: input.outcome,
  };
  counter.add(1, attributes);
  histogram.record(input.durationSeconds, attributes);
}

/** Map an HTTP status code to its status class label. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export interface CastraSpanInput {
  /** Operation suffix; the span is named `castra.<op>` (e.g. "launch"). */
  readonly op: string;
  /**
   * Trace key — the dispatch slice id when the caller supplied one (so Castra
   * spans nest under the existing per-dispatch trace), else a per-request key.
   */
  readonly traceKey: string;
  readonly attributes?: Attributes;
}

/**
 * Run a mutating operation inside a `castra.<op>` span. No-op (just runs `fn`)
 * when telemetry is disabled. Records the exception and marks the span errored
 * if `fn` throws, so failures surface in traces rather than vanishing.
 */
export function withCastraSpan<T>(input: CastraSpanInput, fn: () => T): T {
  const dispatch = startDispatchSpan({
    traceKey: input.traceKey,
    rootName: `castra.${input.op}`,
    attributes: input.attributes,
  });
  try {
    const result = fn();
    dispatch.end();
    return result;
  } catch (err) {
    dispatch.recordException(err);
    dispatch.end({ error: true });
    throw err;
  }
}
