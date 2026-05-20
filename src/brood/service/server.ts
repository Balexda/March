import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { createBroodLogger } from "../../observability/logger.js";
import { getActiveOtel } from "../../observability/otel.js";
import { startBroodHeartbeat } from "../../observability/brood-metrics.js";
import { resolveBroodPort } from "../config.js";
import { registerRoutes } from "./routes.js";
import { SessionStore, type SessionStoreOptions } from "./store.js";

export interface BuildServerOptions {
  /** Provide a pre-built store (e.g. an in-memory one) for tests. */
  readonly store?: SessionStore;
  readonly storeOptions?: SessionStoreOptions;
  readonly logger?: FastifyBaseLogger;
}

export interface BroodServer {
  readonly app: FastifyInstance;
  readonly store: SessionStore;
}

/** Build the Fastify app + session store. Testable in-process via `app.inject()`. */
export async function buildServer(
  options: BuildServerOptions = {},
): Promise<BroodServer> {
  const logger = options.logger ?? createBroodLogger();
  const store = options.store ?? new SessionStore(options.storeOptions);
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

  const { app, store } = await buildServer();
  const stopHeartbeat = startBroodHeartbeat();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "brood service shutting down");
    stopHeartbeat();
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
