import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { CASTRA_TOKEN_ENV } from "../castra/config.js";
import { imageExists } from "./exec.js";
import {
  MARCH_SERVICES,
  containerName,
  type MarchService,
} from "./services.js";
import { defaultTokenPath } from "./up.js";

/**
 * `march status` — stack health + reachability pre-flight.
 *
 * For each of the six March services it reports three independent facts —
 * container state (running/stopped/absent), HTTP reachability on the loopback
 * port, and whether the shared `CASTRA_API_TOKEN` authenticates (where a route
 * is gated on it) — then surfaces the common misconfig classes: token drift, a
 * depended-on service that is down, and a missing locally-built image. The
 * stack is healthy only when every service is, so the command exits non-zero
 * when it is not (a pre-flight gate for automation).
 *
 * The command is read-only: it never starts, stops, or mutates anything — not
 * even the shared token (it reads the persisted token but, unlike `march up`,
 * never generates one).
 */

/** Container lifecycle state, as reported by `docker inspect`. */
export type ContainerState = "running" | "stopped" | "absent" | "unknown";

/** HTTP reachability on the loopback port. */
export type Reachability = "ok" | "unreachable" | "error";

/** Shared-token authentication state for a token-gated service. */
export type TokenState = "ok" | "drift" | "unknown" | "n/a";

export interface ServiceStatus {
  readonly service: string;
  readonly port: number;
  readonly container: ContainerState;
  readonly reachable: Reachability;
  /** HTTP status code from the health probe, when a response was received. */
  readonly httpStatus?: number;
  readonly token: TokenState;
  /** Present only for services with a locally-built image. */
  readonly imagePresent?: boolean;
  /** True when this service is up, reachable, and correctly token-wired. */
  readonly healthy: boolean;
  /** Human-readable misconfig descriptions (empty when healthy). */
  readonly issues: string[];
}

export interface StackStatus {
  readonly services: ServiceStatus[];
  /** True only when every service is healthy. */
  readonly healthy: boolean;
}

/** Result of a single HTTP probe. */
export interface HttpProbeResult {
  /** True when an HTTP response was received (any status code). */
  readonly reachable: boolean;
  /** The HTTP status code, when a response came back. */
  readonly status?: number;
}

export interface StatusOptions {
  /** Injected container-state probe (defaults to `docker inspect`). */
  readonly containerState?: (name: string) => ContainerState;
  /** Injected HTTP probe (defaults to {@link fetchProbe}). */
  readonly probeHttp?: (
    url: string,
    token?: string,
  ) => Promise<HttpProbeResult>;
  /** Injected image-presence check (defaults to {@link imageExists}). */
  readonly imagePresent?: (image: string) => boolean;
  /** Injected shared-token reader (defaults to {@link readSharedToken}). */
  readonly readToken?: () => string | null;
  /** Per-probe HTTP timeout in ms (default 2000). */
  readonly timeoutMs?: number;
  /** Base env (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Read the shared `CASTRA_API_TOKEN` the way `march up` would, but WITHOUT the
 * generate-and-persist fallback: an operator-set env value wins, else the
 * previously persisted token is reused, else null (status is a read-only probe
 * and must not mint a token as a side effect).
 */
export function readSharedToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env[CASTRA_TOKEN_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const fromFile = fs.readFileSync(defaultTokenPath(), "utf-8");
    if (fromFile.trim()) return fromFile.trim();
  } catch {
    // No persisted token — treated as "not configured".
  }
  return null;
}

/** Default container-state probe via `docker inspect`. */
export function dockerContainerState(name: string): ContainerState {
  let out: string;
  try {
    out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.State.Status}}", name],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    // `No such object` (container absent) or docker unavailable.
    return "absent";
  }
  if (out === "running") return "running";
  if (out === "") return "unknown";
  // created / exited / paused / dead / restarting — all "not running".
  return "stopped";
}

/**
 * Default HTTP probe using global `fetch`. Returns `reachable: false` when the
 * connection fails or times out; otherwise reports the status code so callers
 * can distinguish a healthy 2xx from a 401/404.
 */
