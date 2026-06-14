import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { createBroodLogger } from "../../observability/logger.js";
import { getActiveOtel } from "../../observability/otel.js";
import { startBroodHeartbeat } from "../../observability/brood-metrics.js";
import {
  resolveBroodPort,
  resolveBroodStoreBackend,
  resolveReapConfig,
} from "../config.js";
import { registerRoutes } from "./routes.js";
import { startBroodReconciler } from "./reconciler.js";
import {
  createSessionRepository,
  type SessionRepository,
  type SessionRepositoryConfig,
} from "./repository.js";

export interface BuildServerOptions {
  /** Provide a pre-built repository (e.g. an in-memory one) for tests. */
  readonly store?: SessionRepository;
  /** Config for the default repository factory (backend + sqlite options). */
  readonly storeOptions?: SessionRepositoryConfig;
  readonly logger?: FastifyBaseLogger;
}

export interface BroodServer {
  readonly app: FastifyInstance;
  readonly store: SessionRepository;
}

/** Build the Fastify app + session repository. Testable in-process via `app.inject()`. */
export async function buildServer(
  options: BuildServerOptions = {},
): Promise<BroodServer> {
  const logger = options.logger ?? createBroodLogger();
  const store = options.store ?? createSessionRepository(options.storeOptions);
  const app = Fastify({ loggerInstance: logger });
  await registerRoutes(app, { store });
  return { app, store };
}

export interface StartServerOptions {
  readonly port?: number;
  readonly host?: string;
}

/**
 * Boot the brood service and resolve only when it shuts down. This is the
 * `march brood serve` container entrypoint. OTel is initialized by the CLI's
 * runCli wrapper; this owns the graceful flush on SIGTERM/SIGINT.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<void> {
  const port = options.port ?? resolveBroodPort();
  const host = options.host ?? "0.0.0.0";

  const { app, store } = await buildServer({
    storeOptions: { backend: resolveBroodStoreBackend() },
  });
  const stopHeartbeat = startBroodHeartbeat();
  // Periodic reconciliation: always-on read-only divergence gauges (Castra-live
  // vs Brood-tracked), plus the env-gated self-heal reap/adopt loop (OFF by
  // default — armed by MARCH_BROOD_AUTO_REAP / MARCH_BROOD_AUTO_ADOPT).
  const stopReconciler = startBroodReconciler(store, {
    reap: resolveReapConfig(),
    logger: app.log,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "brood service shutting down");
    stopHeartbeat();
    stopReconciler();
    try {
      await app.close();
    } catch {
      // best-effort
    }
    try {
      store.close();
    } catch {
      // best-effort
    }
    try {
      await getActiveOtel().shutdown();
    } catch {
      // telemetry must never fail shutdown
    }
  };

  // Register the completion signal BEFORE listening / installing signal handlers:
  // a SIGTERM that races `app.listen()` could otherwise call `app.close()`
  // before the onClose hook exists, leaving startServer hung.
  const closed = new Promise<void>((resolve) => {
    app.addHook("onClose", async () => {
      resolve();
    });
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host });
  app.log.info({ port, host }, "brood service listening");

  await closed;
}
