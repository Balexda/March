import { describe, expect, it } from "vitest";
import {
  buildStatus,
  createRequestListener,
  matchRoute,
  type LoopHttpContext,
} from "./http.js";
import type { LoopMeta } from "./meta.js";
import type { LoopSnapshot } from "./runtime.js";
import http from "node:http";
import { AddressInfo } from "node:net";

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

describe("loop http routes", () => {
  it("matches known routes and rejects unknown ones", () => {
    expect(matchRoute("GET", "/healthz")?.path).toBe("/healthz");
    expect(matchRoute("GET", "/status")?.path).toBe("/status");
    expect(matchRoute("GET", "/nope")).toBeNull();
    expect(matchRoute("POST", "/status")).toBeNull(); // method mismatch
  });

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

  it("serves /healthz 200, /status 200, 404 unknown, 405 wrong method over HTTP", async () => {
    const server = http.createServer(
      createRequestListener(
        ctxWith({ lastHeartbeat: heartbeat, lastTickAtMs: Date.now(), lastTickDurationMs: 1 }),
      ),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe("ok");

      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      expect((await status.json()).queue.dispatchable).toBe(2);

      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/status`, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
