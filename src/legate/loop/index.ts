import { initOtel, getActiveOtel } from "../../observability/otel.js";
import { initLoopLogs } from "../../observability/logs.js";
import { loadMeta, resolveIntervalSeconds, type LoopMeta } from "./meta.js";
import {
  configureLoopRuntime,
  getLoopSnapshot,
  startLoopRuntime,
} from "./runtime.js";
import { startLoopHttpServer } from "./http.js";

export const DEFAULT_LOOP_PORT = 8787;

export interface RunLoopOptions {
  readonly metaPath?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Resolve the meta path: explicit flag -> env -> cwd/legate-loop-meta.json. */
export function resolveMetaPath(
  opts: { metaPath?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (opts.metaPath && opts.metaPath.trim()) return opts.metaPath.trim();
  if (env.MARCH_LEGATE_LOOP_META?.trim()) return env.MARCH_LEGATE_LOOP_META.trim();
  return `${process.cwd()}/legate-loop-meta.json`;
}

function resolvePort(opts: RunLoopOptions, env: NodeJS.ProcessEnv): number {
  const explicit = opts.port ?? Number(env.MARCH_LEGATE_LOOP_PORT);
  return Number.isFinite(explicit) && explicit! > 0 ? Number(explicit) : DEFAULT_LOOP_PORT;
}

/**
 * Reconcile telemetry config so both signal paths agree: an explicit MARCH_OTEL
 * env wins, otherwise fall back to the meta frozen at `march legate init`. The
 * SDK (metrics + logs) reads env via initOtel; the loop's raw-OTLP dispatch
 * spans read meta.otel — keep them aligned so they're on or off together.
 */
export function reconcileOtelEnv(meta: LoopMeta, env: NodeJS.ProcessEnv): void {
  if (env.MARCH_OTEL == null && meta.otel?.enabled) env.MARCH_OTEL = "1";
  if (!env.MARCH_OTEL_ENDPOINT && !env.OTEL_EXPORTER_OTLP_ENDPOINT && meta.otel?.endpoint) {
    env.MARCH_OTEL_ENDPOINT = meta.otel.endpoint;
  }
  // The loop's identity for traces/metrics/logs. The "March — Legate loop
  // service" dashboard filters `service_name="march-legate"` (profile/conductor
  // are labels), so default to it here rather than relying on the operator —
  // otherwise initOtel falls back to the generic "march" and the dashboard's
  // panels, profile dropdown, and Loki logs panel all come up empty.
  if (!env.MARCH_OTEL_SERVICE_NAME?.trim()) {
    env.MARCH_OTEL_SERVICE_NAME = "march-legate";
  }
}

/**
 * Reconcile the Brood endpoint the same way: an explicit MARCH_BROOD_URL env
 * wins, otherwise fall back to `meta.brood_endpoint` frozen at `march legate
 * init`. The runtime's BroodClient reads MARCH_BROOD_URL, and the managed
 * container does NOT pass it through, so without this the containerized loop
 * would default to localhost:9748 and never reach the Brood service — cleanup /
 * ghost-cleanup would defer forever.
 */
export function reconcileBroodEnv(meta: LoopMeta, env: NodeJS.ProcessEnv): void {
  const frozen = (meta as { brood_endpoint?: unknown }).brood_endpoint;
  if (!env.MARCH_BROOD_URL && typeof frozen === "string" && frozen.trim().length > 0) {
    env.MARCH_BROOD_URL = frozen.trim();
  }
}

/**
 * Run the Legate loop as a long-running service: telemetry + HTTP API + the
 * periodic tick. Resolves only when a shutdown signal flushes telemetry and
 * stops the loop. Used by `march legate loop` inside the managed container.
 */
export async function runLoop(opts: RunLoopOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const metaPath = resolveMetaPath(opts, env);
  const meta = loadMeta(metaPath);

  reconcileOtelEnv(meta, env);
  reconcileBroodEnv(meta, env);
  const otel = initOtel(env);
  initLoopLogs({ profile: meta.profile, conductor: meta.paired_legate });

  configureLoopRuntime(meta, { intervalSeconds: resolveIntervalSeconds(env) });

  const startedAtMs = Date.now();
  const port = resolvePort(opts, env);
  // In the managed container we must bind 0.0.0.0 so Docker's `-p
  // 127.0.0.1:<hostPort>:<port>` publish (which forwards to the container's
  // eth0, not its loopback) can reach the server; host-side loopback publishing
  // is what keeps it private. On a bare host, default to loopback.
  const host =
    env.MARCH_LEGATE_LOOP_HOST?.trim() ||
    (env.MARCH_LEGATE_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1");
  const server = await startLoopHttpServer(
    { meta, startedAtMs, getSnapshot: getLoopSnapshot },
    port,
    host,
  );

  const loop = startLoopRuntime();
  console.log(
    `March Legate loop service listening on http://${host}:${port} ` +
      `(profile=${meta.profile} conductor=${meta.paired_legate})`,
  );

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`March Legate loop received ${signal}; shutting down`);
      loop.stop();
      await server.close();
      await otel.shutdown();
      resolve();
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  });
}

// Keep getActiveOtel reachable for callers/tests that need the live handle.
export { getActiveOtel };
