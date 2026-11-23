import { resolveTesseraConfig } from "../../tessera/config.js";

/**
 * Hatchery READINESS (`GET /readyz`) — "can this service do its job right now",
 * distinct from `/healthz` liveness. The 2026-11-22 incident: every spawn failed
 * `tessera:unconfigured` for 5h while `/healthz` (and `/readyz`, which only
 * checked docker + castra) stayed green. Readiness now also covers the GitHub
 * app/read credential spawns need (#628 base pinning) and a rolling window of
 * recent spawn outcomes, so a stack that cannot spawn reports `down`.
 */

export type ReadinessState = "ok" | "degraded" | "down";
export type GitHubCredentialSource = "tessera" | "fallback" | "none";

export interface GitHubCredentialCheck {
  readonly ok: boolean;
  readonly source: GitHubCredentialSource;
  /** Low-cardinality reason when no credential is available, else null. */
  readonly reason: string | null;
}

export interface SpawnWindowSnapshot {
  readonly recent: number;
  readonly failed: number;
  readonly consecutive_failures: number;
  readonly last_error: string | null;
  readonly last_error_at: string | null;
  readonly last_success_at: string | null;
}

export interface HatcheryReadiness {
  readonly ready: boolean;
  readonly state: ReadinessState;
  readonly docker: boolean;
  readonly castra: boolean;
  readonly github: GitHubCredentialCheck;
  readonly spawns: SpawnWindowSnapshot;
  readonly reasons: string[];
}

/** Rolling window size: the last N finished spawn jobs. */
export const SPAWN_WINDOW_SIZE = 20;
/** Consecutive spawn failures at which readiness is `degraded`. */
export const DEGRADED_CONSECUTIVE_FAILURES = 2;
/** Consecutive spawn failures at which readiness is `down`. */
export const DOWN_CONSECUTIVE_FAILURES = 5;

/**
 * Which GitHub credential a spawn would get — a LOCAL check (no network, no
 * mint), mirroring the Tessera client's decision: a complete Tessera config
 * (URL + client key) → `tessera`; else the explicit migration fallback with an
 * ambient token → `fallback` (the sanctioned path today, so it stays `ok`);
 * else `none`, which is exactly the `tessera:unconfigured` spawn failure.
 */
export function githubCredentialCheck(env: NodeJS.ProcessEnv = process.env): GitHubCredentialCheck {
  if (resolveTesseraConfig({ env })) return { ok: true, source: "tessera", reason: null };
  const fallback = env.MARCH_TESSERA_GH_TOKEN_FALLBACK === "1";
  if (fallback) {
    // Same acceptance rule as the client: trimmed, CR/LF means absent.
    const token = [env.GH_TOKEN, env.GITHUB_TOKEN].map((v) => v?.trim()).find((v) => v && !/[\r\n]/.test(v));
    if (token) return { ok: true, source: "fallback", reason: null };
    return { ok: false, source: "none", reason: "fallback:no_token" };
  }
  return { ok: false, source: "none", reason: "tessera:unconfigured" };
}

interface SpawnOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly at: string;
}

/**
 * In-memory rolling window over the last {@link SPAWN_WINDOW_SIZE} finished
 * spawn jobs. In-memory is fine: a restart resets it, and the very next spawn
 * re-establishes the signal (the GitHub credential check covers the config side
 * without waiting for a spawn).
 */
export class SpawnWindow {
  private readonly outcomes: SpawnOutcome[] = [];
  private consecutive = 0;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private lastSuccessAt: string | null = null;

  constructor(private readonly size: number = SPAWN_WINDOW_SIZE) {}

  record(ok: boolean, reason: string | null, at: string = new Date().toISOString()): void {
    this.outcomes.push({ ok, reason, at });
    if (this.outcomes.length > this.size) this.outcomes.shift();
    if (ok) {
      this.consecutive = 0;
      this.lastSuccessAt = at;
    } else {
      this.consecutive++;
      this.lastError = reason ?? "other";
      this.lastErrorAt = at;
    }
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }

  snapshot(): SpawnWindowSnapshot {
    return {
      recent: this.outcomes.length,
      failed: this.outcomes.filter((o) => !o.ok).length,
      consecutive_failures: this.consecutive,
      last_error: this.lastError,
      last_error_at: this.lastErrorAt,
      last_success_at: this.lastSuccessAt,
    };
  }
}

/** Derive the `/readyz` body from its independent checks. Pure. */
export function deriveReadiness(input: {
  docker: boolean;
  castra: boolean;
  github: GitHubCredentialCheck;
  spawns: SpawnWindowSnapshot;
}): HatcheryReadiness {
  const { docker, castra, github, spawns } = input;
  const reasons: string[] = [];
  let down = false;
  let degraded = false;
  if (!docker) {
    down = true;
    reasons.push("docker is not available (no docker binary or socket), so spawn containers cannot start");
  }
  if (!castra) {
    down = true;
    reasons.push("Castra is not reachable, so steward sessions cannot be created");
  }
  if (!github.ok) {
    down = true;
    reasons.push(
      github.reason === "fallback:no_token"
        ? "no GitHub credential: MARCH_TESSERA_GH_TOKEN_FALLBACK=1 but GH_TOKEN/GITHUB_TOKEN is empty (fallback:no_token)"
        : `no GitHub credential: Tessera is not configured and the token fallback is off (${github.reason ?? "tessera:unconfigured"})`,
    );
  }
  const n = spawns.consecutive_failures;
  if (n >= DOWN_CONSECUTIVE_FAILURES) {
    down = true;
    reasons.push(`the last ${n} spawns failed (${spawns.last_error ?? "other"})`);
  } else if (n >= DEGRADED_CONSECUTIVE_FAILURES) {
    degraded = true;
    reasons.push(`the last ${n} spawns failed (${spawns.last_error ?? "other"})`);
  }
  const state: ReadinessState = down ? "down" : degraded ? "degraded" : "ok";
  return { ready: state !== "down", state, docker, castra, github, spawns, reasons };
}
