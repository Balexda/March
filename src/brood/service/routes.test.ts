/**
 * @l1 @deterministic @ci
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { getActiveOtel, initOtel } from "../../observability/otel.js";
import { classifyRequestLog, registerRoutes } from "./routes.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import type { CastraStewardGateway, OrphanGate } from "./steward-removal.js";
import { BroodConflictError, BroodNotFoundError } from "./teardown.js";
import type { TeardownRequest, TeardownResult } from "./types.js";

const apps: FastifyInstance[] = [];
const stores: SessionStore[] = [];

async function buildApp(
  teardown?: (id: string, request: TeardownRequest) => Promise<TeardownResult>,
  stewardGateway?: CastraStewardGateway,
  extra: { orphanGate?: OrphanGate; env?: NodeJS.ProcessEnv } = {},
): Promise<{
  app: FastifyInstance;
  store: SessionStore;
}> {
  const store = new SessionStore({ dbPath: ":memory:" });
  const app = Fastify();
  await registerRoutes(app, {
    store,
    teardown,
    stewardGateway,
    orphanGate: extra.orphanGate,
    env: extra.env,
  });
  apps.push(app);
  stores.push(store);
  return { app, store };
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (stores.length) stores.pop()!.close();
});

describe.skipIf(!sqliteAvailable)("brood routes", () => {
  it("GET /healthz returns ok", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz reports dependency presence", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json();
    expect(body).toHaveProperty("docker");
    expect(body).toHaveProperty("git");
    expect(body).toHaveProperty("castra");
  });

  it("POST /sessions registers and returns 201", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "s1",
        kind: "spawn",
        repoPath: "/repo",
        branch: "b",
        worktreePath: "/wt",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "s1", kind: "spawn", status: "created" });
  });

  it("POST /sessions rejects missing id / bad kind with 400", async () => {
    const { app } = await buildApp();
    const noId = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { kind: "spawn" },
    });
    expect(noId.statusCode).toBe(400);
    const badKind = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "x", kind: "wrong" },
    });
    expect(badKind.statusCode).toBe(400);
  });

  it("POST /sessions drops unknown fields and rejects bad paths/branch", async () => {
    const { app } = await buildApp();
    const ok = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", bogus: "x" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).not.toHaveProperty("bogus");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sessions",
          payload: { id: "s2", kind: "spawn", repoPath: "rel/path" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sessions",
          payload: { id: "s3", kind: "spawn", branch: "../evil" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("PATCH /sessions/:id ignores unknown keys", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn" },
    });
    const patched = await app.inject({
      method: "PATCH",
      url: "/sessions/s1",
      payload: { containerId: "c1", bogus: "x" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).not.toHaveProperty("bogus");
    expect(patched.json().containerId).toBe("c1");
  });

  it("register is idempotent (re-POST upserts, still 201)", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", branch: "b" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", containerId: "c1" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ branch: "b", containerId: "c1" });
  });

  it("GET /sessions/:id returns the record or 404", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn" },
    });
    expect((await app.inject({ method: "GET", url: "/sessions/s1" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/sessions/nope" })).statusCode).toBe(404);
  });

  it("GET /sessions/:id/extraction-readiness exposes PR-ready successful extraction metadata", async () => {
    const { app } = await buildApp();
    const extractionResult = {
      spawnId: "s-ready",
      backend: "codex",
      status: "succeeded",
      patch: {
        spawnId: "s-ready",
        backend: "codex",
        patchText: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n",
        touchedPaths: ["a.txt"],
        sha256: "abc123",
      },
      extractedAt: "2026-06-13T00:00:00.000Z",
    };
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s-ready", kind: "spawn", extractionResult },
    });

    const res = await app.inject({
      method: "GET",
      url: "/sessions/s-ready/extraction-readiness",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      spawnId: "s-ready",
      status: "succeeded",
      prReady: true,
      result: extractionResult,
    });
  });

  it("GET /sessions/:id/extraction-readiness exposes failed and missing states as not PR-ready", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "s-failed",
        kind: "spawn",
        extractionResult: {
          spawnId: "s-failed",
          backend: "claude-code",
          status: "failed",
          failureReason: "no-patch-produced",
          diagnostic: "No patch sentinel was present.",
          extractedAt: "2026-06-13T00:00:00.000Z",
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s-missing", kind: "spawn" },
    });

    const failed = await app.inject({
      method: "GET",
      url: "/sessions/s-failed/extraction-readiness",
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      spawnId: "s-failed",
      status: "failed",
      prReady: false,
      result: {
        failureReason: "no-patch-produced",
        diagnostic: "No patch sentinel was present.",
      },
    });
    expect(failed.json().result).not.toHaveProperty("patch");

    const missing = await app.inject({
      method: "GET",
      url: "/sessions/s-missing/extraction-readiness",
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({
      spawnId: "s-missing",
      status: "missing",
      prReady: false,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/sessions/nope/extraction-readiness",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("GET /sessions/:id/extraction-readiness 404s for non-spawn sessions", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "steward-1", kind: "steward" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/sessions/steward-1/extraction-readiness",
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /sessions/:id updates lifecycle, 404 for unknown", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn" },
    });
    const patched = await app.inject({
      method: "PATCH",
      url: "/sessions/s1",
      payload: { status: "running", containerId: "c1" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ status: "running", containerId: "c1" });
    expect(
      (await app.inject({ method: "PATCH", url: "/sessions/nope", payload: {} })).statusCode,
    ).toBe(404);
  });

  it("GET /sessions filters by kind/status/parentId", async () => {
    const { app } = await buildApp();
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "spawn-1", kind: "spawn", status: "running" } });
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "steward-1", kind: "steward", parentId: "spawn-1" } });
    const spawns = await app.inject({ method: "GET", url: "/sessions?kind=spawn" });
    expect(spawns.json().sessions.map((s: { id: string }) => s.id)).toEqual(["spawn-1"]);
    const children = await app.inject({ method: "GET", url: "/sessions?parentId=spawn-1" });
    expect(children.json().sessions.map((s: { id: string }) => s.id)).toEqual(["steward-1"]);
  });

  it("POST /sessions emits a brood.register span nested under the inbound traceparent", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const created: Span[] = [];
    const tracer = getActiveOtel().getTracer();
    const real = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, "startSpan").mockImplementation(
      (...args: Parameters<typeof real>) => {
        const span = real(...args) as Span;
        created.push(span);
        return span;
      },
    );
    try {
      const { app } = await buildApp();
      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const spanId = "b7ad6b7169203331";
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { traceparent: `00-${traceId}-${spanId}-01` },
        payload: { id: "s1", kind: "spawn", worktreePath: "/wt/s1" },
      });
      expect(res.statusCode).toBe(201);

      const span = created.find((s) => s.name === "brood.register");
      expect(span).toBeDefined();
      // Nests under the caller's trace (issue #233 acceptance criterion).
      expect(span!.spanContext().traceId).toBe(traceId);
      expect(span!.parentSpanContext?.spanId).toBe(spanId);
      expect(span!.attributes).toMatchObject({
        "march.session.id": "s1",
        "march.session.kind": "spawn",
        "march.spawn.id": "s1",
        "march.worktree.path": "/wt/s1",
      });
    } finally {
      vi.restoreAllMocks();
      initOtel({});
    }
  });

  it("POST /sessions/:id/teardown returns the result and maps errors", async () => {
    const okResult: TeardownResult = {
      id: "s1",
      status: "torndown",
      steps: [{ step: "container", outcome: "ok" }],
      warnings: [],
    };
    const { app } = await buildApp(async (id) => {
      if (id === "missing") throw new BroodNotFoundError("no");
      if (id === "live") throw new BroodConflictError("running");
      return okResult;
    });
    const ok = await app.inject({ method: "POST", url: "/sessions/s1/teardown", payload: { force: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(okResult);
    expect((await app.inject({ method: "POST", url: "/sessions/missing/teardown", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/sessions/live/teardown", payload: {} })).statusCode).toBe(409);
  });

  it("POST /admin/sweep 404s when MARCH_BROOD_ADMIN_TOKEN is unset (#304)", async () => {
    const { app } = await buildApp(undefined, undefined, { env: {} });
    const res = await app.inject({ method: "POST", url: "/admin/sweep" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/sweep 401s on a missing/wrong bearer token (#304)", async () => {
    const { app } = await buildApp(undefined, undefined, {
      env: { MARCH_BROOD_ADMIN_TOKEN: "s3cret" },
    });
    expect(
      (await app.inject({ method: "POST", url: "/admin/sweep" })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/sweep",
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("POST /admin/sweep reaps orphan stewards when authorized (#304)", async () => {
    const removed: string[] = [];
    const gateway: CastraStewardGateway = {
      async listSessions() {
        return [
          {
            sessionId: "leaked",
            title: "",
            group: "",
            branch: "feature/x",
            worktreePath: "/wt/gone",
            createdAt: "",
            status: "waiting",
          },
        ];
      },
      async removeSession({ sessionId }) {
        removed.push(sessionId);
        return { removed: true };
      },
    };
    // Orphan gate: the leaked session's worktree is gone on disk → work done.
    const orphanGate: OrphanGate = {
      worktreeExists: (p) => p !== "/wt/gone",
      branchPrState: async () => "unknown",
    };
    const { app, store } = await buildApp(undefined, gateway, {
      orphanGate,
      env: { MARCH_BROOD_ADMIN_TOKEN: "s3cret" },
    });
    // A torndown row makes the `smithy` profile known so the sweep scans it.
    store.register({
      id: "steward-old",
      kind: "steward",
      agentDeckSessionId: "steward-old",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/d4143794",
      status: "torndown",
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/sweep",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reaped.map((r: { sessionId: string }) => r.sessionId)).toEqual([
      "leaked",
    ]);
    expect(removed).toEqual(["leaked"]);
  });

  it("POST /admin/sweep stays conservative — skips open-PR orphans, never adopts (#304)", async () => {
    const removed: string[] = [];
    const gateway: CastraStewardGateway = {
      async listSessions() {
        return [
          {
            sessionId: "live",
            title: "",
            group: "",
            branch: "feature/open",
            worktreePath: "/wt/new",
            createdAt: "",
            status: "waiting",
          },
        ];
      },
      async removeSession({ sessionId }) {
        removed.push(sessionId);
        return { removed: true };
      },
    };
    // The branch has an OPEN PR — the manual sweep must leave it (no adoption).
    const orphanGate: OrphanGate = {
      worktreeExists: () => true,
      branchPrState: async () => "open",
    };
    const { app, store } = await buildApp(undefined, gateway, {
      orphanGate,
      env: { MARCH_BROOD_ADMIN_TOKEN: "s3cret" },
    });
    store.register({
      id: "steward-old",
      kind: "steward",
      agentDeckSessionId: "steward-old",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      status: "torndown",
    });

    const res = await app.inject({
      method: "POST",
      url: "/admin/sweep",
      headers: { authorization: "Bearer s3cret" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reaped).toEqual([]);
    expect(body.adopted).toEqual([]); // manual sweep never adopts
    expect(body.skipped.map((s: { reason: string }) => s.reason)).toContain("open-pr");
    expect(removed).toEqual([]);
    // The live session must NOT have been registered into Brood by the sweep.
    expect(store.get("live")).toBeUndefined();
  });
});

describe("classifyRequestLog", () => {
  it("returns null for a 2xx/3xx (no error log)", () => {
    expect(classifyRequestLog(200, "/sessions", "POST", 12)).toBeNull();
    expect(classifyRequestLog(201, "/sessions", "POST", 12)).toBeNull();
    expect(classifyRequestLog(304, "/x", "GET", 1)).toBeNull();
  });

  it("logs 5xx at error and 4xx at warn, with route/method/status/duration", () => {
    const e = classifyRequestLog(500, "/sessions/:id/teardown", "POST", 42.7, '{"error":"boom"}');
    expect(e).toMatchObject({
      level: "error",
      fields: { route: "/sessions/:id/teardown", method: "POST", status_code: 500, duration_ms: 43, detail: '{"error":"boom"}' },
    });
    expect(e!.msg).toContain("500");
    const w = classifyRequestLog(404, "/sessions/:id", "GET", 3);
    expect(w!.level).toBe("warn");
    expect(w!.fields).not.toHaveProperty("detail"); // no body captured → no detail
  });

  it("truncates a long detail payload to 500 chars", () => {
    const big = "x".repeat(900);
    const e = classifyRequestLog(500, "/x", "POST", 1, big);
    expect((e!.fields.detail as string).length).toBe(500);
  });
});
