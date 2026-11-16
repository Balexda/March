import type { FastifyBaseLogger } from "fastify";
import { createTesseraLogger } from "../observability/logger.js";
import { initOtel } from "../observability/otel.js";
import { loadClientRegistry } from "./auth/client-keys.js";
import { loadPolicy } from "./auth/policy.js";
import {
  TESSERA_CLIENT_KEYS_FILE_ENV,
  TESSERA_GITHUB_APP_ID_ENV,
  TESSERA_GITHUB_APP_KEY_FILE_ENV,
  TESSERA_GITHUB_INSTALLATION_ID_ENV,
  TESSERA_SERVICE_NAME,
  resolveGitHubAppConfig,
  resolveTesseraPort,
} from "./config.js";
import { GitHubClient } from "./providers/github-app/github-client.js";
import { createGitHubAppProvider } from "./providers/github-app/provider.js";
import { buildTesseraServer, createProviderRegistry } from "./server.js";
import type { CredentialProvider } from "./types.js";

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
  /**
   * GitHub client for the github-app provider (tests point it at a fake
   * GitHub API); defaults to a bounded client against the public API. Not
   * exposed as a setting.
   */
  readonly githubClient?: GitHubClient;
}

/**
 * Run the Tessera HTTP service until SIGTERM/SIGINT. Port validation, the
 * client-keys load (`TESSERA_CLIENT_KEYS_FILE`), the policy load
 * (`TESSERA_POLICY_FILE`, validated against the registered clients) and config
 * resolution happen before telemetry starts, the server is built, or any
 * provider contacts GitHub, so an invalid port or a missing/invalid
 * client-keys or policy file fails with a `TesseraValidationError` and nothing
 * listens. The port is checked first, then the client keys, then the policy.
 */
export async function runTesseraServer(options: RunTesseraServerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const port = resolveTesseraPort(options.port, env);
  const host = options.host ?? "127.0.0.1";
  const clients = loadClientRegistry(env);
  const policy = loadPolicy(clients.clients(), env);
  const appConfig = resolveGitHubAppConfig(env);

  if (!env.MARCH_OTEL_SERVICE_NAME) {
    env.MARCH_OTEL_SERVICE_NAME = TESSERA_SERVICE_NAME;
  }
  const otel = initOtel(env);

  const providers: CredentialProvider[] = appConfig.configured
    ? [createGitHubAppProvider({ config: appConfig, client: options.githubClient ?? new GitHubClient() })]
    : [];
  const app = buildTesseraServer({
    registry: createProviderRegistry(providers),
    clients,
    policy,
    logger: options.logger ?? createTesseraLogger({ env }),
    startedAt: Date.now(),
  });

  // Log setting names only - never the app id, key path, or key contents, and
  // never the client-keys file path or any of its hashes.
  app.log.info(
    `client keys loaded from ${TESSERA_CLIENT_KEYS_FILE_ENV}: ${clients.size} registered ` +
      `client${clients.size === 1 ? "" : "s"}`,
  );
  if (appConfig.configured) {
    const settings = [TESSERA_GITHUB_APP_ID_ENV, TESSERA_GITHUB_APP_KEY_FILE_ENV];
    if (appConfig.installationId !== undefined) settings.push(TESSERA_GITHUB_INSTALLATION_ID_ENV);
    app.log.info(
      `GitHub App provider configured (${settings.join(", ")}); ` +
        "app token requests mint downscoped installation tokens",
    );
  } else {
    app.log.warn(
      `GitHub App provider not configured (missing: ${appConfig.missing.join(", ")}); ` +
        "app token requests will fail with provider_unconfigured",
    );
  }

  // start() never throws: a GitHub outage at startup leaves the provider
  // degraded (it retries on a later request) and the service still serves.
  for (const provider of providers) {
    await provider.start();
    const status = provider.status();
    const detail = status.last_error === null ? "" : ` (last_error: ${status.last_error})`;
    app.log[status.state === "ok" ? "info" : "warn"](
      `${provider.id} provider state: ${status.state}${detail}`,
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
