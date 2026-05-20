import type { Attributes } from "@opentelemetry/api";
import { getActiveOtel } from "./otel.js";

export type SpawnOutcome = "success" | "failure";

/** A spawn succeeded only if its container exited 0. */
export function outcomeFromExitCode(exitCode: number): SpawnOutcome {
  return exitCode === 0 ? "success" : "failure";
}

export interface RecordSpawnRunInput {
  readonly backend: string;
  readonly taskType: string;
  readonly outcome: SpawnOutcome;
  readonly durationSeconds: number;
}

/**
 * Record one spawn dispatch as a counter increment + duration sample, tagged by
 * backend, task type, and outcome. These answer "success rate" and "runtime"
 * queries in Grafana (march_spawn_runs_total / march_spawn_duration_seconds).
 * No-op when telemetry is disabled. spawn_id is deliberately NOT a metric label
 * to keep cardinality bounded — per-spawn detail lives in traces.
 */
export function recordSpawnRun(input: RecordSpawnRunInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const meter = otel.getMeter();
  const attributes: Attributes = {
    backend: input.backend,
    task_type: input.taskType,
    outcome: input.outcome,
  };
  meter
    .createCounter("march.spawn.runs", {
      description: "Count of spawn dispatches by outcome",
      unit: "1",
    })
    .add(1, attributes);
  meter
    .createHistogram("march.spawn.duration", {
      description: "Spawn dispatch wall-clock duration",
      unit: "s",
    })
    .record(input.durationSeconds, attributes);
}
