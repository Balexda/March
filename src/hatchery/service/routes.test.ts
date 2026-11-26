/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { JobStore } from "./jobs.js";
import { validateSpawnRequest, type ReadinessProbes } from "./routes.js";
import type { FastifyInstance } from "fastify";
import type { HatcherySpawnResult } from "../spawn-handoff.js";

function fakeResult(): HatcherySpawnResult {
  return {
    spawnId: "spawn-1",
    backend: "codex",
    branch: "march/spawn/spawn-1",
    managerSession: {
      sessionId: "s",
      title: "t",
      group: "g",
      branch: "march/spawn/spawn-1",
      worktreePath: "/repo/wt",
    },
    artifacts: {
      dir: "/l",
      spawnOutputPath: "/l/o",
      patchPath: "/l/p",
      managerPromptPath: "/l/m",
      metadataPath: "/l/j",
    },
    application: { spawnId: "spawn-1", status: "applied", touchedPaths: ["f"] },
    commit: { spawnId: "spawn-1", branch: "recorded", commitSha: "abc", patchSha256: "def", committedAt: "2026-01-01T00:00:00Z" },
    exitCode: 0,
    summary: "ok",
  };
}

async function makeApp(
  readiness?: ReadinessProbes,
  store: JobStore = new JobStore({ executor: async () => fakeResult() }),
): Promise<FastifyInstance> {
  // Silent logger to avoid noisy/file output in tests.
  const logger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: "silent",
    child() {
      return this;
    },
  } as never;
  const { app } = await buildServer({ store, logger, readiness });
  return app;
}

describe("validateSpawnRequest", () => {
  it("rejects missing prompt / backend / repoPath", () => {
    expect(validateSpawnRequest({}).ok).toBe(false);
    expect(validateSpawnRequest({ prompt: "x" }).ok).toBe(false);
    expect(validateSpawnRequest({ prompt: "x", backend: "codex" }).ok).toBe(false);
  });

  it("rejects an unknown backend", () => {
    const r = validateSpawnRequest({ prompt: "x", backend: "nope", repoPath: "/r" });
    expect(r.ok).toBe(false);
  });

  it("accepts and normalizes a valid request", () => {
    const r = validateSpawnRequest({ prompt: "x", backend: "codex", repoPath: "/r" });
    expect(r).toEqual({
      ok: true,
      request: expect.objectContaining({ prompt: "x", backend: "codex", repoPath: "/r" }),
    });
  });

  it("accepts a valid toolchain", () => {
    const r = validateSpawnRequest({ prompt: "x", backend: "codex", repoPath: "/r", toolchain: "jvm" });
    expect(r).toMatchObject({ ok: true, request: { toolchain: "jvm" } });
  });

  it("rejects an unknown toolchain string at the HTTP boundary", () => {
    const r = validateSpawnRequest({ prompt: "x", backend: "codex", repoPath: "/r", toolchain: "rust" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-string toolchain (would crash resolveToolchain)", () => {
    // A raw HTTP body can carry any JSON type; `7`/`{}` must not reach
    // resolveToolchain() where `override?.trim()` would throw.
    expect(validateSpawnRequest({ prompt: "x", backend: "codex", repoPath: "/r", toolchain: 7 as unknown as string }).ok).toBe(false);
    expect(validateSpawnRequest({ prompt: "x", backend: "codex", repoPath: "/r", toolchain: {} as unknown as string }).ok).toBe(false);
  });
});

describe("routes", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("GET /healthz returns ok", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("POST /spawns validates the body", async () => {
    app = await makeApp();
    const missing = await app.inject({ method: "POST", url: "/spawns", payload: {} });
    expect(missing.statusCode).toBe(400);

    const badBackend = await app.inject({
      method: "POST",
      url: "/spawns",
      payload: { prompt: "x", backend: "nope", repoPath: "/r" },
    });
    expect(badBackend.statusCode).toBe(400);
  });

  it("POST /spawns accepts a job and GET /spawns/:id reports completion", async () => {
    app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/spawns",
      payload: { prompt: "do it", backend: "codex", repoPath: "/repo" },
    });
    expect(created.statusCode).toBe(202);
    const { id, status } = created.json() as { id: string; status: string };
    expect(id).toBeTruthy();
    expect(status).toBe("pending");

    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: `/spawns/${id}` });
      expect(res.json().status).toBe("succeeded");
    });
    const final = await app.inject({ method: "GET", url: `/spawns/${id}` });
    expect(final.json().result.spawnId).toBe("spawn-1");
  });

  it("GET /spawns/:id returns 404 for unknown id", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/spawns/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /readyz reports docker + castra + github + spawns readiness", async () => {
    // Fixed probes: the response shape, not the host's docker/castra/Tessera.
    app = await makeApp({
      docker: () => true,
      castra: async () => true,
      github: async () => ({ ok: true, source: "tessera", reason: null }),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body).toMatchObject({ ready: true, state: "ok", docker: true, castra: true });
    expect(body.github).toEqual({ ok: true, source: "tessera", reason: null });
    expect(body.spawns).toEqual(expect.objectContaining({ recent: 0, consecutive_failures: 0 }));
    expect(Array.isArray(body.reasons)).toBe(true);
  });

  it("GET /readyz is 503 down with no GitHub credential (the tessera:unconfigured outage)", async () => {
    app = await makeApp({ docker: () => true, castra: async () => true, env: { MARCH_TESSERA_URL: "http://tessera:9477" } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ready: false, state: "down", docker: true, castra: true,
      github: { ok: false, source: "none", reason: "tessera:unconfigured" },
    });
  });

  it("GET /readyz is 200 ok only when Tessera vends; /healthz stays pure liveness", async () => {
    // Tessera vends: its provider is ok, and Hatchery's own key + app grant check out.
    const fetchImpl = (async (url: string) => String(url).endsWith("/v1/client")
      ? Response.json({ client: "hatchery", grants: [{ identity: "app", access: "read", repos: ["acme/widgets"] }] })
      : Response.json({ providers: [{ provider: "github-app", state: "ok" }, { provider: "github-user", state: "ok" }] })) as unknown as typeof fetch;
    app = await makeApp({
      docker: () => true, castra: async () => true, fetchImpl,
      env: { MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_CLIENT_KEY: "k" },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, state: "ok", github: { ok: true, source: "tessera" }, reasons: [] });
    const live = await app.inject({ method: "GET", url: "/healthz" });
    expect(live.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz is 503 down on the ambient-token fallback (not a supported credential path)", async () => {
    app = await makeApp({
      docker: () => true, castra: async () => true,
      env: { MARCH_TESSERA_GH_TOKEN_FALLBACK: "1", GH_TOKEN: "t" },
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ state: "down", github: { ok: false, source: "fallback" } });
  });

  it("GET /readyz goes down after 5 consecutive spawn failures", async () => {
    const store = new JobStore({ executor: async () => { throw new Error("Hatchery GitHub read failed (tessera:unconfigured)"); } });
    app = await makeApp({ docker: () => true, castra: async () => true, github: async () => ({ ok: true, source: "tessera", reason: null }) }, store);
    for (let i = 0; i < 5; i++) store.create({ prompt: "p", backend: "codex", repoPath: "/r" });
    await vi.waitFor(() => expect(store.spawnWindow.consecutiveFailures).toBe(5));
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      state: "down",
      spawns: { recent: 5, failed: 5, consecutive_failures: 5, last_error: "tessera:unconfigured", last_success_at: null },
    });
  });
});
