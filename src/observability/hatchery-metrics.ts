import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  UpDownCounter,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

/** Outcome label for an HTTP request: 2xx/3xx is success, else error. */
export type RequestOutcome = "success" | "error";

/** A 2xx/3xx status is a success; everything else is an error. */
export function outcomeFromStatus(statusCode: number): RequestOutcome {
  return statusCode >= 200 && statusCode < 400 ? "success" : "error";
}

export interface RecordHatcheryRequestInput {
  /** Route TEMPLATE (e.g. "/spawns/:id"), never the concrete path — keeps cardinality bounded. */
  readonly route: string;
  readonly method: string;
  readonly outcome: RequestOutcome;
  readonly durationSeconds: number;
}

const HEARTBEAT_INTERVAL_MS = 15000;

// OTel expects each instrument created once and reused. Cache keyed by Meter so
// a fresh initOtel (e.g. between tests) transparently rebuilds against the new
// provider rather than reusing stale handles — mirrors spawn-metrics.ts.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let requestDuration: Histogram | undefined;
let activeSpawns: UpDownCounter | undefined;
let heartbeatCounter: Counter | undefined;

interface HatcheryInstruments {
  requests: Counter;
  duration: Histogram;
  active: UpDownCounter;
  heartbeat: Counter;
}

function hatcheryInstruments(meter: Meter): HatcheryInstruments {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    requestsCounter = meter.createCounter("march.hatchery.requests", {
      description: "Count of hatchery HTTP requests by route, method and outcome",
      unit: "1",
    });
    requestDuration = meter.createHistogram("march.hatchery.request.duration", {
      description: "Hatchery HTTP request wall-clock duration",
      unit: "s",
    });
    activeSpawns = meter.createUpDownCounter("march.hatchery.active_spawns", {
      description: "Spawn jobs currently executing in the hatchery service",
      unit: "1",
    });
    heartbeatCounter = meter.createCounter("march.hatchery.heartbeat", {
      description: "Liveness heartbeat ticks emitted by the hatchery service",
      unit: "1",
    });
    // Uptime as an observable gauge — registered once per meter alongside the
    // other instruments so a fresh provider re-attaches the callback.
    meter
      .createObservableGauge("march.hatchery.uptime", {
        description: "Hatchery service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));
  }
  return {
    requests: requestsCounter!,
    duration: requestDuration!,
    active: activeSpawns!,
    heartbeat: heartbeatCounter!,
  };
}

/** Record one HTTP request: count + duration tagged by route/method/outcome. No-op when disabled. */
export function recordHatcheryRequest(input: RecordHatcheryRequestInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const { requests, duration } = hatcheryInstruments(otel.getMeter());
  const attributes: Attributes = {
    route: input.route,
    method: input.method,
    outcome: input.outcome,
  };
  requests.add(1, attributes);
  duration.record(input.durationSeconds, attributes);
}

/** Bump the active-spawns gauge when a job starts. No-op when disabled. */
export function incActiveSpawns(): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  hatcheryInstruments(otel.getMeter()).active.add(1);
}

/** Drop the active-spawns gauge when a job reaches a terminal state. No-op when disabled. */
export function decActiveSpawns(): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  hatcheryInstruments(otel.getMeter()).active.add(-1);
}

/**
 * Start the periodic liveness heartbeat (and register the uptime gauge).
 * Returns a stop function. No-op (returns a no-op stopper) when telemetry is
 * disabled. The interval is unref'd so it never keeps the process alive.
 */
export function startHeartbeat(intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};
  const { heartbeat } = hatcheryInstruments(otel.getMeter());
  heartbeat.add(1); // tick immediately so liveness is visible before the first interval
  const timer = setInterval(() => heartbeat.add(1), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
