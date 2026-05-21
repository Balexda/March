import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { createHeraldLogger } from "../../observability/logger.js";
import { getActiveOtel } from "../../observability/otel.js";
import {
  recordHeraldObserve,
  recordHeraldObserveError,
  startHeraldHeartbeat,
} from "../../observability/herald-metrics.js";
import { buildSenseIo } from "../../observe/sense-io.js";
import { loadMeta, resolveIntervalSeconds, type LoopMeta } from "../../legate/loop/meta.js";
import type { SenseDeps } from "../../legate/loop/state/sense.js";
import { resolveHeraldPort } from "../config.js";
import { registerRoutes, type ObserveStatus } from "./routes.js";
import { runObservation } from "../observe/observer.js";
import { EventStore } from "./store.js";
import type { EventStoreOptions } from "./types.js";

export interface BuildServerOptions {
  /** Provide a pre-built store (e.g. an in-memory one) for tests. */
  readonly store?: EventStore;
  readonly storeOptions?: EventStoreOptions;
  readonly logger?: FastifyBaseLogger;
  /** Server-owned observe-status getter for `/status`. */
  readonly getObserveStatus?: () => ObserveStatus;
}

export interface HeraldServer {
  readonly app: FastifyInstance;
  readonly store: EventStore;
}

/** Build the Fastify app + event store. Testable in-process via `app.inject()`. */
export async function buildServer(
  options: BuildServerOptions = {},
): Promise<HeraldServer> {
  const logger = options.logger ?? createHeraldLogger();
  const store = options.store ?? new EventStore(options.storeOptions);
  const app = Fastify({ loggerInstance: logger });
  await registerRoutes(app, { store, getObserveStatus: options.getObserveStatus });
  return { app, store };
}

/** Resolve the meta path: explicit, else `MARCH_HERALD_META`, else the legate's. */
function resolveMetaPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.MARCH_HERALD_META?.trim() || env.MARCH_LEGATE_LOOP_META?.trim();
  const metaPath = explicit?.trim() || fromEnv;
  if (!metaPath) {
    throw new Error(
      "Herald meta not found. Pass --meta, set MARCH_HERALD_META, or set " +
        "MARCH_LEGATE_LOOP_META (Herald observes the same deployment as the legate).",
    );
  }
  return metaPath;
}

/** True when Herald owns the default-branch git sync (PR1 default: off/read-only). */
function syncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARCH_HERALD_SYNC ?? "").trim() === "1";
}

/** Build the observe sense deps; in read-only mode the git sync is a no-op. */
function buildObserveSenseDeps(meta: LoopMeta, app: FastifyInstance): SenseDeps {
  const deps = buildSenseIo({
    meta,
    warn: (message: string) => app.log.warn({ component: "observe" }, message),
  });
  if (syncEnabled()) return deps;
  // Read-only: never run `git fetch/switch/pull` (it must not fight a still-
  // polling legate). Smithy is read against the local repo as-is.
  return { ...deps, syncDefaultBranch: async () => {} };
}

export interface StartServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Path to the meta JSON (else MARCH_HERALD_META / MARCH_LEGATE_LOOP_META). */
  readonly metaPath?: string;
  /** Observe interval seconds (else MARCH_LEGATE_LOOP_INTERVAL_SECONDS, def 60). */
  readonly intervalSeconds?: number;
}

/**
 * Boot the herald service and resolve only when it shuts down. This is the
 * `march herald serve` container entrypoint: it serves the HTTP API and drives
 * the observe loop. OTel is initialized by the CLI's runCli wrapper; this owns
 * the graceful flush on SIGTERM/SIGINT.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<void> {
  const port = resolveHeraldPort(options.port);
  const host = options.host ?? "0.0.0.0";
  const meta = loadMeta(resolveMetaPath(options.metaPath));
  const intervalMs = (options.intervalSeconds ?? resolveIntervalSeconds()) * 1000;

  const status: { lastObserveAtMs: number | null; lastObserveDurationMs: number | null } = {
    lastObserveAtMs: null,
    lastObserveDurationMs: null,
  };

  const { app, store } = await buildServer({ getObserveStatus: () => status });
  const senseDeps = buildObserveSenseDeps(meta, app);
  const stopHeartbeat = startHeraldHeartbeat();

  let ticking = false;
  const observeOnce = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const result = await runObservation({ store, senseDeps });
      status.lastObserveAtMs = Date.now();
      status.lastObserveDurationMs = result.durationMs;
      const eventsByType: Record<string, number> = {};
      for (const e of result.appended) eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
      recordHeraldObserve({ durationSeconds: result.durationMs / 1000, eventsByType });
      if (result.appended.length > 0) {
        app.log.info({ count: result.appended.length, lastSeq: store.lastSeq() }, "herald observed changes");
      }
    } catch (err) {
      recordHeraldObserveError();
      app.log.error({ err: err instanceof Error ? err.message : String(err) }, "herald observe tick failed");
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void observeOnce(), intervalMs);
  timer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "herald service shutting down");
    clearInterval(timer);
    stopHeartbeat();
    try {
      store.writeSnapshot();
    } catch {
      // best-effort
    }
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

  // Register the completion signal BEFORE listening / installing signal handlers.
  const closed = new Promise<void>((resolve) => {
    app.addHook("onClose", async () => {
      resolve();
    });
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host });
  app.log.info({ port, host, intervalMs, sync: syncEnabled() }, "herald service listening");

  // Kick an immediate observation so the log/projection populate without waiting
  // a full interval.
  void observeOnce();

  await closed;
}
