import { createHash } from "node:crypto";
import { StatioValidationError } from "./types.js";

/** OTel `service.name` for the Statio service. */
export const STATIO_SERVICE_NAME = "march-statio";
/** Env var holding the base URL consumers use to reach Statio over HTTP. */
export const STATIO_URL_ENV = "MARCH_STATIO_URL";
/** Env var holding the port the Statio service binds. */
export const STATIO_PORT_ENV = "MARCH_STATIO_PORT";
/** Env var holding the bearer token sent on every `/v1/*` request. */
export const STATIO_TOKEN_ENV = "MARCH_STATIO_TOKEN";

const PORT_BAND_START = 8800;
const PORT_BAND_SIZE = 1000;

/** The deterministic Statio port, derived from `march-statio` in the 8800-9799 band. */
export function statioPort(): number {
  const hash = createHash("sha256").update(STATIO_SERVICE_NAME).digest();
  const n = hash.readUInt32BE(0);
  return PORT_BAND_START + (n % PORT_BAND_SIZE);
}

/**
 * Resolve the Statio port: explicit override, else MARCH_STATIO_PORT, else the
 * deterministic default. Invalid overrides fail fast.
 */
export function resolveStatioPort(
  override?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = override ?? env[STATIO_PORT_ENV];
  if (raw === undefined || raw === "") return statioPort();

  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new StatioValidationError(
        `Invalid Statio port "${raw}": expected an integer in 1..65535.`,
      );
    }
    n = Number.parseInt(trimmed, 10);
  }

  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new StatioValidationError(
      `Invalid Statio port "${raw}": expected an integer in 1..65535.`,
    );
  }
  return n;
}

/** Resolve Statio's base URL (no trailing slash). */
export function resolveStatioBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[STATIO_URL_ENV]?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://localhost:${resolveStatioPort(undefined, env)}`;
}

/** Resolve the bearer token, treating blank values as unset. */
export function resolveStatioToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = env[STATIO_TOKEN_ENV]?.trim();
  return token && token.length > 0 ? token : undefined;
}
