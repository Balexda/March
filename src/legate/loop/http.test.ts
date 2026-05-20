import { describe, expect, it } from "vitest";
import { buildLoopServer, buildStatus, type LoopHttpContext } from "./http.js";
import type { LoopMeta } from "./meta.js";
import type { LoopSnapshot } from "./runtime.js";

const meta = {
  profile: "smithy",
  paired_legate: "demo-legate",
  mode: "terminal-pr-maintenance",
} as unknown as LoopMeta;

function ctxWith(snapshot: LoopSnapshot): LoopHttpContext {
  return { meta, startedAtMs: Date.now() - 5000, getSnapshot: () => snapshot };
}

const heartbeat = {
  ts: "2026-05-19T00:00:00.000Z",
  slice_count: 4,
  archived_slice_count: 2,
  workers: { running: 1, idle: 2, error: 0 },
  cleanup_count: 1,
  ghost_cleanup_count: 0,
  relaunch_count: 0,
  babysit_action_count: 3,
  dispatch_action_count: 2,
  dispatch_failure_count: 1,
  dispatchable_count: 2,
  blocked_count: 1,
  pending_total: 5,
  state_present: true,
  state_error: null,
};

describe("loop http (fastify)", () => {
  it("builds a /status payload from the latest heartbeat", () => {
    const status = buildStatus(
      ctxWith({ lastHeartbeat: heartbeat, lastTickAtMs: Date.now(), lastTickDurationMs: 420 }),
    );
    expect(status).toMatchObject({
      ok: true,
      profile: "smithy",
      conductor: "demo-legate",
      queue: { dispatchable: 2, blocked: 1, total: 5 },
      slices: { total: 4, archived: 2 },
      last_tick_duration_ms: 420,
      counters: { dispatch: 2, dispatch_failure: 1, babysit: 3, cleanup: 1 },
      state_present: true,
    });
  });

  it("returns safe defaults before the first tick", () => {
    const status = buildStatus(
      ctxWith({ lastHeartbeat: null, lastTickAtMs: 0, lastTickDurationMs: 0 }),
    );
    expect(status).toMatchObject({
      queue: { dispatchable: 0, blocked: 0, total: 0 },
      last_tick_at: null,
      last_tick_age_seconds: null,
    });
  });

  it("serves /healthz and /status, 404 for unknown routes", async () => {
    const app = buildLoopServer(
      ctxWith({ lastHeartbeat: heartbeat, lastTickAtMs: Date.now(), lastTickDurationMs: 1 }),
    );
    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe("ok");

      const status = await app.inject({ method: "GET", url: "/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json().queue.dispatchable).toBe(2);

      const missing = await app.inject({ method: "GET", url: "/nope" });
      expect(missing.statusCode).toBe(404);

      const wrongMethod = await app.inject({ method: "POST", url: "/status" });
      expect(wrongMethod.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
