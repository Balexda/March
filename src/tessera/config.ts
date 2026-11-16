import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { TesseraValidationError } from "./types.js";

/** OTel `service.name` for the Tessera service. */
export const TESSERA_SERVICE_NAME = "march-tessera";

/**
 * Consumer-side settings (`MARCH_TESSERA_*`): how March processes reach
 * Tessera. Kept separate from the server-side `TESSERA_*` settings below.
 */
export const TESSERA_CONSUMER_ENV = Object.freeze({
  /** Base URL consumers use to reach Tessera over HTTP; read by the Node client. */
  url: "MARCH_TESSERA_URL",
  /** Port the Tessera service binds. */
  port: "MARCH_TESSERA_PORT",
  /** This process's own Tessera client key, sent as the bearer credential. */
  clientKey: "MARCH_TESSERA_CLIENT_KEY",
  /** `1` permits the gated `GH_TOKEN`/`GITHUB_TOKEN` migration fallback. Unset by default. */
  ghTokenFallback: "MARCH_TESSERA_GH_TOKEN_FALLBACK",
});

/** Env var holding the port the Tessera service binds. */
export const TESSERA_PORT_ENV = TESSERA_CONSUMER_ENV.port;
/** Env var holding the base URL consumers use to reach Tessera. */
export const TESSERA_URL_ENV = TESSERA_CONSUMER_ENV.url;
/** Env var holding this process's Tessera client key. */
export const TESSERA_CLIENT_KEY_ENV = TESSERA_CONSUMER_ENV.clientKey;
/** Env var enabling the environment-token migration fallback (exactly `1`). */
export const TESSERA_GH_TOKEN_FALLBACK_ENV = TESSERA_CONSUMER_ENV.ghTokenFallback;

/** Server-side: GitHub App id. Required for the `app` identity. */
export const TESSERA_GITHUB_APP_ID_ENV = "TESSERA_GITHUB_APP_ID";
/** Server-side: GitHub App private key file. Required for the `app` identity. */
export const TESSERA_GITHUB_APP_KEY_FILE_ENV = "TESSERA_GITHUB_APP_KEY_FILE";
/** Server-side: optional pinned installation id; otherwise resolved per owner. */
export const TESSERA_GITHUB_INSTALLATION_ID_ENV = "TESSERA_GITHUB_INSTALLATION_ID";

/** Server-side: client registrations (name + SHA-256 key hash). Required; no default. */
export const TESSERA_CLIENT_KEYS_FILE_ENV = "TESSERA_CLIENT_KEYS_FILE";

/** Server-side: per-client policy rules (default deny). Required; no default. */
export const TESSERA_POLICY_FILE_ENV = "TESSERA_POLICY_FILE";

const PORT_BAND_START = 8800;
const PORT_BAND_SIZE = 1000;

/** The deterministic Tessera port, derived from `march-tessera` in the 8800-9799 band. */
export function tesseraPort(): number {
  const hash = createHash("sha256").update(TESSERA_SERVICE_NAME).digest();
  const n = hash.readUInt32BE(0);
  return PORT_BAND_START + (n % PORT_BAND_SIZE);
}

/**
 * Resolve the Tessera port: explicit override, else MARCH_TESSERA_PORT, else
 * the deterministic default. Invalid values fail fast with a typed error.
 */
export function resolveTesseraPort(
  override?: number | string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = override ?? env[TESSERA_PORT_ENV];
  if (raw === undefined || raw === "") return tesseraPort();

  const invalid = () =>
    new TesseraValidationError(`Invalid Tessera port "${raw}": expected an integer in 1..65535.`);

  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) throw invalid();
    n = Number.parseInt(trimmed, 10);
  }

  if (!Number.isInteger(n) || n < 1 || n > 65535) throw invalid();
  return n;
}

/**
 * Resolve the Tessera base URL for consumers: MARCH_TESSERA_URL (trimmed,
 * trailing slashes removed), else `http://localhost:<port>` on the resolved
 * Tessera port.
 */
export function resolveTesseraBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[TESSERA_URL_ENV]?.trim();
  if (url) return url.replace(/\/+$/, "");
  return `http://localhost:${resolveTesseraPort(undefined, env)}`;
}

/** Resolve this process's Tessera client key; unset or blank is `undefined`. */
export function resolveTesseraClientKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env[TESSERA_CLIENT_KEY_ENV]?.trim();
  return key ? key : undefined;
}

/** Whether the environment-token migration fallback is enabled: only the exact value `1`. */
export function resolveTesseraGhTokenFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TESSERA_GH_TOKEN_FALLBACK_ENV] === "1";
}

/** GitHub App settings resolved from the server-side env. */
export type GitHubAppConfig =
  | {
      readonly configured: true;
      readonly appId: string;
      readonly keyFile: string;
      /** Pinned installation; `undefined` means resolve per repository owner. */
      readonly installationId: number | undefined;
    }
  | {
      readonly configured: false;
      /** Names of the settings that are absent; never their values. */
      readonly missing: readonly string[];
    };

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve the client-keys file path. The setting is required: unset or blank
 * is a typed validation error (startup failure), never "allow all".
 */
export function resolveClientKeysFile(env: NodeJS.ProcessEnv = process.env): string {
  const path = readTrimmed(env, TESSERA_CLIENT_KEYS_FILE_ENV);
  if (path === undefined) {
    throw new TesseraValidationError(
      `${TESSERA_CLIENT_KEYS_FILE_ENV} is not set: Tessera requires a client-keys file and will not start without one.`,
    );
  }
  return path;
}

/**
 * Resolve the policy file path. The setting is required: unset or blank is a
 * typed validation error (startup failure), never "allow all".
 */
export function resolvePolicyFile(env: NodeJS.ProcessEnv = process.env): string {
  const path = readTrimmed(env, TESSERA_POLICY_FILE_ENV);
  if (path === undefined) {
    throw new TesseraValidationError(
      `${TESSERA_POLICY_FILE_ENV} is not set: Tessera requires a policy file and will not start without one.`,
    );
  }
  return path;
}

/**
 * Resolve the GitHub App provider config. A missing app id or key file (unset,
 * blank, or not present on disk) yields an unconfigured config so the service
 * still starts; an invalid installation id is a typed validation error.
 */
export function resolveGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): GitHubAppConfig {
  const appId = readTrimmed(env, TESSERA_GITHUB_APP_ID_ENV);
  const keyFile = readTrimmed(env, TESSERA_GITHUB_APP_KEY_FILE_ENV);
  const rawInstallation = readTrimmed(env, TESSERA_GITHUB_INSTALLATION_ID_ENV);

  let installationId: number | undefined;
  if (rawInstallation !== undefined) {
    if (!/^\d+$/.test(rawInstallation) || Number.parseInt(rawInstallation, 10) < 1) {
      throw new TesseraValidationError(
        `Invalid ${TESSERA_GITHUB_INSTALLATION_ID_ENV} "${rawInstallation}": expected a positive integer.`,
      );
    }
    installationId = Number.parseInt(rawInstallation, 10);
  }

  const missing: string[] = [];
  if (appId === undefined) missing.push(TESSERA_GITHUB_APP_ID_ENV);
  if (keyFile === undefined || !fileExists(keyFile)) missing.push(TESSERA_GITHUB_APP_KEY_FILE_ENV);
  if (missing.length > 0 || appId === undefined || keyFile === undefined) {
    return { configured: false, missing };
  }

  return { configured: true, appId, keyFile, installationId };
}
