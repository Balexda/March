import { createHash } from "node:crypto";
import { CLI_VERSION } from "../shared/version.js";
import type { SessionRepositoryBackend } from "./service/repository.js";

/**
 * Brood service configuration: identity, deterministic port, container/image
 * constants. Kept tiny and dependency-free so any consumer (server, client,
 * container launcher) computes the same values with no coordination.
 */

/** OTel `service.name` and pino logger name for the Brood service. */
export const BROOD_SERVICE_NAME = "march-brood";

/** Hatchery-managed container name + image tag (used by the PR7 launcher). */
export const BROOD_CONTAINER_NAME = "march-brood";
export const BROOD_IMAGE_TAG = `march-brood:${CLI_VERSION}`;

/** Env var holding an explicit port override for the in-container service. */
export const BROOD_PORT_ENV = "MARCH_BROOD_PORT";

/** Env var selecting the registry backend (`sqlite` default, `postgres` stub). */
export const BROOD_STORE_ENV = "MARCH_BROOD_STORE";

/**
 * Env vars arming the durable auto-reconciler (issue #304/#308 follow-up). Two
 * independent flags, both OFF by default: `MARCH_BROOD_AUTO_REAP` periodically
 * reaps dead orphans (confirmed-done + age-gated no-PR), `MARCH_BROOD_AUTO_ADOPT`
 * adopts untracked open-PR stewards into Brood so the legate merges them. Tunable
 * cadence + dead-orphan age threshold.
 */
export const BROOD_AUTO_REAP_ENV = "MARCH_BROOD_AUTO_REAP";
export const BROOD_AUTO_ADOPT_ENV = "MARCH_BROOD_AUTO_ADOPT";
export const BROOD_AUTO_REAP_INTERVAL_ENV = "MARCH_BROOD_AUTO_REAP_INTERVAL_MS";
export const BROOD_DEAD_ORPHAN_AGE_ENV = "MARCH_BROOD_DEAD_ORPHAN_AGE_HOURS";

/** Default cadence of the auto-reconciler reap loop (5 min) — conservative; the
 *  read-only observe loop stays at its own faster cadence for the gauges. */
const DEFAULT_REAP_INTERVAL_MS = 300_000;
/** Default age above which a non-running, no-open-PR orphan is judged dead. */
const DEFAULT_DEAD_ORPHAN_AGE_HOURS = 24;

/**
 * Deterministic loopback port band, matching the legate-loop / castra scheme
 * (8800–9799). Brood is a single shared service, so it derives one stable port
 * from its name — consumers compute the same value with no coordination. The
 * per-service name keeps it from colliding with castra's port in practice.
 */
const PORT_BAND_START = 8800;
const PORT_BAND_SIZE = 1000;

/** The port the Brood service listens on (deterministic, in 8800–9799). */
export function broodPort(): number {
  const hash = createHash("sha256").update(BROOD_SERVICE_NAME).digest();
  return PORT_BAND_START + (hash.readUInt32BE(0) % PORT_BAND_SIZE);
}

/**
 * Resolve the port to bind: explicit override, else `MARCH_BROOD_PORT`, else the
 * deterministic default. Throws on a non-numeric / out-of-range override so a
 * typo fails fast rather than binding port 0.
 */
export function resolveBroodPort(
  override?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = override ?? env[BROOD_PORT_ENV];
  if (raw === undefined || raw === "") return broodPort();
  const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid Brood port "${raw}": expected an integer in 1..65535.`);
  }
  return n;
}

/**
 * Resolve the registry backend: `MARCH_BROOD_STORE`, else `sqlite`. Throws on an
 * unrecognized value so a typo fails fast rather than silently falling back.
 * This is the config seam that selects which {@link SessionRepository} the
 * service builds — sqlite for local/dev, a managed DB for SaaS (issue #167).
 */
export function resolveBroodStoreBackend(
  env: NodeJS.ProcessEnv = process.env,
): SessionRepositoryBackend {
  const raw = env[BROOD_STORE_ENV];
  if (raw === undefined || raw === "") return "sqlite";
  const value = raw.trim().toLowerCase();
  if (value === "sqlite" || value === "postgres") return value;
  throw new Error(
    `Invalid ${BROOD_STORE_ENV} "${raw}": expected "sqlite" or "postgres".`,
  );
}

/**
 * Resolved config for the durable auto-reconciler. `reapEnabled`/`adoptEnabled`
 * are the two independent flags; `active` is true when either is on (the loop
 * runs). `intervalMs` and `deadOrphanAgeMs` are read regardless so a typo fails
 * fast even when the loop is off.
 */
export interface BroodReapConfig {
  readonly reapEnabled: boolean;
  readonly adoptEnabled: boolean;
  readonly active: boolean;
  readonly intervalMs: number;
  readonly deadOrphanAgeMs: number;
}

/** `true` only for the explicit opt-in value `"1"` (matches the OTel idiom). */
function envFlag(raw: string | undefined): boolean {
  return (raw ?? "").trim() === "1";
}

/**
 * Parse a positive-number env var (interval ms / age hours), throwing on a
 * non-numeric or non-positive override so a typo fails fast rather than silently
 * disabling the loop. Empty/unset → the provided default.
 */
function resolvePositiveNumber(
  raw: string | undefined,
  fallback: number,
  envName: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${envName} "${raw}": expected a positive number.`);
  }
  return n;
}

/**
 * Resolve the auto-reconciler config from the environment. Both flags default
 * OFF; the cadence defaults to 5 min and the dead-orphan age to 24 h. The loop
 * is started only when `active`.
 */
export function resolveReapConfig(
  env: NodeJS.ProcessEnv = process.env,
): BroodReapConfig {
  const reapEnabled = envFlag(env[BROOD_AUTO_REAP_ENV]);
  const adoptEnabled = envFlag(env[BROOD_AUTO_ADOPT_ENV]);
  const intervalMs = resolvePositiveNumber(
    env[BROOD_AUTO_REAP_INTERVAL_ENV],
    DEFAULT_REAP_INTERVAL_MS,
    BROOD_AUTO_REAP_INTERVAL_ENV,
  );
  const ageHours = resolvePositiveNumber(
    env[BROOD_DEAD_ORPHAN_AGE_ENV],
    DEFAULT_DEAD_ORPHAN_AGE_HOURS,
    BROOD_DEAD_ORPHAN_AGE_ENV,
  );
  return {
    reapEnabled,
    adoptEnabled,
    active: reapEnabled || adoptEnabled,
    intervalMs,
    deadOrphanAgeMs: ageHours * 3_600_000,
  };
}
