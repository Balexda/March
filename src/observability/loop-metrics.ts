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
 * `conductor`, the bounded worker `state` (on the workers gauge), the bounded
 * lifecycle `stage` (on the slices gauge, #220), and the bounded `action` kind
 * (on the loop-actions counter). Per-slice detail — which steward,
 * how many nudges — belongs in traces/logs, never here.
 *
 * Cumulative activity (heartbeats, dispatch actions/failures, and the loop
 * lifecycle actions by kind: cleanup/ghost_cleanup/relaunch/babysit/steward_nudge/
 * steward_stranded plus their cleanup_failed/ghost_cleanup_failed/relaunch_failed
 * failure twins — a loop failing every tick is invisible on the success-only
 * counters) are counters incremented by each tick's delta; current-state
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
  /** Smithy items ready to dispatch right now (node-level frontier, #289 — can
   *  over-count escalated/blocked-shadow nodes). */
  readonly queueDispatchable: number;
  /** The TRUE dispatch-ready count: the record-paced set the dispatcher actually
   *  launches (dispatchableReady), phantom-free. The dispatch alarms key on this. */
  readonly queueDispatchableReady: number;
  /** Pending items not yet dispatchable (blocked on dependencies). */
  readonly queueBlocked: number;
  /** Total tracked slices. */
  readonly queueTotal: number;
  /** Worker counts keyed by bounded state (running/idle/waiting/error/...). */
  readonly workersByState: Readonly<Record<string, number>>;
  /** Non-archived slice counts keyed by bounded lifecycle stage (#220). */
  readonly slicesByStage: Readonly<Record<string, number>>;
  /** All-clear slices the loop WILL squash-merge now (merge_gate=ready). Transient. */
  readonly readyToMerge: number;
  /** All-clear slices blocked on a human review gate (merge_gate=waiting-approval).
   *  Human-paced — a metric, never alarmed. */
  readonly waitingOnApproval: number;
  /** All-clear, human-gates-cleared slices GitHub won't merge yet
   *  (merge_gate=blocked-merge-state). A real stall. */
  readonly blockedOnMergeState: number;
  /** Escalated-stage slices keyed by bounded escalation reason; sums to
   *  slicesByStage.escalated. Splits spawn-failed from steward-stuck on the board. */
  readonly escalatedByReason: Readonly<Record<string, number>>;
}

/** Per-tick deltas folded into the cumulative counters + the duration histogram. */
export interface LoopTickActivity {
  readonly snapshot: LoopMetricsSnapshot;
  readonly tickDurationSeconds: number;
  readonly dispatchActions: number;
  readonly dispatchFailures: number;
  readonly cleanups: number;
  /** Cleanup teardowns that did not confirm this tick (`cleanup_failure`). */
  readonly cleanupFailures: number;
  readonly ghostCleanups: number;
  /** Ghost-cleanup attempts Brood would not confirm (`ghost-cleanup-failed`). */
  readonly ghostCleanupFailures: number;
  readonly relaunches: number;
  /** Steward relaunch attempts that failed (`relaunch-failed`). */
  readonly relaunchFailures: number;
  readonly babysitActions: number;
  /** Stranded-steward nudges sent this tick (the watchdog re-prodding a steward). */
  readonly stewardNudges: number;
  /** Stranded-steward escalations raised this tick (operator alert). */
  readonly stewardStranded: number;
}

/**
 * The GLOBAL concurrent-spawn cap and its current draw (#313), shared across all
 * profiles in a single multi-profile tick. Emitted as profile-less gauges so the
 * "live ≫ cap while dispatch is starved" wedge — the ghost stewards pinning the
 * cap — is one panel/alert, not a per-profile sum that would multiply the shared
 * values by the profile count.
 */
export interface SpawnBudgetMetrics {
  /** Configured global cap (MARCH_MAX_CONCURRENT_SPAWNS). */
  readonly cap: number;
  /** Live spawns across ALL profiles at tick start — the cap's current draw. */
  readonly live: number;
  /** Dispatchable items deferred this tick because the cap was reached. */
  readonly deferred: number;
}

/**
 * Per-tick dwell sample (time-in-state). Plain data so observability stays a leaf
 * layer — `stampDwell` (legate/loop/pure/dwell.ts) returns a structurally
 * compatible object the runtime passes straight through.
 */