export async function fetchProbe(
  url: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<HttpProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    return { reachable: true, status: res.status };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

async function statusForService(
  svc: MarchService,
  deps: {
    containerState: (name: string) => ContainerState;
    probeHttp: (url: string, token?: string) => Promise<HttpProbeResult>;
    imagePresent: (image: string) => boolean;
    token: string | null;
  },
): Promise<ServiceStatus> {
  const issues: string[] = [];

  const container = deps.containerState(containerName(svc.name));
  if (container !== "running") {
    issues.push(
      container === "absent"
        ? "container is absent"
        : `container is ${container}`,
    );
  }

  let imagePresent: boolean | undefined;
  if (svc.image) {
    imagePresent = deps.imagePresent(svc.image);
    if (!imagePresent) issues.push(`image ${svc.image} is not built`);
  }

  const health = await deps.probeHttp(
    `http://127.0.0.1:${svc.port}${svc.healthPath}`,
  );
  let reachable: Reachability;
  if (!health.reachable) {
    reachable = "unreachable";
    issues.push(`not reachable on port ${svc.port}`);
  } else if (health.status !== undefined && health.status >= 500) {
    reachable = "error";
    issues.push(`health check returned HTTP ${health.status}`);
  } else {
    reachable = "ok";
  }

  // Token wiring: only meaningful for a token-gated service that is reachable.
  let token: TokenState;
  if (!svc.tokenGatedPath) {
    token = "n/a";
  } else if (!deps.token) {
    token = "unknown";
    issues.push(
      `${CASTRA_TOKEN_ENV} not set and no persisted token — cannot verify auth`,
    );
  } else if (reachable !== "ok") {
    // Service is down/unhealthy; auth can't be probed yet.
    token = "unknown";
  } else {
    const gated = await deps.probeHttp(
      `http://127.0.0.1:${svc.port}${svc.tokenGatedPath}`,
      deps.token,
    );
    if (!gated.reachable) {
      token = "unknown";
    } else if (gated.status === 401 || gated.status === 403) {
      token = "drift";
      issues.push(
        `${CASTRA_TOKEN_ENV} rejected (HTTP ${gated.status}) — token drift`,
      );
    } else if (gated.status !== undefined && gated.status < 500) {
      // 2xx/4xx-other means the bearer was accepted (the gate is upstream of
      // routing/validation), so the shared token authenticates.
      token = "ok";
    } else {
      token = "unknown";
    }
  }

  const healthy =
    container === "running" &&
    reachable === "ok" &&
    (token === "ok" || token === "n/a") &&
    imagePresent !== false;

  return {
    service: svc.name,
    port: svc.port,
    container,
    reachable,
    ...(health.status !== undefined ? { httpStatus: health.status } : {}),
    token,
    ...(imagePresent !== undefined ? { imagePresent } : {}),
    healthy,
    issues,
  };
}

/** Probe the full stack. See {@link StatusOptions}. */
export async function stackStatus(
  opts: StatusOptions = {},
): Promise<StackStatus> {
  const env = opts.env ?? process.env;
  const containerState = opts.containerState ?? dockerContainerState;
  const imagePresent = opts.imagePresent ?? imageExists;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const probeHttp =
    opts.probeHttp ?? ((url, token) => fetchProbe(url, token, timeoutMs));
  const token = (opts.readToken ?? (() => readSharedToken(env)))();

  // Probe every service concurrently — they are independent loopback checks.
  const services = await Promise.all(
    MARCH_SERVICES.map((svc) =>
      statusForService(svc, {
        containerState,
        probeHttp,
        imagePresent,
        token,
      }),
    ),
  );

  // Dependency pass: explain a degraded service by naming the unhealthy
  // dependency it relies on. This is informational — the dependency being
  // unhealthy already drags the overall stack to UNHEALTHY on its own.
  const byName = new Map(services.map((s) => [s.service, s]));
  for (const svc of MARCH_SERVICES) {
    if (!svc.dependsOn) continue;
    const status = byName.get(svc.name);
    if (!status) continue;
    for (const dep of svc.dependsOn) {
      const depStatus = byName.get(dep);
      if (depStatus && !depStatus.healthy) {
        status.issues.push(`depends on ${dep}, which is not healthy`);
      }
    }
  }

  return { services, healthy: services.every((s) => s.healthy) };
}

/** Render the stack status as a human-readable table. */
export function formatStatusTable(status: StackStatus): string {
  const lines: string[] = [];
  // Data rows prefix a 2-char status glyph ("✓ "/"✗ "), so the header's SERVICE
  // column is widened by 2 to keep the columns aligned.
  const header = `${"  SERVICE".padEnd(13)}${"CONTAINER".padEnd(10)}${"REACHABLE".padEnd(16)}TOKEN`;
  lines.push(header);
  for (const s of status.services) {
    const reach =
      s.reachable === "ok"
        ? `ok (:${s.port})`
        : s.reachable === "error"
          ? `error (:${s.port})`
          : "unreachable";
    const mark = s.healthy ? "✓" : "✗";
    lines.push(
      `${mark} ${s.service.padEnd(11)}${s.container.padEnd(10)}${reach.padEnd(16)}${s.token}`,
    );
    for (const issue of s.issues) {
      lines.push(`    ⚠ ${issue}`);
    }
  }
  const degraded = status.services.filter((s) => !s.healthy).length;
  lines.push("");
  lines.push(
    status.healthy
      ? `Stack: HEALTHY (${status.services.length}/${status.services.length} services up)`
      : `Stack: UNHEALTHY (${degraded} of ${status.services.length} service(s) degraded)`,
  );
  return lines.join("\n");
}
