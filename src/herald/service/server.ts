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
import { registerProfileRoutes } from "../profiles/routes.js";
import { ProfileStore } from "../profiles/store.js";
import type {
  ProfileRecord,
  ProfileStoreOptions,
  RegisterProfileInput,
} from "../profiles/types.js";
import { runObservation } from "../observe/observer.js";
import { EventStore } from "./store.js";
import type { EventStoreOptions } from "./types.js";

export interface BuildServerOptions {
  /** Provide a pre-built store (e.g. an in-memory one) for tests. */
  readonly store?: EventStore;
  readonly storeOptions?: EventStoreOptions;
  /** Provide a pre-built profile registry (e.g. an in-memory one) for tests. */
  readonly profileStore?: ProfileStore;
  readonly profileStoreOptions?: ProfileStoreOptions;
  readonly logger?: FastifyBaseLogger;
  /** Server-owned observe-status getter for `/status`. */
  readonly getObserveStatus?: () => ObserveStatus;
}

export interface HeraldServer {
  readonly app: FastifyInstance;
  readonly store: EventStore;
  readonly profileStore: ProfileStore;
}

/** Build the Fastify app + event store + profile registry. Testable via `app.inject()`. */
export async function buildServer(
  options: BuildServerOptions = {},
): Promise<HeraldServer> {
  const logger = options.logger ?? createHeraldLogger();
  const store = options.store ?? new EventStore(options.storeOptions);
  const profileStore =
    options.profileStore ?? new ProfileStore(options.profileStoreOptions);
  const app = Fastify({ loggerInstance: logger });
  await registerRoutes(app, { store, getObserveStatus: options.getObserveStatus });
  await registerProfileRoutes(app, { store: profileStore });
  return { app, store, profileStore };
}

/** The per-profile subset of a legate meta, for seeding the registry. */
function profileInputFromMeta(meta: LoopMeta): RegisterProfileInput {
  return {
    profile: meta.profile,
    repoName: meta.repo.name,
    repoPath: meta.repo.path,
    workerGroup: meta.worker_group,
    conductorName: meta.paired_legate,
    broodEndpoint: meta.brood_endpoint ?? null,
    marchCliPath: meta.march_cli_path ?? null,
    mode: meta.mode,
  };
}

/**
 * Build a minimal {@link LoopMeta}-shaped object from a registry record. The
 * sense I/O only reads `profile`, `repo.path`, and `worker_group`, so this carries
 * exactly those (the rest of LoopMeta is irrelevant to observation).
 */
function metaForProfile(rec: ProfileRecord): LoopMeta {
  return {
    profile: rec.profile,
    repo: { name: rec.repoName, path: rec.repoPath },
    worker_group: rec.workerGroup,
    paired_legate: rec.conductorName ?? rec.profile,
    brood_endpoint: rec.broodEndpoint ?? null,
    march_cli_path: rec.marchCliPath ?? null,
    mode: rec.mode ?? "",
  } as unknown as LoopMeta;
}

/** Resolve the meta path: explicit, else `MARCH_HERALD_META`, else the legate's. */
function resolveMetaPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env.MARCH_HERALD_META?.trim() || env.MARCH_LEGATE_LOOP_META?.trim();
  // Optional now: profiles come from Herald's own registry (populated by
  // `march legate init`). A meta, when present, is only a LEGACY seed used to
  // bootstrap one profile on first boot when the registry is empty.
  return explicit?.trim() || fromEnv || null;
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
  // Meta is optional now: profiles come from Herald's registry. When present it is
  // a LEGACY seed for bootstrapping one profile on first boot.
  const metaPath = resolveMetaPath(options.metaPath);
  const meta = metaPath ? loadMeta(metaPath) : null;
  const intervalMs = (options.intervalSeconds ?? resolveIntervalSeconds()) * 1000;

  const status: { lastObserveAtMs: number | null; lastObserveDurationMs: number | null } = {
    lastObserveAtMs: null,
    lastObserveDurationMs: null,
  };

  const { app, store, profileStore } = await buildServer({
    getObserveStatus: () => status,
    storeOptions: { defaultProfile: meta?.profile },
  });
  // Seed the registry from a legacy single meta so a Herald booted the old way
  // (one MARCH_HERALD_META deployment) auto-populates one profile row. Idempotent
  // and best-effort — a registry that already has profiles is left untouched, and
  // a meta-less boot just relies on `march legate init` to register profiles.
  try {
    if (meta && profileStore.count() === 0) {
      profileStore.register(profileInputFromMeta(meta));
    }
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "herald could not seed the profile registry from meta",
    );
  }
  const stopHeartbeat = startHeraldHeartbeat();

  let ticking = false;
  const observeOnce = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      // Observe every registered profile this tick. Each profile is isolated in
      // its own try/catch so one bad repo (gh outage, missing path) can't stall
      // the others or abort the interval.
      const profiles = profileStore.list();
      let appendedTotal = 0;
      let maxDurationMs = 0;
      const eventsByType: Record<string, number> = {};
      for (const rec of profiles) {
        try {
          const senseDeps = buildObserveSenseDeps(metaForProfile(rec), app);
          const result = await runObservation({ store, senseDeps, profile: rec.profile });
          maxDurationMs = Math.max(maxDurationMs, result.durationMs);
          for (const e of result.appended) eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
          appendedTotal += result.appended.length;
        } catch (err) {
          recordHeraldObserveError();
          app.log.error(
            { profile: rec.profile, err: err instanceof Error ? err.message : String(err) },
            "herald observe tick failed for profile",
          );
        }
      }
      status.lastObserveAtMs = Date.now();
      status.lastObserveDurationMs = maxDurationMs;
      recordHeraldObserve({ durationSeconds: maxDurationMs / 1000, eventsByType });
      if (appendedTotal > 0) {
        app.log.info(
          { count: appendedTotal, profiles: profiles.length, lastSeq: store.lastSeq() },
          "herald observed changes",
        );
      }
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
      profileStore.close();
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
