import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import type { AgentFailureReason, AgentTokenUsage } from "./agent-output.js";
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
  | "handoff_eligibility"
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
let agentFailuresCounter: Counter | undefined;
let tokensInputCounter: Counter | undefined;
let tokensCachedInputCounter: Counter | undefined;
let tokensOutputCounter: Counter | undefined;
let tokensReasoningCounter: Counter | undefined;

interface SpawnInstruments {
  counter: Counter;
  histogram: Histogram;
  agentFailures: Counter;
  tokensInput: Counter;
  tokensCachedInput: Counter;
  tokensOutput: Counter;
  tokensReasoning: Counter;
}

function spawnInstruments(meter: Meter): SpawnInstruments {
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
    // The agent (codex CLI) failure signal, keyed by a bounded reason. The
    // `auth` reason is the "agent is down — go re-authenticate" alarm that the
    // smithy-profile-idle incident showed was previously invisible (it lumped
    // into `march_spawn_runs{failure_stage="container_run"}`).
    agentFailuresCounter = meter.createCounter("march.spawn.agent_failures", {
      description: "Count of spawn agent-level failures by reason (auth/rate_limit/timeout/other)",
      unit: "1",
    });
    tokensInputCounter = meter.createCounter("march.spawn.tokens.input", {
      description: "Agent input tokens consumed by completed spawns",
      unit: "1",
    });
    tokensCachedInputCounter = meter.createCounter("march.spawn.tokens.cached_input", {
      description: "Agent cached input tokens served to completed spawns",
      unit: "1",
    });
    tokensOutputCounter = meter.createCounter("march.spawn.tokens.output", {
      description: "Agent output tokens produced by completed spawns",
      unit: "1",
    });
    tokensReasoningCounter = meter.createCounter("march.spawn.tokens.reasoning", {
      description: "Agent reasoning output tokens produced by completed spawns",
      unit: "1",
    });
  }
  return {
    counter: runsCounter!,
    histogram: durationHistogram!,
    agentFailures: agentFailuresCounter!,
    tokensInput: tokensInputCounter!,
    tokensCachedInput: tokensCachedInputCounter!,
    tokensOutput: tokensOutputCounter!,
    tokensReasoning: tokensReasoningCounter!,
  };
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

/**
 * Record one agent-level spawn failure, tagged by backend, profile, and a
 * bounded {@link AgentFailureReason}. `reason: "none"` is skipped (there was no
 * agent-level failure to record). `march_spawn_agent_failures_total{reason="auth"}`
 * is the codex-down alarm. No-op when telemetry is disabled.
 */
export function recordAgentFailure(input: {
  readonly backend: string;
  readonly profile: string;
  readonly reason: AgentFailureReason;
}): void {
  if (input.reason === "none") return;
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const { agentFailures } = spawnInstruments(otel.getMeter());
  agentFailures.add(1, { backend: input.backend, profile: input.profile, reason: input.reason });
}

/**
 * Record the token usage of a completed spawn, tagged by backend, profile, and
 * task type. Feeds the Agent status dashboard's token panels. No-op when
 * telemetry is disabled.
 */
export function recordSpawnTokens(input: {
  readonly backend: string;
  readonly profile: string;
  readonly taskType: string;
  readonly usage: AgentTokenUsage;
}): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;
  const inst = spawnInstruments(otel.getMeter());
  const attrs: Attributes = {
    backend: input.backend,
    profile: input.profile,
    task_type: input.taskType,
  };
  inst.tokensInput.add(input.usage.inputTokens, attrs);
  inst.tokensCachedInput.add(input.usage.cachedInputTokens, attrs);
  inst.tokensOutput.add(input.usage.outputTokens, attrs);
  inst.tokensReasoning.add(input.usage.reasoningOutputTokens, attrs);
}
