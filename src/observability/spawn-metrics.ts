import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

export type SpawnOutcome = "success" | "failure";

/** A spawn succeeded only if its container exited 0. */
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
  };
  counter.add(1, attributes);
  histogram.record(input.durationSeconds, attributes);
}
