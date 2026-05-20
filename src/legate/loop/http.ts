import http from "node:http";
import type { LoopMeta } from "./meta.js";
import type { LoopSnapshot } from "./runtime.js";

/**
 * HTTP API for the Legate loop service. The legate-agent (a Claude conductor on
 * the host) calls this to read loop state deterministically rather than scraping
 * logs. PR1 exposes read-only liveness/status; the route table is structured so
 * deterministic ACTION endpoints (POST /tick, /dispatch, ...) can be added later
 * (Balexda/March#147). Bind to loopback only — never expose publicly.
 */

export interface LoopHttpContext {
  readonly meta: LoopMeta;
  readonly startedAtMs: number;
  readonly getSnapshot: () => LoopSnapshot;
}

type Handler = (ctx: LoopHttpContext) => { status: number; body: unknown };

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler;
}

export const ROUTES: Route[] = [
  { method: "GET", path: "/healthz", handler: healthz },
  { method: "GET", path: "/status", handler: status },
];

function healthz(ctx: LoopHttpContext): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      status: "ok",
      pid: process.pid,
      uptime_seconds: Math.round((Date.now() - ctx.startedAtMs) / 1000),
      profile: ctx.meta.profile,
      conductor: ctx.meta.paired_legate,
    },
  };
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

function status(ctx: LoopHttpContext): { status: number; body: unknown } {
  return { status: 200, body: buildStatus(ctx) };
}

/** Match a method+path against the route table; null when nothing matches. */
export function matchRoute(method: string, pathname: string): Route | null {
  return (
    ROUTES.find((r) => r.method === method && r.path === pathname) ?? null
  );
}

/** Returns true if any route exists for the path (drives 404 vs 405). */
function pathExists(pathname: string): boolean {
  return ROUTES.some((r) => r.path === pathname);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Build the request listener for the loop API. Exported for tests. */
export function createRequestListener(
  ctx: LoopHttpContext,
): http.RequestListener {
  return (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const pathname = (req.url || "/").split("?")[0]!;
    const route = matchRoute(method, pathname);
    if (route) {
      try {
        const { status: code, body } = route.handler(ctx);
        send(res, code, body);
      } catch (err) {
        send(res, 500, { error: (err as Error).message });
      }
      return;
    }
    if (pathExists(pathname)) {
      send(res, 405, { error: "method not allowed", path: pathname });
      return;
    }
    send(res, 404, { error: "not found", path: pathname });
  };
}

/** Start the loop HTTP server on the given port (loopback by default). */
export function startLoopHttpServer(
  ctx: LoopHttpContext,
  port: number,
  host = "127.0.0.1",
): http.Server {
  const server = http.createServer(createRequestListener(ctx));
  server.listen(port, host);
  return server;
}
