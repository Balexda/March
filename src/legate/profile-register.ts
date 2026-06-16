import { execFileSync } from "node:child_process";
import { locateCompose } from "../stack/services.js";
import { ProfileClient } from "../herald/profiles/client.js";
import type { ProfileRecord, RegisterProfileInput } from "../herald/profiles/types.js";

/**
 * Profile registration + service-ensure helpers for the profile-agnostic legate.
 * `march legate init` (and the `march profile` command group) call these to
 * register a repo with Herald's registry — the source of truth the single
 * `march-legate` container reads each tick — and to ensure that container is up.
 */

export interface RegisterResult {
  /** The registered record, or null when Herald was unreachable (best-effort). */
  readonly record: ProfileRecord | null;
  /** A human-readable note (success or the reason it was skipped). */
  readonly note: string;
}

/** Register/upsert a profile with Herald. Best-effort: never throws. */
export async function registerProfile(
  input: RegisterProfileInput,
  opts: { env?: NodeJS.ProcessEnv; client?: ProfileClient } = {},
): Promise<RegisterResult> {
  const client = opts.client ?? new ProfileClient({ env: opts.env });
  try {
    const record = await client.register(input);
    return { record, note: `registered profile "${input.profile}" with Herald` };
  } catch (err) {
    return {
      record: null,
      note:
        `could not register profile "${input.profile}" with Herald ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `the legate will pick it up once Herald is reachable — re-run \`march profile register\``,
    };
  }
}

/**
 * Locate the `docker/legate.docker-compose.yml` shipped alongside the CLI.
 * Thin wrapper over the shared {@link locateCompose} walk-up used by the
 * stack-lifecycle commands. Returns null when not found (e.g. an npm install
 * that didn't publish `docker/`).
 */
export function locateLegateCompose(): string | null {
  return locateCompose("legate.docker-compose.yml");
}

export interface EnsureServiceResult {
  readonly ran: boolean;
  readonly note: string;
}

/**
 * Ensure the single shared `march-legate` compose service is up (idempotent
 * `docker compose up -d`). Best-effort: returns a guidance note rather than
 * throwing when the compose file can't be located or docker fails — the operator
 * can always bring it up via the standup recipe.
 */
export function ensureLegateService(
  opts: { composePath?: string | null; build?: boolean } = {},
): EnsureServiceResult {
  const composePath = opts.composePath ?? locateLegateCompose();
  if (!composePath) {
    return {
      ran: false,
      note:
        "could not locate docker/legate.docker-compose.yml; bring the legate up with " +
        "`docker compose -f docker/legate.docker-compose.yml up -d` from the March repo",
    };
  }
  try {
    const args = ["compose", "-f", composePath, "up", "-d"];
    if (opts.build) args.push("--build");
    execFileSync("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    return { ran: true, note: `ensured the march-legate service is up (${composePath})` };
  } catch (err) {
    return {
      ran: false,
      note:
        `\`docker compose up\` for the legate failed ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `bring it up manually with \`docker compose -f ${composePath} up -d\``,
    };
  }
}
