import { initOtel, getActiveOtel } from "../../observability/otel.js";
import { initLoopLogs } from "../../observability/logs.js";
import { initLoopSpans } from "../../observability/loop-spans.js";
import { resolveIntervalSeconds } from "./meta.js";
import { ProfileClient } from "../../herald/profiles/client.js";
import {
  configureLoopRuntime,
  getLoopSnapshot,
  startLoopRuntime,
} from "./runtime.js";
import { startLoopHttpServer } from "./http.js";

export const DEFAULT_LOOP_PORT = 8787;

/** OTel/log identity for the single, profile-agnostic legate service. */
export const LEGATE_SERVICE_NAME = "march-legate";

export interface RunLoopOptions {
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
}

function resolvePort(opts: RunLoopOptions, env: NodeJS.ProcessEnv): number {
  const explicit =
    opts.port ?? Number(env.MARCH_LEGATE_PORT ?? env.MARCH_LEGATE_LOOP_PORT);
  return Number.isFinite(explicit) && explicit! > 0 ? Number(explicit) : DEFAULT_LOOP_PORT;
}

/**
 * Reconcile telemetry identity so the SDK comes up correctly. The container sets
 * MARCH_OTEL / MARCH_OTEL_ENDPOINT via compose; here we only default the service
 * name so the "March — Legate" dashboard (which filters `service_name="march-legate"`
 * with profile as a label) comes up populated.
 */
export function reconcileOtelEnv(env: NodeJS.ProcessEnv): void {
  if (!env.MARCH_OTEL_SERVICE_NAME?.trim()) {
    env.MARCH_OTEL_SERVICE_NAME = LEGATE_SERVICE_NAME;
  }
}

/**
 * Run the profile-agnostic Legate service: telemetry + HTTP API + the periodic
 * multi-profile tick. Profiles come from Herald's registry (the source of truth),
 * refreshed each tick; the Herald/Brood/Hatchery/Castra endpoints come from the
 * container env (compose). Resolves only when a shutdown signal flushes telemetry
 * and stops the loop. Used by `march legate serve` inside the managed container.
 */
export async function runLoop(opts: RunLoopOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;

  reconcileOtelEnv(env);
  const otel = initOtel(env);
  // One container, many profiles — the log/span identity is the service, not a
  // single profile (per-profile labels ride the heartbeat metric activity).
  initLoopLogs({ profile: LEGATE_SERVICE_NAME, conductor: LEGATE_SERVICE_NAME });
  initLoopSpans({ profile: LEGATE_SERVICE_NAME });

  const profileClient = new ProfileClient({ env });
  configureLoopRuntime({ profileClient, intervalSeconds: resolveIntervalSeconds(env), env });

  const startedAtMs = Date.now();
  const port = resolvePort(opts, env);
  // In the managed container we must bind 0.0.0.0 so Docker's `-p
  // 127.0.0.1:<hostPort>:<port>` publish (which forwards to the container's
  // eth0, not its loopback) can reach the server; host-side loopback publishing
  // is what keeps it private. On a bare host, default to loopback.
  const host =
    env.MARCH_LEGATE_HOST?.trim() ||
    env.MARCH_LEGATE_LOOP_HOST?.trim() ||
    (env.MARCH_LEGATE_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1");
  const server = await startLoopHttpServer({ startedAtMs, getSnapshot: getLoopSnapshot }, port, host);

  const loop = startLoopRuntime();
  console.log(`March Legate service listening on http://${host}:${port} (profile-agnostic)`);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`March Legate received ${signal}; shutting down`);
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
