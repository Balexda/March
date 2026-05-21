import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { type RequestOutcome, outcomeFromStatus } from "./hatchery-metrics.js";

export { type RequestOutcome, outcomeFromStatus };

export interface RecordHeraldRequestInput {
  /** Route TEMPLATE (e.g. "/events"), never the concrete path. */
  readonly route: string;
  readonly method: string;
  readonly outcome: RequestOutcome;
  readonly durationSeconds: number;
}

export interface RecordHeraldObserveInput {
  readonly durationSeconds: number;
  /** Count of events appended this tick, keyed by event type (low cardinality). */
  readonly eventsByType: Record<string, number>;
}

const HEARTBEAT_INTERVAL_MS = 15000;

// One instrument per Meter, rebuilt transparently when initOtel swaps the
// provider (e.g. between tests) — mirrors brood/hatchery metrics.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let requestDuration: Histogram | undefined;
let observeDuration: Histogram | undefined;
let eventsCounter: Counter | undefined;
let observeErrors: Counter | undefined;
let heartbeatCounter: Counter | undefined;

interface HeraldInstruments {
  requests: Counter;
  requestDuration: Histogram;
  observeDuration: Histogram;
  events: Counter;
  observeErrors: Counter;
  heartbeat: Counter;
}

function heraldInstruments(meter: Meter): HeraldInstruments {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    requestsCounter = meter.createCounter("march.herald.requests", {
      description: "Count of herald HTTP requests by route, method and outcome",
      unit: "1",
    });
    requestDuration = meter.createHistogram("march.herald.request.duration", {
      description: "Herald HTTP request wall-clock duration",
      unit: "s",
    });
    observeDuration = meter.createHistogram("march.herald.observe.duration", {
      description: "Herald observe-tick wall-clock duration",
      unit: "s",
    });
    eventsCounter = meter.createCounter("march.herald.events", {
      description: "Count of change events Herald appended, by type",
      unit: "1",
    });
    observeErrors = meter.createCounter("march.herald.observe.errors", {
      description: "Count of failed Herald observe ticks",
      unit: "1",
    });
    heartbeatCounter = meter.createCounter("march.herald.heartbeat", {
      description: "Liveness heartbeat ticks emitted by the herald service",
      unit: "1",
    });
    meter
      .createObservableGauge("march.herald.uptime", {
        description: "Herald service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));
  }
  return {
    requests: requestsCounter!,
    requestDuration: requestDuration!,
    observeDuration: observeDuration!,
    events: eventsCounter!,
    observeErrors: observeErrors!,
    heartbeat: heartbeatCounter!,
  };
}

/** Record one HTTP request: count + duration by route/method/outcome. No-op when disabled. */
export function recordHeraldRequest(input: RecordHeraldRequestInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const instruments = heraldInstruments(otel.getMeter());
  const attributes: Attributes = {
    route: input.route,
    method: input.method,
    outcome: input.outcome,
  };
  instruments.requests.add(1, attributes);
  instruments.requestDuration.record(input.durationSeconds, attributes);
}

/** Record one observe tick: duration + appended events by type. No-op when disabled. */
export function recordHeraldObserve(input: RecordHeraldObserveInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const instruments = heraldInstruments(otel.getMeter());
  instruments.observeDuration.record(input.durationSeconds);
  for (const [type, count] of Object.entries(input.eventsByType)) {
    if (count > 0) instruments.events.add(count, { type });
  }
}

/** Record one failed observe tick. No-op when disabled. */
export function recordHeraldObserveError(): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  heraldInstruments(otel.getMeter()).observeErrors.add(1);
}

/**
 * Start the periodic liveness heartbeat (and register the uptime gauge).
 * Returns a stop function. No-op when telemetry is disabled. The interval is
 * unref'd so it never keeps the process alive.
 */
export function startHeraldHeartbeat(
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};
  const { heartbeat } = heraldInstruments(otel.getMeter());
  heartbeat.add(1);
  const timer = setInterval(() => heartbeat.add(1), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
