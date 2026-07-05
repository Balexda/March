import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { REQUEST_LATENCY_BUCKETS_SECONDS } from "./histogram-buckets.js";
import { getActiveOtel } from "./otel.js";

export interface RecordStatioRequestInput {
  /** Matched route pattern, never the concrete request path. */
  readonly route: string;
  readonly method: string;
  readonly statusClass: string;
  readonly operation: string;
  readonly outcome: "success" | "failure";
  readonly durationSeconds: number;
}

const HEARTBEAT_INTERVAL_MS = 15000;

let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;
let heartbeatCounter: Counter | undefined;

interface StatioInstruments {
  requests: Counter;
  duration: Histogram;
  heartbeat: Counter;
}

function statioInstruments(meter: Meter): StatioInstruments {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    requestsCounter = meter.createCounter("march.statio.requests", {
      description: "Count of Statio HTTP requests by route, operation and outcome",
      unit: "1",
    });
    durationHistogram = meter.createHistogram("march.statio.request.duration", {
      description: "Statio HTTP request wall-clock duration",
      unit: "s",
      advice: { explicitBucketBoundaries: REQUEST_LATENCY_BUCKETS_SECONDS },
    });
    heartbeatCounter = meter.createCounter("march.statio.heartbeat", {
      description: "Liveness heartbeat ticks emitted by the Statio service",
      unit: "1",
    });
    meter
      .createObservableGauge("march.statio.uptime", {
        description: "Statio service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));
  }
  return {
    requests: requestsCounter!,
    duration: durationHistogram!,
    heartbeat: heartbeatCounter!,
  };
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function recordStatioRequest(input: RecordStatioRequestInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const { requests, duration } = statioInstruments(otel.getMeter());
  const attributes: Attributes = {
    route: input.route,
    method: input.method,
    status_class: input.statusClass,
    operation: input.operation,
    outcome: input.outcome,
  };
  requests.add(1, attributes);
  duration.record(input.durationSeconds, attributes);
}

export function startStatioHeartbeat(
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const otel = getActiveOtel();
  if (!otel.enabled) return () => {};
  const { heartbeat } = statioInstruments(otel.getMeter());
  heartbeat.add(1);
  const timer = setInterval(() => heartbeat.add(1), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
