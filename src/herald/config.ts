import { createHash } from "node:crypto";
import { CLI_VERSION } from "../shared/version.js";

/**
 * Herald service configuration: identity, deterministic port, container/image
 * constants. Kept tiny and dependency-free so any consumer (server, client,
 * container launcher) computes the same values with no coordination.
 *
 * Herald is the system-state observation service — the heartbeat + data
 * collection calved off the legate loop. It runs the observe loop, records
 * change events into an append-only event log, and serves that log (the inbox
 * the legate drains) over HTTP.
 */

/** OTel `service.name` and pino logger name for the Herald service. */
export const HERALD_SERVICE_NAME = "march-herald";

/** Hatchery-managed container name + image tag. */
export const HERALD_CONTAINER_NAME = "march-herald";
export const HERALD_IMAGE_TAG = `march-herald:${CLI_VERSION}`;

/** Env var holding an explicit port override for the in-container service. */
export const HERALD_PORT_ENV = "MARCH_HERALD_PORT";

/**
 * Deterministic loopback port band, matching the legate-loop / castra / brood
 * scheme (8800–9799). Herald is a single shared service, so it derives one
 * stable port from its name — consumers compute the same value with no
 * coordination. The per-service name keeps it from colliding with the other
 * services' ports in practice.
 */
const PORT_BAND_START = 8800;
const PORT_BAND_SIZE = 1000;

/** The port the Herald service listens on (deterministic, in 8800–9799). */
export function heraldPort(): number {
  const hash = createHash("sha256").update(HERALD_SERVICE_NAME).digest();
  return PORT_BAND_START + (hash.readUInt32BE(0) % PORT_BAND_SIZE);
}

/**
 * Resolve the port to bind: explicit override, else `MARCH_HERALD_PORT`, else
 * the deterministic default. Throws on a non-numeric / out-of-range override so
 * a typo fails fast rather than binding port 0.
 */
export function resolveHeraldPort(
  override?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = override ?? env[HERALD_PORT_ENV];
  if (raw === undefined || raw === "") return heraldPort();
  const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid Herald port "${raw}": expected an integer in 1..65535.`);
  }
  return n;
}
