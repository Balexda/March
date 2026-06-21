import type { AgentFailureReason } from "../../observability/agent-output.js";

/**
 * Agent-health circuit-breaker (the codex-down backpressure).
 *
 * When the agent (codex CLI) is hard-down — the canonical case being an expired
 * OAuth token, which makes EVERY spawn fail instantly with "refresh token
 * already used" — the legate must stop tossing fresh spawns into the void. Each
 * doomed spawn escalates a slice and burns the #211 recovery budget for nothing
 * (the smithy-profile-idle incident: 10 slices escalated from one auth lapse).
 *
 * This is the hard-down / multiplicative-collapse half of an AIMD controller
 * (the additive ramp-up is intentionally deferred). It is a small deterministic
 * state machine, fed once per tick with a tally of agent-down vs healthy spawn
 * completions, returning the effective concurrent-spawn cap to use:
 *
 *   CLOSED  — agent healthy; effective cap = configured cap.
 *   OPEN    — agent hard-down; effective cap = 0 (dispatch paused). Recovery
 *             (#211) re-dispatches are NOT capped by the budget, so they still
 *             run and keep probing the agent; a recovery success is itself the
 *             reset signal. Every `probeIntervalTicks` the breaker arms a single
 *             fresh-dispatch PROBE (effective cap = 1) to test the agent.
 *   (probe) — a probe tick is reported as HALF_OPEN in the snapshot. A healthy
 *             completion with no agent-down closes the breaker; another
 *             agent-down keeps it open.
 *
 * Pure and deterministic: no clock, no I/O. The caller drives it with
 * {@link beginTick} (start of tick, returns the cap) and {@link endTick} (end of
 * tick, folds the observation).
 */

export type BreakerState = "closed" | "open" | "half_open";

/** Reasons that mean the agent is unusable (not a per-spawn fluke). */
const HARD_DOWN_REASONS: ReadonlySet<AgentFailureReason> = new Set<AgentFailureReason>(["auth"]);

export function isHardDownReason(reason: AgentFailureReason): boolean {
  return HARD_DOWN_REASONS.has(reason);
}

/**
 * Extract the `[agent_failure_reason=X]` marker the hatchery stamps into a
 * failed dispatch's detail string (see spawn-handoff.ts). Returns null when the
 * detail carries no marker (a non-agent failure: patch apply, steward send, ...).
 */
export function parseAgentFailureReason(detail: string): AgentFailureReason | null {
  const m = /\[agent_failure_reason=([a-z_]+)\]/.exec(detail);
  if (!m) return null;
  const reasons: AgentFailureReason[] = ["auth", "rate_limit", "timeout", "other", "none"];
  return (reasons as string[]).includes(m[1]) ? (m[1] as AgentFailureReason) : null;
}

/** A tick's worth of spawn-completion signal, summed across all profiles. */
export interface BreakerObservation {
  /** Count of drained spawn failures whose reason is hard-down (agent unusable). */
  readonly agentDown: number;
  /** Count of spawns that completed successfully this tick (agent is working). */
  readonly healthy: number;
}

export interface SpawnBreakerConfig {
  /** Consecutive hard-down ticks (with no healthy completion) before tripping OPEN. */
  readonly openAfterTicks: number;
  /** While OPEN, arm a single fresh-dispatch probe every N ticks. */
  readonly probeIntervalTicks: number;
}

export const DEFAULT_BREAKER_CONFIG: SpawnBreakerConfig = {
  openAfterTicks: 2,
  probeIntervalTicks: 3,
};

export interface SpawnBreakerSnapshot {
  readonly state: BreakerState;
  readonly effectiveCap: number;
  readonly configuredCap: number;
  readonly breakerOpen: number;
}

export class SpawnBreaker {
  private state: "closed" | "open" = "closed";
  /** Consecutive hard-down ticks while closed — trips OPEN at openAfterTicks. */
  private downTicks = 0;
  /** Ticks since the last probe was armed while OPEN. */
  private ticksSinceProbe = 0;
  /** Whether this tick is a probe (a single fresh dispatch is allowed). */
  private probeArmed = false;
  private configuredCap = 0;
  private effectiveCap = 0;

  constructor(private readonly config: SpawnBreakerConfig = DEFAULT_BREAKER_CONFIG) {}

  /**
   * Start a tick: decide the effective cap from the current breaker state.
   * CLOSED → full cap. OPEN → 0, except every `probeIntervalTicks` arm a single
   * probe (cap 1). Must be paired with {@link endTick}.
   */
  beginTick(configuredCap: number): number {
    this.configuredCap = configuredCap;
    if (this.state === "closed") {
      this.probeArmed = false;
      this.effectiveCap = configuredCap;
      return this.effectiveCap;
    }
    // OPEN: pause dispatch, periodically arming a single probe. The probe never
    // exceeds the operator's configured cap, so a cap of 0 (dispatch disabled)
    // disables probes too rather than sneaking one fresh spawn through.
    this.ticksSinceProbe += 1;
    if (this.ticksSinceProbe >= this.config.probeIntervalTicks) {
      this.ticksSinceProbe = 0;
      this.probeArmed = true;
      this.effectiveCap = Math.min(1, configuredCap);
    } else {
      this.probeArmed = false;
      this.effectiveCap = 0;
    }
    return this.effectiveCap;
  }

  /** End a tick: fold the observation, transitioning state for the next tick. */
  endTick(obs: BreakerObservation): void {
    const hardDown = obs.agentDown > 0;
    const healthy = obs.healthy > 0;

    if (this.state === "closed") {
      if (healthy) {
        // Any success clears the suspicion, even alongside a stray failure.
        this.downTicks = 0;
      } else if (hardDown) {
        this.downTicks += 1;
        if (this.downTicks >= this.config.openAfterTicks) {
          this.trip();
        }
      }
      // idle tick (no completions) → hold steady.
      return;
    }

    // OPEN: a healthy completion (probe success, or an uncapped #211 recovery
    // success) with no fresh agent-down means the agent is back → close.
    if (healthy && !hardDown) {
      this.close();
    }
    // else stay open; the probe cadence keeps testing.
    this.probeArmed = false;
  }

  private trip(): void {
    this.state = "open";
    this.downTicks = 0;
    // Wait a full interval before the first probe so the agent has time to be fixed.
    this.ticksSinceProbe = 0;
    this.probeArmed = false;
  }

  private close(): void {
    this.state = "closed";
    this.downTicks = 0;
    this.ticksSinceProbe = 0;
    this.probeArmed = false;
  }

  snapshot(): SpawnBreakerSnapshot {
    const reportedState: BreakerState =
      this.state === "open" ? (this.probeArmed ? "half_open" : "open") : "closed";
    return {
      state: reportedState,
      effectiveCap: this.effectiveCap,
      configuredCap: this.configuredCap,
      breakerOpen: this.state === "open" ? 1 : 0,
    };
  }

  /** True while dispatch is paused (OPEN and not a probe tick). */
  isOpen(): boolean {
    return this.state === "open";
  }
}
