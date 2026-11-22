import { CLI_VERSION } from "./version.js";

/** C-BUILD: the build stamp a service reports on `/healthz` and `/status`. */
export interface BuildInfo {
  service: string;
  version: string;
  /** `git describe --tags --long --dirty --always` at build time, or null. */
  describe: string | null;
  /** Full git SHA at build time, or null. */
  commit: string | null;
  /** RFC3339 UTC build time, or null. */
  built_at: string | null;
  /** RFC3339 UTC process start (seconds precision). */
  started_at: string;
}

const STARTED_AT_MS = Date.now();

function rfc3339Seconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

/** Build the stamp. Unset/empty/whitespace env values become `null`, never `""`. */
export function buildInfo(
  service: string,
  opts: { startedAtMs?: number; env?: NodeJS.ProcessEnv } = {},
): BuildInfo {
  const env = opts.env ?? process.env;
  return {
    service,
    version: CLI_VERSION,
    describe: envValue(env, "MARCH_GIT_DESCRIBE"),
    commit: envValue(env, "MARCH_GIT_SHA"),
    built_at: envValue(env, "MARCH_BUILD_TIME"),
    started_at: rfc3339Seconds(opts.startedAtMs ?? STARTED_AT_MS),
  };
}
