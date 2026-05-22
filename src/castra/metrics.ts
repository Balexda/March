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

/** How often `startCastraHeartbeat` ticks the liveness counter. */
const HEARTBEAT_INTERVAL_MS = 15000;

// OTel expects each instrument created once and reused; cache keyed by Meter so
// a fresh initOtel (e.g. between tests) rebuilds against the new provider.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;
let heartbeatCounter: Counter | undefined;

interface CastraInstruments {
  counter: Counter;
  histogram: Histogram;
  heartbeat: Counter;
}

function castraInstruments(meter: Meter): CastraInstruments {
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
    heartbeatCounter = meter.createCounter("march.castra.heartbeat", {
      description: "Liveness heartbeat ticks emitted by the castra service",
      unit: "1",
    });
    // Uptime as an observable gauge — registered once per meter alongside the
    // other instruments so a fresh provider re-attaches the callback.
    meter
      .createObservableGauge("march.castra.uptime", {
        description: "Castra service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));
  }
  return {
    counter: requestsCounter!,
    histogram: durationHistogram!,
    heartbeat: heartbeatCounter!,
  };
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

/**
 * Start the periodic liveness heartbeat (and register the uptime gauge).
 * Returns a stop function. No-op (returns a no-op stopper) when telemetry is
 * disabled. The interval is unref'd so it never keeps the process alive.
 * Mirrors `startHeartbeat`/`startBroodHeartbeat`.
 */
export function startCastraHeartbeat(
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};
  const { heartbeat } = castraInstruments(otel.getMeter());
  heartbeat.add(1); // tick immediately so liveness is visible before the first interval
  const timer = setInterval(() => heartbeat.add(1), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
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
 *
 * `fn` runs with the span installed as the active context, so any logs emitted
 * inside it (the handler's `request.log`) carry this span's trace/span ids and
 * resolve Grafana's "Logs for this span".
 */
export function withCastraSpan<T>(input: CastraSpanInput, fn: () => T): T {
  const dispatch = startDispatchSpan({
    traceKey: input.traceKey,
    rootName: `castra.${input.op}`,
    attributes: input.attributes,
  });
  try {
    const result = dispatch.runActive(fn);
    dispatch.end();
    return result;
  } catch (err) {
    dispatch.recordException(err);
    dispatch.end({ error: true });
    throw err;
  }
}
