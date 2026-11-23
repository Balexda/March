import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Castra send health and readiness (`GET /readyz`).
 *
 * `/healthz` only proves the process answers. It said "ok" through the
 * 2026-11-22 incident, when two stuck stewards made Castra refuse sends and
 * freeze its event loop for 15s at a time. Readiness reports what liveness
 * cannot: sessions Castra is refusing to send to, recent send failures, and
 * event-loop lag.
 */

/** How long a composer refusal fast-fails further sends to that session. */
export const REFUSAL_COOLDOWN_MS = 5 * 60_000;
/** Window over which send outcomes count toward readiness. */
export const SEND_WINDOW_MS = 5 * 60_000;
/** Failed sends in {@link SEND_WINDOW_MS} that make Castra `degraded`. */
export const SEND_FAILURES_DEGRADED = 3;
/** Event-loop lag p99 over the last minute that makes Castra `down`. */
export const EVENT_LOOP_LAG_DOWN_MS = 2_000;

/** Outcome label of one `POST /v1/sessions/:id/send` (the `outcome` metric label). */
export type SendOutcome =
  /** agent-deck delivered the prompt. */
  | "delivered"
  /** agent-deck ran and refused: the composer was occupied or unreadable. */
  | "refused"
  /** Refused without running agent-deck: the session is in its refusal cooldown. */
  | "refused_cached"
  /** The session does not exist. */
  | "not_found"
  /** Any other failure. */
  | "failed";

/** A session whose composer refused a send. */
export interface RefusalEntry {
  readonly profile: string;
  readonly sessionId: string;
  /** When the refusal happened (ms epoch). */
  readonly at: number;
  /** The full refusal message returned to the caller, pane tail included. */
  readonly message: string;
  /** The tmux session the pane was read from, when known. */
  readonly tmuxSession?: string;
  /** Normalized pane tail at refusal; a different tail ends the cooldown. */
  readonly paneTail?: string;
}

function refusalKey(profile: string, sessionId: string): string {
  return `${profile}\u0000${sessionId}`;
}

/**
 * In-memory send health: per-session refusal cooldowns plus a rolling window of
 * send outcomes. Owned by the server, shared with the adapter.
 */
export class SendTracker {
  private readonly refusals = new Map<string, RefusalEntry>();
  private outcomes: { at: number; outcome: SendOutcome }[] = [];
  readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: { cooldownMs?: number; now?: () => number } = {}) {
    this.cooldownMs = options.cooldownMs ?? REFUSAL_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  recordRefusal(entry: Omit<RefusalEntry, "at"> & { at?: number }): RefusalEntry {
    const stored: RefusalEntry = { ...entry, at: entry.at ?? this.now() };
    this.refusals.set(refusalKey(entry.profile, entry.sessionId), stored);
    return stored;
  }

  /** The session's refusal, while its cooldown is running. Expired entries are dropped. */
  activeRefusal(profile: string, sessionId: string): RefusalEntry | undefined {
    const key = refusalKey(profile, sessionId);
    const entry = this.refusals.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.cooldownMs) {
      this.refusals.delete(key);
      return undefined;
    }
    return entry;
  }

  clearRefusal(profile: string, sessionId: string): void {
    this.refusals.delete(refusalKey(profile, sessionId));
  }

  /** Ms left in a refusal's cooldown. */
  remainingMs(entry: RefusalEntry): number {
    return Math.max(0, this.cooldownMs - (this.now() - entry.at));
  }

  /** Session ids currently in refusal cooldown, sorted. */
  refusedSessionIds(): string[] {
    const ids: string[] = [];
    for (const entry of [...this.refusals.values()]) {
      if (this.activeRefusal(entry.profile, entry.sessionId)) ids.push(entry.sessionId);
    }
    return ids.sort();
  }

  recordSend(outcome: SendOutcome): void {
    this.outcomes.push({ at: this.now(), outcome });
    this.prune();
  }

  /** Sends and failed sends in the last {@link SEND_WINDOW_MS}. `not_found` is not a failure. */
  recentSends(): { total: number; failed: number } {
    this.prune();
    const failed = this.outcomes.filter(
      (o) => o.outcome !== "delivered" && o.outcome !== "not_found",
    ).length;
    return { total: this.outcomes.length, failed };
  }

  private prune(): void {
    const cutoff = this.now() - SEND_WINDOW_MS;
    if (this.outcomes.length && this.outcomes[0]!.at < cutoff) {
      this.outcomes = this.outcomes.filter((o) => o.at >= cutoff);
    }
  }
}

/** Reads the event-loop lag p99 over the last minute, in ms. */
export interface EventLoopLagSource {
  lagP99Ms(): number;
}

/**
 * Event-loop lag from `perf_hooks.monitorEventLoopDelay`. Every `sampleMs` the
 * histogram's p99 is saved and the histogram reset; {@link lagP99Ms} returns the
 * largest p99 of the last minute, including the samples collected so far.
 */
export class EventLoopLagMonitor implements EventLoopLagSource {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private readonly samples: number[] = [];
  private readonly maxSamples: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly sampleMs = 5_000, windowMs = 60_000) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.maxSamples = Math.max(1, Math.round(windowMs / sampleMs));
  }

  start(): this {
    if (this.timer) return this;
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.histogram.disable();
  }

  private currentP99Ms(): number {
    if (this.histogram.count === 0) return 0;
    return this.histogram.percentile(99) / 1e6;
  }

  private sample(): void {
    this.samples.push(this.currentP99Ms());
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.histogram.reset();
  }

  lagP99Ms(): number {
    return Math.round(Math.max(0, this.currentP99Ms(), ...this.samples));
  }
}

export type CastraReadinessState = "ok" | "degraded" | "down";

/** The `GET /readyz` body. */
export interface CastraReadiness {
  readonly ready: boolean;
  readonly state: CastraReadinessState;
  readonly reasons: string[];
  readonly event_loop_lag_ms: number;
  readonly refused_sessions: string[];
  readonly recent_send_failures: number;
}

/** Derive `/readyz` from in-memory facts only, so the probe can never block. Pure. */
export function deriveCastraReadiness(input: {
  eventLoopLagMs: number;
  refusedSessions: readonly string[];
  recentSendFailures: number;
}): CastraReadiness {
  const reasons: string[] = [];
  let down = false;
  let degraded = false;
  if (input.eventLoopLagMs > EVENT_LOOP_LAG_DOWN_MS) {
    down = true;
    reasons.push(
      `event loop lag p99 over the last minute is ${input.eventLoopLagMs}ms (over ${EVENT_LOOP_LAG_DOWN_MS}ms), so requests are stalling`,
    );
  }
  if (input.refusedSessions.length) {
    degraded = true;
    reasons.push(
      `${input.refusedSessions.length} session(s) refused a send and are in refusal cooldown: ${input.refusedSessions.join(", ")}`,
    );
  }
  if (input.recentSendFailures >= SEND_FAILURES_DEGRADED) {
    degraded = true;
    reasons.push(
      `${input.recentSendFailures} sends failed in the last ${SEND_WINDOW_MS / 60_000} minutes`,
    );
  }
  const state: CastraReadinessState = down ? "down" : degraded ? "degraded" : "ok";
  return {
    ready: state !== "down",
    state,
    reasons,
    event_loop_lag_ms: input.eventLoopLagMs,
    refused_sessions: [...input.refusedSessions],
    recent_send_failures: input.recentSendFailures,
  };
}
