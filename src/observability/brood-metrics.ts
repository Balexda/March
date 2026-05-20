import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { type RequestOutcome, outcomeFromStatus } from "./hatchery-metrics.js";

export { type RequestOutcome, outcomeFromStatus };

export interface RecordBroodRequestInput {
  /** Route TEMPLATE (e.g. "/sessions/:id"), never the concrete path. */
  readonly route: string;
  readonly method: string;
  readonly outcome: RequestOutcome;
  readonly durationSeconds: number;
}

export interface RecordBroodTeardownInput {
  /** Session kind torn down. */
  readonly kind: string;
  readonly outcome: "success" | "partial" | "error";
  readonly profile: string;
  readonly durationSeconds: number;
}

const HEARTBEAT_INTERVAL_MS = 15000;

// One instrument per Meter, rebuilt transparently when initOtel swaps the
// provider (e.g. between tests) — mirrors hatchery-metrics / spawn-metrics.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let requestDuration: Histogram | undefined;
let teardownsCounter: Counter | undefined;
let teardownDuration: Histogram | undefined;
let heartbeatCounter: Counter | undefined;

interface BroodInstruments {
  requests: Counter;
  requestDuration: Histogram;
  teardowns: Counter;
  teardownDuration: Histogram;
  heartbeat: Counter;
}

function broodInstruments(meter: Meter): BroodInstruments {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    requestsCounter = meter.createCounter("march.brood.requests", {
      description: "Count of brood HTTP requests by route, method and outcome",
      unit: "1",
    });
    requestDuration = meter.createHistogram("march.brood.request.duration", {
      description: "Brood HTTP request wall-clock duration",
      unit: "s",
    });
    teardownsCounter = meter.createCounter("march.brood.teardowns", {
      description: "Count of brood teardowns by kind, outcome and profile",
      unit: "1",
    });
    teardownDuration = meter.createHistogram("march.brood.teardown.duration", {
      description: "Brood teardown wall-clock duration",
      unit: "s",
    });
    heartbeatCounter = meter.createCounter("march.brood.heartbeat", {
      description: "Liveness heartbeat ticks emitted by the brood service",
      unit: "1",
    });
    meter
      .createObservableGauge("march.brood.uptime", {
        description: "Brood service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));
  }
  return {
    requests: requestsCounter!,
    requestDuration: requestDuration!,
    teardowns: teardownsCounter!,
    teardownDuration: teardownDuration!,
    heartbeat: heartbeatCounter!,
  };
}

/** Record one HTTP request: count + duration by route/method/outcome. No-op when disabled. */
export function recordBroodRequest(input: RecordBroodRequestInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const instruments = broodInstruments(otel.getMeter());
  const attributes: Attributes = {
    route: input.route,
    method: input.method,
    outcome: input.outcome,
  };
  instruments.requests.add(1, attributes);
  instruments.requestDuration.record(input.durationSeconds, attributes);
}

/** Record one teardown: count + duration by kind/outcome/profile. No-op when disabled. */
export function recordBroodTeardown(input: RecordBroodTeardownInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const instruments = broodInstruments(otel.getMeter());
  const attributes: Attributes = {
    kind: input.kind,
    outcome: input.outcome,
    profile: input.profile,
  };
  instruments.teardowns.add(1, attributes);
  instruments.teardownDuration.record(input.durationSeconds, attributes);
}

/**
 * Start the periodic liveness heartbeat (and register the uptime gauge).
 * Returns a stop function. No-op when telemetry is disabled. The interval is
 * unref'd so it never keeps the process alive.
 */
export function startBroodHeartbeat(
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};
  const { heartbeat } = broodInstruments(otel.getMeter());
  heartbeat.add(1);
  const timer = setInterval(() => heartbeat.add(1), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
