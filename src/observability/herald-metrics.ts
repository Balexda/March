import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";
import { type RequestOutcome, outcomeFromStatus } from "./hatchery-metrics.js";
import { REQUEST_LATENCY_BUCKETS_SECONDS } from "./histogram-buckets.js";

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

/**
 * The classification label for a steward self-report (#371) — the cheap-vs-
 * expensive split the heuristic-health monitor watches. `classified:true`
 * reports carry their detected status (`awaiting_input`/`reported`/`working`);
 * `classified:false` reports are the ones the hook's heuristic could NOT pin
 * down and that fall through to the (relatively expensive) legate-agent (P2).
 * A rising `unclassified` share is the signal that the heuristics need updating.
 * Bounded to ≤5 values, so it stays a safe metric label.
 */
export function stewardReportClassification(
  classified: boolean,
  status?: string,
): string {
  if (!classified) return "unclassified";
  return status && status.length > 0 ? status : "classified";
}

const HEARTBEAT_INTERVAL_MS = 15000;

// One instrument per Meter, rebuilt transparently when initOtel swaps the
// provider (e.g. between tests) — mirrors brood/hatchery metrics.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let requestDuration: Histogram | undefined;
let observeDuration: Histogram | undefined;
let eventsCounter: Counter | undefined;
let stewardReportsCounter: Counter | undefined;
let adminEventsCounter: Counter | undefined;
let observeErrors: Counter | undefined;
let syncCounter: Counter | undefined;
let heartbeatCounter: Counter | undefined;

interface HeraldInstruments {
  requests: Counter;
  requestDuration: Histogram;
  observeDuration: Histogram;
  events: Counter;
  stewardReports: Counter;
  adminEvents: Counter;
  observeErrors: Counter;
  sync: Counter;
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
      advice: { explicitBucketBoundaries: REQUEST_LATENCY_BUCKETS_SECONDS },
    });
    observeDuration = meter.createHistogram("march.herald.observe.duration", {
      description: "Herald observe-tick wall-clock duration",
      unit: "s",
      advice: { explicitBucketBoundaries: REQUEST_LATENCY_BUCKETS_SECONDS },
    });
    eventsCounter = meter.createCounter("march.herald.events", {
      description: "Count of change events Herald appended, by type",
      unit: "1",
    });
    stewardReportsCounter = meter.createCounter("march.herald.steward_reports", {
      description:
        "Count of steward self-reports recorded, by classification and profile (#371)",
      unit: "1",
    });
    adminEventsCounter = meter.createCounter("march.herald.admin.events", {
      description: "Count of operator-authored break-glass admin events appended, by event_type",
      unit: "1",
    });
    observeErrors = meter.createCounter("march.herald.observe.errors", {
      description: "Count of failed Herald observe ticks",
      unit: "1",
    });
    syncCounter = meter.createCounter("march.herald.sync", {
      description: "Count of Herald default-branch git syncs by outcome (ok|error)",
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
    stewardReports: stewardReportsCounter!,
    adminEvents: adminEventsCounter!,
    observeErrors: observeErrors!,
    sync: syncCounter!,
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

/**
 * Record one steward self-report (#371): increments
 * `march.herald.steward_reports` labelled by `classification` (the cheap-vs-
 * legate-agent split — see {@link stewardReportClassification}) and `profile`
 * (both low-cardinality). This is the queryable signal for steward-report
 * volume and, via the unclassified share, heuristic health. No-op when
 * telemetry is disabled.
 */
export function recordStewardReport(input: {
  readonly profile: string;
  readonly classification: string;
}): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  heraldInstruments(otel.getMeter()).stewardReports.add(1, {
    profile: input.profile,
    classification: input.classification,
  });
}

/**
 * Record one operator-authored break-glass admin append (#265): increments
 * `march.herald.admin.events` labelled by the appended event's `type` (kept
 * low-cardinality — it is a metric label). No-op when telemetry is disabled.
 */
export function recordHeraldAdminEvent(eventType: string): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  heraldInstruments(otel.getMeter()).adminEvents.add(1, { event_type: eventType });
}

/** Record one failed observe tick. No-op when disabled. */
export function recordHeraldObserveError(): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  heraldInstruments(otel.getMeter()).observeErrors.add(1);
}

/**
 * Record one Herald default-branch git sync, labelled by `outcome` (`ok` |
 * `error`, low-cardinality). This is the durable, queryable signal that a sync
 * happened — and, critically, the LOUD failure signal so a broken sync can't
 * regress silently the way #299/#300 originally hid (`march.herald.sync{outcome="error"}`
 * climbing while the default branch stays behind). No-op when telemetry is disabled.
 */
export function recordHeraldSync(outcome: "ok" | "error"): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  heraldInstruments(otel.getMeter()).sync.add(1, { outcome });
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
