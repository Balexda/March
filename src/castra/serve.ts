import { createCastraLogger } from "../observability/logger.js";
import { initOtel } from "../observability/otel.js";
import { startCastraHeartbeat } from "./metrics.js";
import { buildServer } from "./server.js";
import {
  CASTRA_SERVICE_NAME,
  CASTRA_TOKEN_ENV,
  resolveCastraPort,
} from "./config.js";

export interface RunCastraServerOptions {
  /** Port to bind; numbers or numeric strings (from the CLI) are accepted. */
  readonly port?: number | string;
  /** Bind address. Defaults to loopback; the container binds 0.0.0.0. */
  readonly host?: string;
  /** Override the bearer token; defaults to the CASTRA_API_TOKEN env var. */
  readonly token?: string;
}

/**
 * Start the Castra service and run until SIGTERM/SIGINT. Resolves once the
 * server has closed and telemetry has flushed. The single shared host owns the
 * one tmux server / agent-deck install for all profiles.
 */
export async function runCastraServer(options: RunCastraServerOptions = {}): Promise<void> {
  // Tag all Castra telemetry as march-castra unless the operator overrode it.
  if (!process.env.MARCH_OTEL_SERVICE_NAME) {
    process.env.MARCH_OTEL_SERVICE_NAME = CASTRA_SERVICE_NAME;
  }
  const otel = initOtel();

  const port = resolveCastraPort(options.port);
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? process.env[CASTRA_TOKEN_ENV];

  // Wire the OTLP pino logger so request logs ship to Loki under
  // service_name=march-castra (mirrors Brood/Hatchery/Herald).
  const app = buildServer({
    token,
    logger: createCastraLogger(),
    startedAt: Date.now(),
  });

  if (!token) {
    app.log.warn(
      `${CASTRA_TOKEN_ENV} is not set — /v1/* is UNAUTHENTICATED. Set ${CASTRA_TOKEN_ENV} ` +
        "and do not publish the port on a public interface.",
    );
  }

  await app.listen({ port, host });
  app.log.info(`castra listening on http://${host}:${port}`);

  // Liveness heartbeat + uptime gauge — gives Castra an UP/down tile like the
  // other services. No-op when telemetry is disabled. Started only AFTER a
  // successful listen() so a bind failure can't leak an unref'd timer emitting
  // false "UP" telemetry (the shutdown path that stops it never runs on throw).
  const stopHeartbeat = startCastraHeartbeat();

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info(`received ${signal}, shutting down`);
      void (async () => {
        try {
          stopHeartbeat();
          await app.close();
        } finally {
          await otel.shutdown();
          resolve();
        }
      })();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
}
