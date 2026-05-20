import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { createHatcheryLogger } from "../../observability/logger.js";
import { getActiveOtel } from "../../observability/otel.js";
import { startHeartbeat } from "../../observability/hatchery-metrics.js";
import { JobStore, type JobStoreOptions } from "./jobs.js";
import { registerRoutes } from "./routes.js";

export interface BuildServerOptions {
  /** Provide a pre-built store (e.g. with a fake executor) for tests. */
  readonly store?: JobStore;
  readonly jobStoreOptions?: Omit<JobStoreOptions, "logger">;
  readonly logger?: FastifyBaseLogger;
}

export interface HatcheryServer {
  readonly app: FastifyInstance;
  readonly store: JobStore;
}

/** Build the Fastify app + job store. Testable in-process via `app.inject()`. */
export async function buildServer(
  options: BuildServerOptions = {},
): Promise<HatcheryServer> {
  const logger = options.logger ?? createHatcheryLogger();
  const store =
    options.store ??
    new JobStore({ ...options.jobStoreOptions, logger });
  const app = Fastify({ loggerInstance: logger });
  await registerRoutes(app, { store });
  return { app, store };
}

export interface StartServerOptions {
  readonly port?: number;
  readonly host?: string;
}

/**
 * Boot the hatchery service and resolve only when it shuts down. This is the
 * `march hatchery serve` container entrypoint. OTel is initialized by the CLI's
 * runCli wrapper; this owns the graceful flush on SIGTERM/SIGINT.
 */
export async function startServer(options: StartServerOptions = {}): Promise<void> {
  const port =
    options.port ?? Number(process.env.MARCH_HATCHERY_PORT?.trim() || "8080");
  const host = options.host ?? "0.0.0.0";

  const { app, store } = await buildServer();
  store.startReaper();
  const stopHeartbeat = startHeartbeat();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "hatchery service shutting down");
    stopHeartbeat();
    store.stopReaper();
    try {
      await app.close();
    } catch {
      // best-effort
    }
    try {
      await getActiveOtel().shutdown();
    } catch {
      // telemetry must never fail shutdown
    }
  };

  // Register the completion signal BEFORE listening / installing signal
  // handlers: a SIGTERM that races `app.listen()` could otherwise call
  // `app.close()` before the onClose hook exists, leaving startServer hung.
  const closed = new Promise<void>((resolve) => {
    app.addHook("onClose", async () => {
      resolve();
    });
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host });
  app.log.info({ port, host }, "hatchery service listening");

  await closed;
}
