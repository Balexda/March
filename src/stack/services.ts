import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The March service stack — shared definition for the stack-lifecycle commands
 * (`march up` / `down` / `upgrade` / `status`). Each service is one Docker
 * compose file shipped under `docker/`.
 */
export interface MarchService {
  /** Identity/display name (matches the compose service + image basename). */
  readonly name: string;
  /** Basename of the compose file under `docker/`. */
  readonly compose: string;
}

/**
 * The stack in dependency (bring-up) order:
 * - `otel-lgtm` is first because it creates the shared `march` Docker network
 *   the other services join.
 * - `castra` is next because `hatchery` / `brood` / `herald` / `legate` all call
 *   it over HTTP.
 *
 * Tear-down walks this list in reverse so the network owner (`otel-lgtm`) is
 * removed last, after every consumer is gone.
 */
export const MARCH_SERVICES: readonly MarchService[] = [
  { name: "otel-lgtm", compose: "otel-lgtm.docker-compose.yml" },
  { name: "castra", compose: "castra.docker-compose.yml" },
  { name: "hatchery", compose: "hatchery.docker-compose.yml" },
  { name: "brood", compose: "brood.docker-compose.yml" },
  { name: "herald", compose: "herald.docker-compose.yml" },
  { name: "legate", compose: "legate.docker-compose.yml" },
];

/**
 * Locate a compose file shipped under `docker/`, by walking up from `startDir`
 * (defaults to this module) to the package root (the dir holding `docker/`).
 * Returns null when not found (e.g. an npm install that didn't publish `docker/`).
 */
export function locateCompose(
  basename: string,
  startDir?: string,
): string | null {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "docker", basename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
