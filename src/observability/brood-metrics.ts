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

/**
 * One profile's live-Castra-vs-Brood-tracked reconciliation counts, fed to the
 * gauges below. Mirrors `ReconciliationObservation` in
 * `brood/service/steward-removal.ts` as plain data so observability does not
 * depend on the service layer (the service maps its observation to this shape).
 */
export interface BroodReconciliationSample {
  readonly profile: string;
  readonly castraLive: number;
  readonly trackedActive: number;
  /** Live Castra sessions with NO active Brood record — the leak. `orphans > 0`
   *  is the divergence that renders a stalled loop green. */
  readonly orphans: number;
}

// The reconciliation observable gauges read this holder; updated each periodic
// reconciliation tick. `undefined` until the first observation completes.
let latestReconciliation: readonly BroodReconciliationSample[] | undefined;

/**
 * One outcome of the auto-reconciler reap loop, fed to the `march.brood.reaps`
 * counter. Low-cardinality by construction: `outcome` is a 4-value enum and
 * `reason` is drawn from the bounded verdict/skip reasons (`pr-merged`,
 * `dead-orphan`, `open-pr`, `tracked`, …). Plain data so observability does not
 * depend on the service layer.
 */
export interface BroodReapOutcome {
  readonly outcome: "reaped" | "adopted" | "skipped" | "failed";
  readonly reason: string;
}

// One instrument per Meter, rebuilt transparently when initOtel swaps the
// provider (e.g. between tests) — mirrors hatchery-metrics / spawn-metrics.
let cachedMeter: Meter | undefined;
let requestsCounter: Counter | undefined;
let requestDuration: Histogram | undefined;
let teardownsCounter: Counter | undefined;
let teardownDuration: Histogram | undefined;
let heartbeatCounter: Counter | undefined;
let reapsCounter: Counter | undefined;

interface BroodInstruments {
  requests: Counter;
  requestDuration: Histogram;
  teardowns: Counter;
  teardownDuration: Histogram;
  heartbeat: Counter;
  reaps: Counter;
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
    reapsCounter = meter.createCounter("march.brood.reaps", {
      description:
        "Auto-reconciler outcomes by outcome (reaped/adopted/skipped/failed) and reason",
      unit: "1",
    });
    meter
      .createObservableGauge("march.brood.uptime", {
        description: "Brood service process uptime",
        unit: "s",
      })
      .addCallback((result) => result.observe(process.uptime()));

    // Reconciliation gauges (per profile) — live Castra sessions vs the live
    // sessions Brood actually tracks, and the orphan delta. `orphans > 0` is the
    // wedge a stalled loop hides behind. Low-cardinality: only the `profile`
    // label. No unit ⇒ exported as march_brood_sessions_{castra_live,
    // tracked_active,orphans}{profile}.
    registerReconciliationGauge(
      meter,
      "march.brood.sessions.castra_live",
      "Live Castra sessions per profile",
      (s) => s.castraLive,
    );
    registerReconciliationGauge(
      meter,
      "march.brood.sessions.tracked_active",
      "Live Castra sessions an active Brood record owns",
      (s) => s.trackedActive,
    );
    registerReconciliationGauge(
      meter,
      "march.brood.sessions.orphans",
      "Live Castra sessions with no active Brood record (the leak)",
      (s) => s.orphans,
    );
  }
  return {
    requests: requestsCounter!,
    requestDuration: requestDuration!,
    teardowns: teardownsCounter!,
    teardownDuration: teardownDuration!,
    heartbeat: heartbeatCounter!,
    reaps: reapsCounter!,
  };
}

/** Register a per-profile reconciliation observable gauge reading `latestReconciliation`. */
function registerReconciliationGauge(
  meter: Meter,
  name: string,
  description: string,
  read: (sample: BroodReconciliationSample) => number,
): void {
  meter
    .createObservableGauge(name, { description })
    .addCallback((result) => {
      const samples = latestReconciliation;
      if (!samples) return;
      for (const sample of samples) {
        result.observe(read(sample), { profile: sample.profile });
      }
    });
}

/**
 * Refresh the reconciliation gauges from the latest observation. Called each
 * periodic reconciliation tick by the brood service. No-op when telemetry is
 * disabled. Ensures the instruments exist so a first call after init registers
 * the gauges before the next scrape.
 */
export function recordBroodReconciliation(
  samples: readonly BroodReconciliationSample[],
): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  broodInstruments(otel.getMeter());
  latestReconciliation = samples;
}

/**
 * Record the outcomes of one auto-reconciler reap loop tick: increments
 * `march.brood.reaps{outcome,reason}` once per outcome. No-op when telemetry is
 * disabled. The reconciler flattens its `SweepResult` (reaped/adopted/skipped/
 * failures) into these outcomes so a single, drillable counter shows the
 * reconciled delta — `outcome="reaped",reason="dead-orphan"` vs
 * `outcome="adopted",reason="open-pr"`.
 */
export function recordBroodReaps(outcomes: readonly BroodReapOutcome[]): void {
  if (outcomes.length === 0) return;
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const { reaps } = broodInstruments(otel.getMeter());
  for (const o of outcomes) {
    reaps.add(1, { outcome: o.outcome, reason: o.reason });
  }
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
