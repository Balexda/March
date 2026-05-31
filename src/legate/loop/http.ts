import Fastify, { type FastifyInstance } from "fastify";
import type { LoopSnapshot } from "./runtime.js";

/**
 * HTTP API for the profile-agnostic Legate service, built on Fastify. The
 * legate-agent (a Claude conductor on the host) calls this to read loop state
 * deterministically rather than scraping logs. One container drives N profiles,
 * so `/status?profile=<p>` returns one profile's tick state and bare `/status`
 * returns the per-profile breakdown. Security model: the server binds `0.0.0.0`
 * inside the container so Docker's loopback port publish can reach it; the host
 * publishes only on loopback, so the API is never exposed beyond the host.
 */

export interface LoopHttpContext {
  readonly startedAtMs: number;
  readonly getSnapshot: () => LoopSnapshot;
}

/** Per-profile status from a heartbeat record + tick timing (pure; testable). */
export function statusForRecord(
  r: any,
  tick: { lastTickAtMs: number; lastTickDurationMs: number },
): Record<string, unknown> {
  const ageSeconds =
    tick.lastTickAtMs > 0 ? Math.round((Date.now() - tick.lastTickAtMs) / 100) / 10 : null;
  return {
    last_tick_at: r?.ts ?? null,
    last_tick_age_seconds: ageSeconds,
    last_tick_duration_ms: tick.lastTickDurationMs || null,
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
      steward_nudge: r?.steward_nudge_count ?? 0,
      steward_stranded: r?.steward_stranded_count ?? 0,
      dispatch: r?.dispatch_action_count ?? 0,
      dispatch_failure: r?.dispatch_failure_count ?? 0,
    },
    state_present: r?.state_present ?? false,
    state_error: r?.state_error ?? null,
  };
}

/** Build the /status payload. With `profile`, that profile's status; else all. */
export function buildStatus(ctx: LoopHttpContext, profile?: string): Record<string, unknown> {
  const snap = ctx.getSnapshot();
  const tick = { lastTickAtMs: snap.lastTickAtMs, lastTickDurationMs: snap.lastTickDurationMs };
  if (profile) {
    const entry = snap.byProfile[profile];
    if (!entry) return { ok: false, error: `unknown profile "${profile}".`, profiles: snap.profiles };
    return { ok: true, profile, ...statusForRecord(entry.lastHeartbeat, tick) };
  }
  const byProfile: Record<string, unknown> = {};
  for (const p of snap.profiles) {
    byProfile[p] = statusForRecord(snap.byProfile[p].lastHeartbeat, tick);
  }
  return { ok: true, profiles: snap.profiles, by_profile: byProfile };
}

/** Build the Fastify app with the loop routes registered. Exported for tests (inject). */
export function buildLoopServer(ctx: LoopHttpContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({
    status: "ok",
    pid: process.pid,
    uptime_seconds: Math.round((Date.now() - ctx.startedAtMs) / 1000),
    profiles: ctx.getSnapshot().profiles,
  }));

  app.get("/status", async (request) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const profile =
      typeof query.profile === "string" && query.profile.length > 0 ? query.profile : undefined;
    return buildStatus(ctx, profile);
  });

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
