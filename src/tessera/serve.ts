import { createServiceLogger, resolveServiceLogFilePath } from "../observability/logger.js";
import { initOtel } from "../observability/otel.js";
import { emitTesseraSpan } from "../observability/tessera-trace.js";
import { loadTesseraAuthorization } from "./authorization.js";
import { loadTesseraAppConfig, resolveTesseraPort, TESSERA_SERVICE_NAME } from "./config.js";
import { GithubAppProvider } from "./github-app.js";
import type { CredentialProvider, TesseraErrorCode } from "./models.js";
import { OperatorTokenProvider, OperatorTokenSource } from "./operator-token.js";
import { buildTesseraServer } from "./server.js";

export interface RunTesseraServerOptions {
  readonly port?: number | string;
  readonly host?: string;
}

/** Env var naming the operator-token file (interim credential while no GitHub App is configured). */
export const TESSERA_GITHUB_TOKEN_FILE = "TESSERA_GITHUB_TOKEN_FILE";

/**
 * Pick the providers for the two slots. `app`: the GitHub App when its id and
 * key are configured (the goal), else the operator token when
 * `TESSERA_GITHUB_TOKEN_FILE` is set, else unconfigured. `user`: the operator
 * token when set (it IS the operator's user credential), else unconfigured.
 */
export function selectTesseraProviders(
  config: { appId?: string; privateKey?: string; installationId?: number },
  env: NodeJS.ProcessEnv,
  onDiscoveryError?: (code: TesseraErrorCode) => void,
  fetchImpl?: typeof fetch,
): CredentialProvider[] {
  const tokenFile = env[TESSERA_GITHUB_TOKEN_FILE]?.trim();
  const source = tokenFile ? new OperatorTokenSource({ tokenFile, fetchImpl }) : undefined;
  const providers: CredentialProvider[] = [];
  if ((config.appId && config.privateKey) || !source) {
    providers.push(new GithubAppProvider({ ...config, fetchImpl, onDiscoveryError }));
  } else {
    providers.push(new OperatorTokenProvider("app", source));
  }
  if (source) providers.push(new OperatorTokenProvider("user", source));
  return providers;
}

export async function runTesseraServer(options: RunTesseraServerOptions = {}): Promise<void> {
  const port = resolveTesseraPort(options.port);
  const authorize = await loadTesseraAuthorization();
  const config = await loadTesseraAppConfig();
  process.env.MARCH_OTEL_SERVICE_NAME ||= TESSERA_SERVICE_NAME;
  const otel = initOtel();
  let stopping = false;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const shutdown = () => { stopping = true; stop(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  let app: ReturnType<typeof buildTesseraServer> | undefined;
  try {
    const logger = createServiceLogger({
      serviceName: TESSERA_SERVICE_NAME,
      logFilePath: resolveServiceLogFilePath("tessera.jsonl", "MARCH_TESSERA_LOG_DIR"),
    });
    const providers = selectTesseraProviders(config, process.env, (code) => {
      emitTesseraSpan("tessera.discovery", { error: true, attributes: { provider: "github-app", outcome: code } });
      logger.warn({ provider: "github-app", outcome: code }, "Tessera identity discovery failed");
    });
    await Promise.all(providers.map((provider) => provider.start()));
    if (stopping) return;
    app = buildTesseraServer({ providers, authorize, logger });
    await app.listen({ host: options.host ?? "127.0.0.1", port });
    app.log.info("Tessera listening");
    await stopped;
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    try { await app?.close(); } finally { await otel.shutdown(); }
  }
}
