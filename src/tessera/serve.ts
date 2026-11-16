import type { FastifyBaseLogger } from "fastify";
import { createTesseraLogger } from "../observability/logger.js";
import { initOtel } from "../observability/otel.js";
import {
  TESSERA_SERVICE_NAME,
  resolveGitHubAppConfig,
  resolveTesseraPort,
} from "./config.js";
import { buildTesseraServer, createProviderRegistry } from "./server.js";

/** The subset of an event emitter the entrypoint needs to await a stop signal. */
export interface ShutdownSignalSource {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface RunTesseraServerOptions {
  readonly port?: number | string;
  readonly host?: string;
  /** Environment for config + telemetry; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override the service logger (tests); defaults to the Tessera file + OTLP logger. */
  readonly logger?: FastifyBaseLogger;
  /** Where termination signals arrive; defaults to `process`. */
  readonly signals?: ShutdownSignalSource;
}

/**
 * Run the Tessera HTTP service until SIGTERM/SIGINT. Port validation and
 * config resolution happen before the server is built, so an invalid port
 * fails with a `TesseraValidationError` and nothing listens.
 */
export async function runTesseraServer(options: RunTesseraServerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const port = resolveTesseraPort(options.port, env);
  const host = options.host ?? "127.0.0.1";
  const appConfig = resolveGitHubAppConfig(env);

  if (!env.MARCH_OTEL_SERVICE_NAME) {
    env.MARCH_OTEL_SERVICE_NAME = TESSERA_SERVICE_NAME;
  }
  const otel = initOtel(env);

  // No provider implementation exists yet (the github-app provider lands in a
  // later slice), so every identity answers provider_unconfigured.
  const app = buildTesseraServer({
    registry: createProviderRegistry([]),
    logger: options.logger ?? createTesseraLogger({ env }),
    startedAt: Date.now(),
  });

  // Log setting names only - never the app id, key path, or key contents.
  if (appConfig.configured) {
    app.log.info("GitHub App settings present; the app provider is not available in this build");
  } else {
    app.log.warn(
      `GitHub App provider not configured (missing: ${appConfig.missing.join(", ")}); ` +
        "app token requests will fail with provider_unconfigured",
    );
  }

  await app.listen({ port, host });
  app.log.info(`tessera listening on http://${host}:${port}`);

  const signals = options.signals ?? process;
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      signals.removeListener("SIGTERM", onTerm);
      signals.removeListener("SIGINT", onInt);
      app.log.info(`received ${signal}, shutting down`);
      void (async () => {
        try {
          await app.close();
        } finally {
          await otel.shutdown();
          resolve();
        }
      })();
    };
    const onTerm = () => shutdown("SIGTERM");
    const onInt = () => shutdown("SIGINT");
    signals.once("SIGTERM", onTerm);
    signals.once("SIGINT", onInt);
  });
}