export interface DwellSample {
  /** Max age (s) of any slice currently in each lifecycle stage. */
  readonly stageAgeMaxSeconds: Record<string, number>;
  /** Max age (s) of any pr-open slice currently in each merge-gate. */
  readonly mergeGateAgeMaxSeconds: Record<string, number>;
  /** Completed stage dwells (s) this tick → the dwell histogram (not alarmed). */
  readonly completedStageDwells: ReadonlyArray<{ stage: string; seconds: number }>;
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

// The observable gauges read this map — one snapshot PER PROFILE, updated on
// every recordLoopHeartbeat. The single shared legate ticks each profile in turn
// and recordLoopHeartbeat fires once per profile; keying by profile (not a single
// `latest`) is what keeps a gauge for an earlier profile from being clobbered by
// a later profile's tick — load-bearing for the cross-profile alert signals
// (e.g. queue.dispatchable_ready summed across profiles).
const latestByProfile = new Map<string, LoopMetricsSnapshot>();

// The GLOBAL concurrent-spawn budget (#313) is one shared instance across every
// profile this tick, so it is NOT per-profile: recorded once per multi-profile
// tick with no `profile` label. Its gauges read this holder.
let latestSpawnBudget: SpawnBudgetMetrics | undefined;

// The dwell max-age gauges read this map (one sample PER PROFILE) so a stuck
// slice in any profile surfaces, not just the last profile to tick. Module-level;
// the observable callbacks iterate it.
const latestDwellByProfile = new Map<string, DwellSample>();
let stageDwellHistogram: Histogram | undefined;

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
  // steward_stranded, and the cleanup_failed/ghost_cleanup_failed/relaunch_failed
  // failure twins). Keep `action` low-cardinality — it backs the "Loop actions by
  // kind" / "Loop failures" panels and is a metric label.
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
    "Smithy items ready to dispatch now (node-level frontier, may over-count)",
    (s) => s.queueDispatchable,
  );
  registerGauge(
    meter,
    "march.legate.queue.dispatchable_ready",
    "True dispatch-ready count the dispatcher would launch (phantom-free)",
    (s) => s.queueDispatchableReady,
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
    for (const s of latestByProfile.values()) {
      for (const [state, count] of Object.entries(s.workersByState)) {
        result.observe(count, { ...base(s), state });
      }
    }
  });

  // Non-archived slices by lifecycle stage (#220) — the work-by-stage view that
  // workers{state} (Castra session status) cannot express. `stage` is a metric
  // label: keep it the fixed lifecycle vocabulary (hatchery-pending/implementing/
  // pr-open/pr-in-fix/pr-resolving-conflicts/escalated). No unit ⇒ exported as
  // `march_legate_slices{stage}` with no suffix.
  const slices: ObservableGauge = meter.createObservableGauge(
    "march.legate.slices",
    { description: "Non-archived slices by lifecycle stage" },
  );
  slices.addCallback((result: ObservableResult) => {
    for (const s of latestByProfile.values()) {
      for (const [stage, count] of Object.entries(s.slicesByStage)) {
        result.observe(count, { ...base(s), stage });
      }
    }
  });
  // Derived "waiting for merge": pr-open slices that are clean + mergeable with no
  // threads owed. Exported as `march_legate_slices_ready_to_merge` (no suffix).
  // Merge-readiness 3-way (human-consumable), from babysit's live-PR verdict:
  //   ready_to_merge       — loop will squash-merge now (transient).
  //   waiting_on_approval  — blocked on a human review gate (NOT alarmed).
  //   blocked_on_merge_state — human gates clear, GitHub won't merge yet (a stall).
  // Exported as march_legate_slices_{ready_to_merge,waiting_on_approval,
  // blocked_on_merge_state} (no suffix).
  registerGauge(
    meter,
    "march.legate.slices.ready_to_merge",
    "Slices the loop will squash-merge now (all gates clear)",
    (s) => s.readyToMerge,
  );
  registerGauge(
    meter,
    "march.legate.slices.waiting_on_approval",
    "Mergeable slices blocked on a human review gate (approval / changes-requested)",
    (s) => s.waitingOnApproval,
  );
  registerGauge(
    meter,
    "march.legate.slices.blocked_on_merge_state",
    "Human-gates-cleared slices GitHub won't merge yet (UNKNOWN/BEHIND/BLOCKED/DIRTY)",
    (s) => s.blockedOnMergeState,
  );

  // Escalated slices split by reason (sums to slices{stage="escalated"}). `reason`
  // is a bounded label (the ESCALATION_REASONS vocabulary). Lets the work-status
  // board separate "spawn failed — never reached steward" (hatchery_dispatch_failed)
  // from "steward stuck — needs the agent/operator" (everything else). Exported as
  // `march_legate_escalated{reason}`.
  const escalated: ObservableGauge = meter.createObservableGauge(
    "march.legate.escalated",
    { description: "Escalated slices by escalation reason" },
  );
  escalated.addCallback((result: ObservableResult) => {
    for (const s of latestByProfile.values()) {
      for (const [reason, count] of Object.entries(s.escalatedByReason)) {
        result.observe(count, { ...base(s), reason });
      }
    }
  });

  // GLOBAL spawn-budget gauges (#313) — profile-less (one shared cap across all
  // profiles per tick), read from `latestSpawnBudget`. `spawn.live ≫ spawn.cap`
  // with dispatch starved is the ghost-stewards-pin-the-cap wedge. No unit ⇒
  // exported as march_legate_spawn_{live,cap,deferred} with no suffix.
  registerSpawnGauge(meter, "march.legate.spawn.live", "Live spawns billed against the global cap", (b) => b.live);
  registerSpawnGauge(meter, "march.legate.spawn.cap", "Global concurrent-spawn cap", (b) => b.cap);
  registerSpawnGauge(
    meter,
    "march.legate.spawn.deferred",
    "Dispatchable items deferred this tick because the cap was reached",
    (b) => b.deferred,
  );

  // Dwell (time-in-state) — max age of the oldest slice in each stage / merge-gate,
  // per profile. Drives the dwell alarms (spawn/steward too long; ready/blocked
  // not draining). Labels: profile + the bounded stage/gate vocab. No unit ⇒
  // exported as march_legate_slice_stage_age_max_seconds? No — seconds unit set so
  // the bridge appends _seconds. (Gauge value IS seconds, so the unit is correct.)
  const stageAge: ObservableGauge = meter.createObservableGauge("march.legate.slice.stage_age_max", {
    description: "Max age of the oldest slice currently in each lifecycle stage",
    unit: "s",
  });
  stageAge.addCallback((result: ObservableResult) => {
    for (const [profile, sample] of latestDwellByProfile) {
      for (const [stage, seconds] of Object.entries(sample.stageAgeMaxSeconds)) {
        result.observe(seconds, { profile, stage });
      }
    }
  });
  const gateAge: ObservableGauge = meter.createObservableGauge("march.legate.merge_gate_age_max", {
    description: "Max age of the oldest pr-open slice currently in each merge-gate",
    unit: "s",
  });
  gateAge.addCallback((result: ObservableResult) => {
    for (const [profile, sample] of latestDwellByProfile) {
      for (const [gate, seconds] of Object.entries(sample.mergeGateAgeMaxSeconds)) {
        result.observe(seconds, { profile, gate });
      }
    }
  });

  // Completed stage dwells (s) — for p50/p95 analysis, NOT alarmed.
  stageDwellHistogram = meter.createHistogram("march.legate.stage.dwell", {
    description: "Completed time-in-stage durations",
    unit: "s",
  });
}

