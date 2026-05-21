import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  ObservableGauge,
  ObservableResult,
} from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

/**
 * Heartbeat metrics for the Legate loop service. Emitted once per tick via the
 * OTel SDK meter (no raw OTLP), tagged with the deployment `profile` and the
 * `conductor` name so a real deployment's series can be filtered from test/integ
 * runs. Cardinality is deliberately bounded: the only labels are `profile`,
 * `conductor`, the bounded worker `state` (on the workers gauge), and the bounded
 * `action` kind (on the loop-actions counter). Per-slice detail — which steward,
 * how many nudges — belongs in traces/logs, never here.
 *
 * Cumulative activity (heartbeats, dispatch actions/failures, and the loop
 * lifecycle actions by kind: cleanup/ghost_cleanup/relaunch/babysit/steward_nudge/
 * steward_stranded) are counters incremented by each tick's delta; current-state
 * values (up, queue depth, worker counts, tick age) are observable gauges whose
 * callbacks read the latest {@link LoopMetricsSnapshot}. Gauges carry no `unit`:
 * the OTel→Prometheus bridge appends `_ratio` to a `unit: "1"` gauge, which both
 * mislabels a count and broke every gauge panel + the `$profile` dropdown (#205).
 */

/** Current-state values reported by the observable gauges. */
export interface LoopMetricsSnapshot {
  readonly profile: string;
  readonly conductor: string;
  /** 1 while the loop is running; absence in Prometheus => down. */
  readonly up: number;
  /** Epoch ms of the last completed tick; drives `tick.age`. */
  readonly lastTickAtMs: number;
  /** Smithy items ready to dispatch right now. */
  readonly queueDispatchable: number;
  /** Pending items not yet dispatchable (blocked on dependencies). */
  readonly queueBlocked: number;
  /** Total tracked slices. */
  readonly queueTotal: number;
  /** Worker counts keyed by bounded state (running/idle/waiting/error/...). */
  readonly workersByState: Readonly<Record<string, number>>;
}

/** Per-tick deltas folded into the cumulative counters + the duration histogram. */
export interface LoopTickActivity {
  readonly snapshot: LoopMetricsSnapshot;
  readonly tickDurationSeconds: number;
  readonly dispatchActions: number;
  readonly dispatchFailures: number;
  readonly cleanups: number;
  readonly ghostCleanups: number;
  readonly relaunches: number;
  readonly babysitActions: number;
  /** Stranded-steward nudges sent this tick (the watchdog re-prodding a steward). */
  readonly stewardNudges: number;
  /** Stranded-steward escalations raised this tick (operator alert). */
  readonly stewardStranded: number;
}

// OTel instruments must be created once per Meter and reused. Cache them keyed by
// the Meter instance so a fresh initOtel (e.g. between tests) transparently
// rebuilds them — mirrors src/observability/spawn-metrics.ts.
let cachedMeter: Meter | undefined;
let heartbeats: Counter | undefined;
let dispatchActions: Counter | undefined;
let dispatchFailures: Counter | undefined;
let loopActions: Counter | undefined;
let tickDuration: Histogram | undefined;

// The observable gauges read this holder; updated on every recordLoopHeartbeat.
let latest: LoopMetricsSnapshot | undefined;

function base(snapshot: LoopMetricsSnapshot): Attributes {
  return { profile: snapshot.profile, conductor: snapshot.conductor };
}

