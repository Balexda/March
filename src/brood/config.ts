import { createHash } from "node:crypto";
import { CLI_VERSION } from "../shared/version.js";

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
