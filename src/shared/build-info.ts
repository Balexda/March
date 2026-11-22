import { CLI_VERSION } from "./version.js";

/** C-BUILD: the build stamp a service reports on `/healthz` and `/status`. */
export interface BuildInfo {
  service: string;
  version: string;
  /** `git describe --tags --long --dirty --always` at build time (free-form, unvalidated), or null. */
  describe: string | null;
  /** Full 40-hex git SHA at build time; null when unset or malformed. */
  commit: string | null;
  /** RFC3339 UTC (`Z`) build time; null when unset or malformed. */
  built_at: string | null;
  /** RFC3339 UTC process start (seconds precision). */
  started_at: string;
}

const STARTED_AT_MS = Date.now();

function rfc3339Seconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const RFC3339_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

/** Trimmed env value; null when unset, empty, or (with `valid`) malformed. */
function envValue(env: NodeJS.ProcessEnv, key: string, valid?: RegExp): string | null {
  const v = env[key]?.trim();
  if (!v) return null;
  return !valid || valid.test(v) ? v : null;
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
    commit: envValue(env, "MARCH_GIT_SHA", FULL_SHA)?.toLowerCase() ?? null,
    built_at: envValue(env, "MARCH_BUILD_TIME", RFC3339_UTC),
    started_at: rfc3339Seconds(opts.startedAtMs ?? STARTED_AT_MS),
  };
}
