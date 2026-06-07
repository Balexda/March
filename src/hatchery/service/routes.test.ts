import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { JobStore } from "./jobs.js";
import { validateSpawnRequest } from "./routes.js";
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
    exitCode: 0,
    summary: "ok",
  };
}

async function makeApp(): Promise<FastifyInstance> {
  const store = new JobStore({ executor: async () => fakeResult() });
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
  const { app } = await buildServer({ store, logger });
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

  it("GET /readyz reports docker + castra readiness", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json() as { ready: boolean; docker: boolean; castra: boolean };
    expect(typeof body.ready).toBe("boolean");
    expect(typeof body.docker).toBe("boolean");
    expect(typeof body.castra).toBe("boolean");
    expect(body.ready).toBe(body.docker && body.castra);
  });
});
