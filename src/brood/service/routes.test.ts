import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { getActiveOtel, initOtel } from "../../observability/otel.js";
import { registerRoutes } from "./routes.js";
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

  it("PATCH /sessions/:id accepts bounded extractionResult and rejects malformed values", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn" },
    });
    const ok = await app.inject({
      method: "PATCH",
      url: "/sessions/s1",
      payload: {
        extractionResult: {
          status: "failed",
          spawnId: "s1",
          backend: "codex",
          failureReason: "malformed-output",
          diagnostic: "bad json",
          extractedAt: "2026-06-13T00:00:00.000Z",
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().extractionResult).toMatchObject({
      status: "failed",
      failureReason: "malformed-output",
    });

    const bad = await app.inject({
      method: "PATCH",
      url: "/sessions/s1",
      payload: {
        extractionResult: {
          status: "failed",
          spawnId: "s1",
          backend: "codex",
          failureReason: "malformed-output",
          diagnostic: "x".repeat(2001),
          extractedAt: "2026-06-13T00:00:00.000Z",
        },
      },
    });
    expect(bad.statusCode).toBe(400);
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
});
