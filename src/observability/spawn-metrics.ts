import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

export type SpawnOutcome = "success" | "failure";

/**
 * Lifecycle stage a spawn failed at — a LOW-CARDINALITY metric label and span
 * attribute. A spawn's container can exit 0 yet the dispatch still fail in a
 * later step (patch extraction, `git apply`, the steward send-off): keying
 * outcome off the container exit code alone mislabels those as success
 * (issue #211). Tracking the stage makes "where do spawns break" answerable in
 * Grafana/Tempo. `"none"` is recorded on success. Keep this enum bounded — it
 * is a metric label, so it must never carry ids or free text.
 */
export type SpawnFailureStage =
  | "manager_launch"
  | "record_init"
  | "image_build"
  | "container_run"
  | "patch_extract"
  | "patch_apply"
  | "steward_send"
  | "rollback";

/**
 * Maps a container exit code to an outcome. NOTE: this reflects only whether
 * the CONTAINER exited cleanly — it is NOT the dispatch outcome, because the
 * handoff has post-container steps (patch extraction, `git apply`, steward
 * send) that can fail after a 0 exit. Use the real handoff result for
 * {@link recordSpawnRun}; this helper remains for callers that genuinely want
 * the container-exit classification.
 */
export function outcomeFromExitCode(exitCode: number): SpawnOutcome {
  return exitCode === 0 ? "success" : "failure";
}

export interface RecordSpawnRunInput {
  readonly backend: string;
  readonly taskType: string;
  /**
   * The deployment profile this spawn belongs to (the Legate deployment's
   * profile, set at `march legate init`). Lets test/integ telemetry be filtered
   * out so it never pollutes a real deployment's metrics. `"unknown"` for
   * ad-hoc spawns with no deployment profile.
   */
  readonly profile: string;
  readonly outcome: SpawnOutcome;
  /**
   * Which lifecycle stage failed, for `outcome: "failure"`. Omitted (recorded
   * as `"none"`) on success. Bounded enum — safe as a metric label.
   */
  readonly failureStage?: SpawnFailureStage;
  readonly durationSeconds: number;
}

/**
 * Record one spawn dispatch as a counter increment + duration sample, tagged by
 * backend, task type, profile, and outcome. These answer "success rate" and
 * "runtime" queries in Grafana (march_spawn_runs_total /
 * march_spawn_duration_seconds), and the profile label keeps test/integ runs
 * filterable out of a real deployment's metrics. No-op when telemetry is
 * disabled. spawn_id is deliberately NOT a metric label to keep cardinality
 * bounded — per-spawn detail lives in traces.
 */
// OTel expects each instrument to be created once and reused. Cache them keyed
// by the Meter instance so a fresh initOtel (e.g. between tests) transparently
// rebuilds them against the new provider rather than reusing stale handles.
let cachedMeter: Meter | undefined;
let runsCounter: Counter | undefined;
let durationHistogram: Histogram | undefined;

function spawnInstruments(meter: Meter): {
  counter: Counter;
  histogram: Histogram;
} {
  if (meter !== cachedMeter) {
    cachedMeter = meter;
    runsCounter = meter.createCounter("march.spawn.runs", {
      description: "Count of spawn dispatches by outcome",
      unit: "1",
    });
    durationHistogram = meter.createHistogram("march.spawn.duration", {
      description: "Spawn dispatch wall-clock duration",
      unit: "s",
    });
  }
  return { counter: runsCounter!, histogram: durationHistogram! };
}

export function recordSpawnRun(input: RecordSpawnRunInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const { counter, histogram } = spawnInstruments(otel.getMeter());
  const attributes: Attributes = {
    backend: input.backend,
    task_type: input.taskType,
    profile: input.profile,
    outcome: input.outcome,
    failure_stage: input.failureStage ?? "none",
  };
  counter.add(1, attributes);
  histogram.record(input.durationSeconds, attributes);
}
