import { createServiceLogger, resolveServiceLogFilePath } from "../observability/logger.js";
import { initOtel } from "../observability/otel.js";
import { emitTesseraSpan } from "../observability/tessera-trace.js";
import { loadTesseraAppConfig, resolveTesseraPort, TESSERA_SERVICE_NAME } from "./config.js";
import { GithubAppProvider } from "./github-app.js";
import { buildTesseraServer } from "./server.js";

export interface RunTesseraServerOptions {
  readonly port?: number | string;
  readonly host?: string;
}

export async function runTesseraServer(options: RunTesseraServerOptions = {}): Promise<void> {
  const port = resolveTesseraPort(options.port);
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
    const provider = new GithubAppProvider({ ...config, onDiscoveryError: (code) => {
      emitTesseraSpan("tessera.discovery", { error: true, attributes: { provider: "github-app", outcome: code } });
      logger.warn({ provider: "github-app", outcome: code }, "Tessera identity discovery failed");
    } });
    await provider.start();
    if (stopping) return;
    app = buildTesseraServer({ providers: [provider], logger });
    await app.listen({ host: options.host ?? "127.0.0.1", port });
    app.log.info("Tessera listening; production issuance requires US2 authorization");
    await stopped;
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    try { await app?.close(); } finally { await otel.shutdown(); }
  }
}
