import Fastify, { type FastifyInstance } from "fastify";
import type { LoopMeta } from "./meta.js";
import type { LoopSnapshot } from "./runtime.js";

/**
 * HTTP API for the Legate loop service, built on Fastify. The legate-agent (a
 * Claude conductor on the host) calls this to read loop state deterministically
 * rather than scraping logs. Today it exposes read-only liveness/status;
 * deterministic ACTION routes (POST /tick, /dispatch, ...) register the same way
 * (Balexda/March#147). Bind to loopback only — never expose publicly.
 */

export interface LoopHttpContext {
  readonly meta: LoopMeta;
  readonly startedAtMs: number;
  readonly getSnapshot: () => LoopSnapshot;
}

/** Build the /status payload from the latest heartbeat snapshot (pure; testable). */
export function buildStatus(ctx: LoopHttpContext): Record<string, unknown> {
  const snap = ctx.getSnapshot();
  const r: any = snap.lastHeartbeat;
  const ageSeconds =
    snap.lastTickAtMs > 0 ? Math.round((Date.now() - snap.lastTickAtMs) / 100) / 10 : null;
  return {
    ok: true,
    profile: ctx.meta.profile,
    conductor: ctx.meta.paired_legate,
    mode: ctx.meta.mode,
    last_tick_at: r?.ts ?? null,
    last_tick_age_seconds: ageSeconds,
    last_tick_duration_ms: snap.lastTickDurationMs || null,
    queue: {
      dispatchable: r?.dispatchable_count ?? 0,
      blocked: r?.blocked_count ?? 0,
      total: r?.pending_total ?? 0,
    },
    slices: {
      total: r?.slice_count ?? 0,
      archived: r?.archived_slice_count ?? 0,
    },
    workers: r?.workers ?? {},
    counters: {
      cleanup: r?.cleanup_count ?? 0,
      ghost_cleanup: r?.ghost_cleanup_count ?? 0,
      relaunch: r?.relaunch_count ?? 0,
      babysit: r?.babysit_action_count ?? 0,
      dispatch: r?.dispatch_action_count ?? 0,
      dispatch_failure: r?.dispatch_failure_count ?? 0,
    },
    state_present: r?.state_present ?? false,
    state_error: r?.state_error ?? null,
  };
}

/** Build the Fastify app with the loop routes registered. Exported for tests (inject). */
export function buildLoopServer(ctx: LoopHttpContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({
    status: "ok",
    pid: process.pid,
    uptime_seconds: Math.round((Date.now() - ctx.startedAtMs) / 1000),
    profile: ctx.meta.profile,
    conductor: ctx.meta.paired_legate,
  }));

  app.get("/status", async () => buildStatus(ctx));

  return app;
}

/** Start the loop HTTP server on the given port (loopback by default). */
export async function startLoopHttpServer(
  ctx: LoopHttpContext,
  port: number,
  host = "127.0.0.1",
): Promise<FastifyInstance> {
  const app = buildLoopServer(ctx);
  await app.listen({ port, host });
  return app;
}
