import { createHash } from "node:crypto";
import { CastraValidationError } from "./types.js";

/**
 * Castra configuration: constants, identifier validation, and the deterministic
 * port the shared host listens on.
 */

/** OTel `service.name` for the Castra service. */
export const CASTRA_SERVICE_NAME = "march-castra";

/** Env var holding the shared bearer token that gates `/v1/*`. */
export const CASTRA_TOKEN_ENV = "CASTRA_API_TOKEN";
/** Env var holding the port the in-container service binds. */
export const CASTRA_PORT_ENV = "CASTRA_PORT";
/**
 * Env var holding the base URL consumers (e.g. the Hatchery) use to reach
 * Castra over HTTP. When unset, clients fall back to `http://localhost:<port>`
 * with the deterministic port; the compose file points peers at
 * `http://castra:<port>` on the shared `march` network.
 */
export const CASTRA_URL_ENV = "CASTRA_URL";

/** Default agent-deck group + model for launched stewards (mirrors Hatchery). */
export const CASTRA_DEFAULT_GROUP = "march-spawn-managers";
export const CASTRA_DEFAULT_MODEL = "opus";

/**
 * Deterministic loopback port band, matching the legate-loop service scheme
 * (8800–9799). Castra is a single shared host, so it derives one stable port
 * from its name — the operator and any consumer compute the same value with no
 * coordination.
 */
const PORT_BAND_START = 8800;
const PORT_BAND_SIZE = 1000;

/** The port the shared Castra host listens on (deterministic, in 8800–9799). */
export function castraPort(): number {
  const hash = createHash("sha256").update(CASTRA_SERVICE_NAME).digest();
  // Read 4 bytes as an unsigned int, fold into the band.
  const n = hash.readUInt32BE(0);
  return PORT_BAND_START + (n % PORT_BAND_SIZE);
}

/**
 * Resolve the port to bind: explicit override, else CASTRA_PORT env, else the
 * deterministic default. Throws on a non-numeric / out-of-range override so a
 * typo fails fast rather than binding port 0.
 */
export function resolveCastraPort(
  override?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = override ?? env[CASTRA_PORT_ENV];
  if (raw === undefined || raw === "") return castraPort();
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    // Require the whole string to be digits so a typo like "8888xyz" fails
    // fast rather than parseInt-ing to 8888 and binding an unintended port.
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new CastraValidationError(
        `Invalid Castra port "${raw}": expected an integer in 1..65535.`,
      );
    }
    n = Number.parseInt(trimmed, 10);
  }
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CastraValidationError(
      `Invalid Castra port "${raw}": expected an integer in 1..65535.`,
    );
  }
  return n;
}

// Profile / group / conductor names share agent-deck's identifier shape: start
// alphanumeric, then alphanumerics plus dot/underscore/hyphen. Enforced because
// these become agent-deck `-p`/`-g` argv and profile names land in filesystem
// paths — reject anything that could inject a path separator or flag.
const IDENTIFIER_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const IDENTIFIER_MAX_LEN = 64;

/** JSON-schema-friendly pattern source for identifiers (profile/group). */
export const IDENTIFIER_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9._-]*$";

export function validateProfile(profile: string): string {
  return validateIdentifier(profile, "profile");
}

export function validateGroup(group: string): string {
  return validateIdentifier(group, "group");
}

function validateIdentifier(value: string, label: string): string {
  if (!value) {
    throw new CastraValidationError(`${label} cannot be empty.`);
  }
  if (value.length > IDENTIFIER_MAX_LEN) {
    throw new CastraValidationError(
      `${label} too long (max ${IDENTIFIER_MAX_LEN} characters): ${value}`,
    );
  }
  if (!IDENTIFIER_REGEX.test(value)) {
    throw new CastraValidationError(
      `Invalid ${label} "${value}": must start with an alphanumeric character ` +
        "and contain only alphanumerics, dots, underscores, or hyphens.",
    );
  }
  return value;
}

// agent-deck session ids are opaque; validate only enough to reject empty,
// whitespace, and anything that looks like a flag or path separator (these
// become positional argv to `agent-deck session ...`).
const SESSION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const SESSION_ID_MAX_LEN = 128;

export function validateSessionId(sessionId: string): string {
  if (!sessionId) {
    throw new CastraValidationError("session id cannot be empty.");
  }
  if (sessionId.length > SESSION_ID_MAX_LEN) {
    throw new CastraValidationError(
      `session id too long (max ${SESSION_ID_MAX_LEN} characters).`,
    );
  }
  if (!SESSION_ID_REGEX.test(sessionId)) {
    throw new CastraValidationError(`Invalid session id "${sessionId}".`);
  }
  return sessionId;
}

/**
 * Keys allowed on `POST /v1/sessions/:id/set`. The API is a focused control
 * surface, not an arbitrary-mutation passthrough into `agent-deck session set`.
 */
export const CASTRA_SETTABLE_KEYS = ["auto-mode", "title", "model"] as const;
export type CastraSettableKey = (typeof CASTRA_SETTABLE_KEYS)[number];

export function validateSettableKey(key: string): CastraSettableKey {
  if (!(CASTRA_SETTABLE_KEYS as readonly string[]).includes(key)) {
    throw new CastraValidationError(
      `Unsupported session key "${key}". Allowed: ${CASTRA_SETTABLE_KEYS.join(", ")}.`,
    );
  }
  return key as CastraSettableKey;
}
