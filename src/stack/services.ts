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
  /**
   * The local image `march up` / `march upgrade` must find before it will
   * (re)start the service. Undefined for services whose image is pulled from a
   * remote registry by compose (e.g. otel-lgtm) rather than built locally.
   */
  readonly image?: string;
  /** Loopback port the service publishes (`127.0.0.1:<port>`). */
  readonly port: number;
  /**
   * Env var that overrides the published host port, for the services whose
   * compose file parametrizes it (only castra: `127.0.0.1:${CASTRA_PORT:-9264}`).
   * When set in the environment, `march status` probes that port instead of
   * {@link port}; the other services hard-code their host port in compose, so
   * they have no `portEnv`.
   */
  readonly portEnv?: string;
  /** HTTP path that reports liveness (200 = reachable + healthy). */
  readonly healthPath: string;
  /**
   * HTTP path gated by the shared `CASTRA_API_TOKEN`, used to verify the token
   * actually authenticates rather than 401/404-ing silently. Only set for
   * services that gate a route on the shared token (castra).
   */
  readonly tokenGatedPath?: string;
  /**
   * Other services this one calls over HTTP. Used by `march status` to explain
   * a degraded service ("legate depends on herald, which is down"). The shared
   * `otel-lgtm` network owner is intentionally omitted — telemetry is opt-in,
   * so it is not a functional dependency.
   */
  readonly dependsOn?: readonly string[];
}

/** Docker container name for a service (matches `container_name` in compose). */
export function containerName(service: string): string {
  return `march-${service}`;
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
  {
    name: "otel-lgtm",
    compose: "otel-lgtm.docker-compose.yml",
    port: 3000,
    // Grafana's health endpoint; the otel-lgtm bundle has no /healthz.
    healthPath: "/api/health",
  },
  {
    name: "castra",
    compose: "castra.docker-compose.yml",
    image: "march-castra:latest",
    port: 9264,
    // The castra compose publishes 127.0.0.1:${CASTRA_PORT:-9264}, so honor an
    // operator-set CASTRA_PORT when probing rather than the 9264 default.
    portEnv: "CASTRA_PORT",
    healthPath: "/healthz",
    // `/v1/*` is the shared-token gate; GET /v1/sessions exercises it.
    tokenGatedPath: "/v1/sessions",
  },
  {
    name: "hatchery",
    compose: "hatchery.docker-compose.yml",
    image: "march-hatchery:latest",
    port: 8080,
    healthPath: "/healthz",
    dependsOn: ["castra"],
  },
  {
    name: "brood",
    compose: "brood.docker-compose.yml",
    image: "march-brood:latest",
    port: 9748,
    healthPath: "/healthz",
    dependsOn: ["castra"],
  },
  {
    name: "herald",
    compose: "herald.docker-compose.yml",
    image: "march-herald:latest",
    port: 8818,
    healthPath: "/healthz",
    dependsOn: ["castra"],
  },
  {
    name: "legate",
    compose: "legate.docker-compose.yml",
    image: "march-legate:latest",
    port: 8787,
    healthPath: "/healthz",
    dependsOn: ["castra", "herald", "brood", "hatchery"],
  },
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
