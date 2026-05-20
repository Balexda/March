import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerRoutes } from "./routes.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import { BroodConflictError, BroodNotFoundError } from "./teardown.js";
import type { TeardownRequest, TeardownResult } from "./types.js";

const apps: FastifyInstance[] = [];
const stores: SessionStore[] = [];

async function buildApp(teardown?: (
  id: string,
  request: TeardownRequest,
) => Promise<TeardownResult>): Promise<{
  app: FastifyInstance;
  store: SessionStore;
}> {
  const store = new SessionStore({ dbPath: ":memory:" });
  const app = Fastify();
  await registerRoutes(app, { store, teardown });
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

  it("GET /sessions filters by kind/status/parentId", async () => {
    const { app } = await buildApp();
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "spawn-1", kind: "spawn", status: "running" } });
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "steward-1", kind: "steward", parentId: "spawn-1" } });
    const spawns = await app.inject({ method: "GET", url: "/sessions?kind=spawn" });
    expect(spawns.json().sessions.map((s: { id: string }) => s.id)).toEqual(["spawn-1"]);
    const children = await app.inject({ method: "GET", url: "/sessions?parentId=spawn-1" });
    expect(children.json().sessions.map((s: { id: string }) => s.id)).toEqual(["steward-1"]);
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
});