function ensureInstruments(meter: Meter): void {
  if (meter === cachedMeter) return;
  cachedMeter = meter;

  heartbeats = meter.createCounter("march.legate.loop.heartbeats", {
    description: "Count of completed Legate loop ticks",
    unit: "1",
  });
  dispatchActions = meter.createCounter("march.legate.dispatch.actions", {
    description: "Count of dispatch actions taken by the loop",
    unit: "1",
  });
  dispatchFailures = meter.createCounter("march.legate.dispatch.failures", {
    description: "Count of dispatch failures",
    unit: "1",
  });
  // One counter for every non-dispatch loop action, split by the bounded
  // `action` label (cleanup, ghost_cleanup, relaunch, babysit, steward_nudge,
  // steward_stranded). Keep `action` low-cardinality — it backs the "Loop
  // actions by kind" panel and is a metric label.
  loopActions = meter.createCounter("march.legate.loop.actions", {
    description: "Count of loop lifecycle actions by kind",
    unit: "1",
  });
  tickDuration = meter.createHistogram("march.legate.tick.duration", {
    description: "Legate loop tick wall-clock duration",
    unit: "s",
  });

  // Gauges export count/boolean values, not ratios — so they carry no `unit`.
  // (A `unit: "1"` instrument is exported by the OTel→Prometheus bridge with a
  // `_ratio` suffix, which both mislabels a count and broke every gauge panel +
  // the $profile dropdown on the dashboard — see #205.)
  registerGauge(meter, "march.legate.loop.up", "1 while the loop is alive", (s) => s.up);
  registerGauge(
    meter,
    "march.legate.tick.age",
    "Seconds since the last completed tick",
    (s) => Math.max(0, (Date.now() - s.lastTickAtMs) / 1000),
    "s",
  );
  registerGauge(
    meter,
    "march.legate.queue.dispatchable",
    "Smithy items ready to dispatch now",
    (s) => s.queueDispatchable,
  );
  registerGauge(
    meter,
    "march.legate.queue.blocked",
    "Pending items blocked on dependencies",
    (s) => s.queueBlocked,
  );
  registerGauge(
    meter,
    "march.legate.queue.total",
    "Total tracked slices",
    (s) => s.queueTotal,
  );

  const workers: ObservableGauge = meter.createObservableGauge(
    "march.legate.workers",
    { description: "Worker sessions by state" },
  );
  workers.addCallback((result: ObservableResult) => {
    const s = latest;
    if (!s) return;
    for (const [state, count] of Object.entries(s.workersByState)) {
      result.observe(count, { ...base(s), state });
    }
  });
}

function registerGauge(
  meter: Meter,
  name: string,
  description: string,
  read: (snapshot: LoopMetricsSnapshot) => number,
  unit?: string,
): void {
  const gauge = meter.createObservableGauge(name, unit ? { description, unit } : { description });
  gauge.addCallback((result: ObservableResult) => {
    const s = latest;
    if (!s) return;
    result.observe(read(s), base(s));
  });
}

/**
 * Fold one tick into the loop metrics: refresh the gauge-backing snapshot and
 * add the tick's deltas to the cumulative counters + duration histogram. No-op
 * when telemetry is disabled.
 */
export function recordLoopHeartbeat(activity: LoopTickActivity): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  ensureInstruments(otel.getMeter());
  latest = activity.snapshot;

  const attrs = base(activity.snapshot);
  heartbeats!.add(1, attrs);
  tickDuration!.record(activity.tickDurationSeconds, attrs);
  if (activity.dispatchActions) dispatchActions!.add(activity.dispatchActions, attrs);
  if (activity.dispatchFailures) dispatchFailures!.add(activity.dispatchFailures, attrs);
  if (activity.cleanups) loopActions!.add(activity.cleanups, { ...attrs, action: "cleanup" });
  if (activity.ghostCleanups)
    loopActions!.add(activity.ghostCleanups, { ...attrs, action: "ghost_cleanup" });
  if (activity.relaunches)
    loopActions!.add(activity.relaunches, { ...attrs, action: "relaunch" });
  if (activity.babysitActions)
    loopActions!.add(activity.babysitActions, { ...attrs, action: "babysit" });
  if (activity.stewardNudges)
    loopActions!.add(activity.stewardNudges, { ...attrs, action: "steward_nudge" });
  if (activity.stewardStranded)
    loopActions!.add(activity.stewardStranded, { ...attrs, action: "steward_stranded" });
}
