import { initOtel } from "../observability/otel.js";
import { STATIO_SERVICE_NAME, STATIO_TOKEN_ENV, resolveStatioPort } from "./config.js";
import { buildStatioServer } from "./server.js";

export interface RunStatioServerOptions {
  readonly port?: number | string;
  readonly host?: string;
  readonly token?: string;
}

export async function runStatioServer(options: RunStatioServerOptions = {}): Promise<void> {
  if (!process.env.MARCH_OTEL_SERVICE_NAME) {
    process.env.MARCH_OTEL_SERVICE_NAME = STATIO_SERVICE_NAME;
  }
  const otel = initOtel();

  const port = resolveStatioPort(options.port);
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? process.env[STATIO_TOKEN_ENV];
  const app = buildStatioServer({
    token,
    logger: true,
    startedAt: Date.now(),
  });

  if (!token) {
    app.log.warn(
      `${STATIO_TOKEN_ENV} is not set - /v1/* is UNAUTHENTICATED. Set ${STATIO_TOKEN_ENV} ` +
        "and do not publish the port on a public interface.",
    );
  }

  await app.listen({ port, host });
  app.log.info(`statio listening on http://${host}:${port}`);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
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
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  });
}
