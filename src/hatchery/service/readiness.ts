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
  /** Why no credential is available (`tessera:unconfigured`, `tessera:unreachable`,
   *  `tessera:provider_<state>`, or {@link FALLBACK_UNSUPPORTED_REASON}), else null. */
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

/** Reason when only the ambient-token migration fallback is configured. */
export const FALLBACK_UNSUPPORTED_REASON =
  "using ambient GH_TOKEN instead of Tessera (fallback is not a supported credential path)";

/** How long a Tessera `/status` answer is reused (readyz is polled every tick). */
export const TESSERA_STATUS_TTL_MS = 5_000;
/** Tessera `/status` probe timeout — short, so `/readyz` never hangs. */
export const TESSERA_STATUS_TIMEOUT_MS = 1_500;

export interface GitHubCredentialCheckerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Can a spawn get a GitHub app/read credential? Tessera is the ONLY supported
 * source: `ok` requires Tessera to be configured (URL + client key), reachable,
 * and its `github-app` provider to report `ok`. The ambient-token fallback is
 * reported (`source: "fallback"`) but is NOT ok — the stack is down without
 * Tessera. The `/status` probe is unauthenticated, times out quickly and is
 * cached for a few seconds, so `/readyz` stays cheap and never hangs.
 */
export class GitHubCredentialChecker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached?: { key: string; at: number; result: GitHubCredentialCheck };
  private last?: GitHubCredentialCheck;

  constructor(options: GitHubCredentialCheckerOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.ttlMs = options.ttlMs ?? TESSERA_STATUS_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? TESSERA_STATUS_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** The most recent result, for the readiness gauge (undefined before the first check). */
  get latest(): GitHubCredentialCheck | undefined {
    return this.last;
  }

  async check(): Promise<GitHubCredentialCheck> {
    const result = await this.compute();
    this.last = result;
    return result;
  }

  private async compute(): Promise<GitHubCredentialCheck> {
    const config = resolveTesseraConfig({ env: this.env });
    if (!config) {
      const fallback = this.env.MARCH_TESSERA_GH_TOKEN_FALLBACK === "1"
        && [this.env.GH_TOKEN, this.env.GITHUB_TOKEN].some((v) => v?.trim() && !/[\r\n]/.test(v));
      return fallback
        ? { ok: false, source: "fallback", reason: FALLBACK_UNSUPPORTED_REASON }
        : { ok: false, source: "none", reason: "tessera:unconfigured" };
    }
    const at = this.now();
    if (this.cached && this.cached.key === config.baseUrl && at - this.cached.at < this.ttlMs) return this.cached.result;
    const result = await this.probe(config.baseUrl);
    this.cached = { key: config.baseUrl, at, result };
    return result;
  }

  private async probe(baseUrl: string): Promise<GitHubCredentialCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body: unknown;
    try {
      const res = await this.fetchImpl(baseUrl + "/status", { method: "GET", signal: controller.signal, redirect: "error" });
      if (res.status !== 200) return { ok: false, source: "tessera", reason: "tessera:unreachable" };
      body = JSON.parse(await res.text());
    } catch {
      return { ok: false, source: "tessera", reason: "tessera:unreachable" };
    } finally {
      clearTimeout(timer);
    }
    const providers = (body as { providers?: unknown } | null)?.providers;
    const app = Array.isArray(providers)
      ? (providers.find((p) => (p as { provider?: unknown })?.provider === "github-app") as { state?: unknown } | undefined)
      : undefined;
    const state = typeof app?.state === "string" && /^[a-z_]{1,32}$/.test(app.state) ? app.state : "invalid";
    if (state === "ok") return { ok: true, source: "tessera", reason: null };
    return { ok: false, source: "tessera", reason: `tessera:provider_${state}` };
  }
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

function githubReasonSentence(github: GitHubCredentialCheck): string {
  switch (github.reason) {
    case "tessera:unconfigured":
      return "no GitHub credential: Tessera is not configured for Hatchery (MARCH_TESSERA_URL + MARCH_TESSERA_CLIENT_KEY) (tessera:unconfigured)";
    case "tessera:unreachable":
      return "no GitHub credential: Tessera is not reachable (tessera:unreachable)";
    case FALLBACK_UNSUPPORTED_REASON:
      return "no GitHub credential: " + FALLBACK_UNSUPPORTED_REASON;
    default:
      return github.reason?.startsWith("tessera:provider_")
        ? `no GitHub credential: Tessera's github-app provider is ${github.reason.slice("tessera:provider_".length)} (${github.reason})`
        : `no GitHub credential (${github.reason ?? "unknown"})`;
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
    reasons.push(githubReasonSentence(github));
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