/** Register a profile-less observable gauge reading the latest spawn budget. */
function registerSpawnGauge(
  meter: Meter,
  name: string,
  description: string,
  read: (b: SpawnBudgetMetrics) => number,
): void {
  const gauge = meter.createObservableGauge(name, { description });
  gauge.addCallback((result: ObservableResult) => {
    const b = latestSpawnBudget;
    if (!b) return;
    result.observe(read(b));
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
    for (const s of latestByProfile.values()) {
      result.observe(read(s), base(s));
    }
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
  latestByProfile.set(activity.snapshot.profile || "unknown", activity.snapshot);

  const attrs = base(activity.snapshot);
  heartbeats!.add(1, attrs);
  tickDuration!.record(activity.tickDurationSeconds, attrs);
  if (activity.dispatchActions) dispatchActions!.add(activity.dispatchActions, attrs);
  if (activity.dispatchFailures) dispatchFailures!.add(activity.dispatchFailures, attrs);
  if (activity.cleanups) loopActions!.add(activity.cleanups, { ...attrs, action: "cleanup" });
  if (activity.cleanupFailures)
    loopActions!.add(activity.cleanupFailures, { ...attrs, action: "cleanup_failed" });
  if (activity.ghostCleanups)
    loopActions!.add(activity.ghostCleanups, { ...attrs, action: "ghost_cleanup" });
  if (activity.ghostCleanupFailures)
    loopActions!.add(activity.ghostCleanupFailures, { ...attrs, action: "ghost_cleanup_failed" });
  if (activity.relaunches)
    loopActions!.add(activity.relaunches, { ...attrs, action: "relaunch" });
  if (activity.relaunchFailures)
    loopActions!.add(activity.relaunchFailures, { ...attrs, action: "relaunch_failed" });
  if (activity.babysitActions)
    loopActions!.add(activity.babysitActions, { ...attrs, action: "babysit" });
  if (activity.stewardNudges)
    loopActions!.add(activity.stewardNudges, { ...attrs, action: "steward_nudge" });
  if (activity.stewardStranded)
    loopActions!.add(activity.stewardStranded, { ...attrs, action: "steward_stranded" });
}

/**
 * Refresh the GLOBAL spawn-budget gauges (#313) from the per-tick shared budget.
 * Called once per multi-profile tick (not per profile) since the cap and its draw
 * are global. No-op when telemetry is disabled.
 */
export function recordSpawnBudget(budget: SpawnBudgetMetrics): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  ensureInstruments(otel.getMeter());
  latestSpawnBudget = budget;
}

/**
 * Refresh a profile's dwell (time-in-state) gauges and record its completed
 * stage dwells into the histogram. Per profile (the gauges aggregate across the
 * shared multi-profile legate). No-op when telemetry is disabled.
 */
export function recordDwell(profile: string, sample: DwellSample): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  ensureInstruments(otel.getMeter());
  latestDwellByProfile.set(profile || "unknown", sample);
  for (const d of sample.completedStageDwells) {
    stageDwellHistogram!.record(d.seconds, { stage: d.stage });
  }
}
