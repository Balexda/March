/**
 * @l1 @deterministic @ci
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { CastraClient } from "../../castra/client.js";
import { getActiveOtel, initOtel } from "../../observability/otel.js";
import { classifyRequestLog, deriveBroodReadView, registerRoutes } from "./routes.js";
import {
  ContainerObserverUnavailableError,
  type ContainerObservation,
  type ContainerObserver,
} from "./container-observer.js";
import { sqliteAvailable } from "./sqlite.js";
import { broodArchiveDir, SessionStore } from "./store.js";
import type { StopComputeResult } from "./substrate.js";
import type { CastraStewardGateway, OrphanGate } from "./steward-removal.js";
import { BroodConflictError, BroodNotFoundError, teardownSession } from "./teardown.js";
import type { TeardownRequest, TeardownResult } from "./types.js";
import type { LogReaderDeps } from "./logs.js";

const apps: FastifyInstance[] = [];
const stores: SessionStore[] = [];

async function buildApp(
  teardown?: (id: string, request: TeardownRequest, traceparent?: string) => Promise<TeardownResult>,
  stewardGateway?: CastraStewardGateway,
  extra: {
    orphanGate?: OrphanGate;
    env?: NodeJS.ProcessEnv;
    containerObserver?: ContainerObserver;
    logReader?: LogReaderDeps;
    logger?: FastifyInstance["log"];
  } = {},
): Promise<{
  app: FastifyInstance;
  store: SessionStore;
}> {
  const store = new SessionStore({ dbPath: ":memory:" });
  const app = Fastify({ loggerInstance: extra.logger });
  await registerRoutes(app, {
    store,
    teardown,
    stewardGateway,
    orphanGate: extra.orphanGate,
    containerObserver: extra.containerObserver,
    logReader: extra.logReader,
    env: extra.env,
  });
  apps.push(app);
  stores.push(store);
  return { app, store };
}

/** Records what was observed so tests can assert the read stayed observational. */
function stubObserver(
  live: Record<string, ContainerObservation>,
): ContainerObserver & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async observe(containerIds) {
      calls.push([...containerIds]);
      return new Map(
        containerIds.map((id) => [
          id,
          live[id] ?? { present: false, running: false },
        ]),
      );
    },
  };
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

  it("rejects extractionResult writes once teardown has begun", async () => {
    const { app } = await buildApp();
    const extractionResult = {
      spawnId: "s-closing", backend: "claude-code", status: "failed",
      failureReason: "no-patch-produced", diagnostic: "none", extractedAt: "2026-06-13T00:00:00.000Z",
    };
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "s-closing", kind: "spawn" } });
    await app.inject({ method: "PATCH", url: "/sessions/s-closing", payload: { status: "tearing-down" } });

    const patched = await app.inject({
      method: "PATCH", url: "/sessions/s-closing", payload: { extractionResult },
    });
    const registered = await app.inject({
      method: "POST", url: "/sessions", payload: { id: "s-closing", kind: "spawn", extractionResult },
    });

    expect(patched.statusCode).toBe(409);
    expect(registered.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/sessions/s-closing" })).json())
      .not.toHaveProperty("extractionResult");
  });

  it("keeps extractionResult closed after teardown even when status later changes", async () => {
    const { app, store } = await buildApp();
    const extractionResult = {
      spawnId: "s-done", backend: "claude-code", status: "failed",
      failureReason: "no-patch-produced", diagnostic: "none", extractedAt: "2026-06-13T00:00:00.000Z",
    };
    for (const id of ["s-done", "s-admitted", "s-open"]) {
      await app.inject({ method: "POST", url: "/sessions", payload: { id, kind: "spawn", status: "stopped" } });
    }
    store.beginTeardown("s-done", [], "{}\n", {});
    store.completeTeardown("s-done", [], "2026-06-13T00:00:00.000Z");
    store.beginTeardown("s-admitted", [], "{}\n", {});
    for (const id of ["s-done", "s-admitted"]) {
      const moved = await app.inject({ method: "PATCH", url: `/sessions/${id}`, payload: { status: "stopped" } });
      expect(moved.statusCode, id).toBe(200);
      expect(moved.json<{ status: string }>().status, id).toBe("stopped");
      expect((await app.inject({
        method: "PATCH", url: `/sessions/${id}`, payload: { extractionResult: { ...extractionResult, spawnId: id } },
      })).statusCode, id).toBe(409);
      expect((await app.inject({
        method: "POST", url: "/sessions", payload: { id, kind: "spawn", extractionResult: { ...extractionResult, spawnId: id } },
      })).statusCode, id).toBe(409);
    }
    expect((await app.inject({
      method: "PATCH", url: "/sessions/s-open", payload: { extractionResult: { ...extractionResult, spawnId: "s-open" } },
    })).statusCode).toBe(200);
  });

  it("keeps an admitted steward's extractionResult closed after a status-only PATCH", async () => {
    const { app, store } = await buildApp();
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "sp", kind: "spawn", status: "stopped" } });
    for (const id of ["st-admitted", "st-other"]) {
      await app.inject({ method: "POST", url: "/sessions", payload: { id, kind: "steward", parentId: "sp", status: "running" } });
    }
    store.beginTeardown("sp", ["st-admitted"], "{}\n", {});
    const moved = await app.inject({ method: "PATCH", url: "/sessions/st-admitted", payload: { status: "stopped" } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ status: string }>().status).toBe("stopped");
    const extraction = (spawnId: string) => ({
      spawnId, backend: "claude-code", status: "failed",
      failureReason: "no-patch-produced", diagnostic: "none", extractedAt: "2026-06-13T00:00:00.000Z",
    });
    expect((await app.inject({
      method: "PATCH", url: "/sessions/st-admitted", payload: { extractionResult: extraction("st-admitted") },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: "/sessions",
      payload: { id: "st-admitted", kind: "steward", extractionResult: extraction("st-admitted") },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "PATCH", url: "/sessions/st-other", payload: { status: "stopped", extractionResult: extraction("st-other") },
    })).statusCode).toBe(200);
  });

  it("logs a nonterminal teardown even when every cleanup step succeeded", async () => {
    const logs: Record<string, unknown>[] = [];
    const logger = pino({ level: "warn" }, { write: (line) => logs.push(JSON.parse(line)) });
    const { app } = await buildApp(async (id) => ({
      id,
      status: "tearing-down",
      steps: (["archive", "container", "steward", "worktree", "branch"] as const)
        .map((step) => ({ step, outcome: "ok" as const })),
      warnings: ["archive finalization failed: disk full"],
    }), undefined, { logger: logger as unknown as FastifyInstance["log"] });
    const response = await app.inject({ method: "POST", url: "/sessions/spawn-1/teardown" });
    expect(response.statusCode).toBe(200);
    const incomplete = logs.filter((entry) => entry.msg === "brood teardown cleanup incomplete");
    expect(incomplete).toEqual([expect.objectContaining({
      session_id: "spawn-1",
      teardown_status: "tearing-down",
      teardown_steps: [],
      teardown_warnings: ["archive finalization failed: disk full"],
    })]);
  });

  it("rejects a PATCH that clears torndownAt and keeps the first timestamp", async () => {
    const { app, store } = await buildApp();
    await app.inject({ method: "POST", url: "/sessions", payload: { id: "s-done", kind: "spawn", status: "stopped" } });
    store.beginTeardown("s-done", [], "{}\n", {});
    store.completeTeardown("s-done", [], "2026-06-13T00:00:00.000Z");
    for (const torndownAt of [null, ""]) {
      expect((await app.inject({
        method: "PATCH", url: "/sessions/s-done", payload: { status: "stopped", torndownAt },
      })).statusCode).toBe(400);
    }
    expect((await app.inject({
      method: "PATCH", url: "/sessions/s-done", payload: { torndownAt: "2027-01-01T00:00:00.000Z" },
    })).statusCode).toBe(200);
    expect(store.get("s-done")?.torndownAt).toBe("2026-06-13T00:00:00.000Z");
    expect(store.get("s-done")?.status).toBe("torndown");
    expect((await app.inject({
      method: "PATCH", url: "/sessions/s-done",
      payload: { status: "stopped", extractionResult: {
        spawnId: "s-done", backend: "claude-code", status: "failed",
        failureReason: "no-patch-produced", diagnostic: "none", extractedAt: "2026-06-13T00:00:00.000Z",
      } },
    })).statusCode).toBe(409);
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

  it("GET /sessions/:id/logs returns live container text with source header", async () => {
    const { app, store } = await buildApp(undefined, undefined, {
      logReader: {
        readContainerLogs: (containerId) => `logs from ${containerId}\n`,
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", containerId: "c1" },
    });
    const before = store.get("s1");

    const res = await app.inject({ method: "GET", url: "/sessions/s1/logs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["x-march-log-source"]).toBe("live-container");
    expect(res.body).toBe("logs from c1\n");
    expect(store.get("s1")).toEqual(before);
  });

  it.each([
    {
      castraStatus: 200,
      archived: true,
      status: 200,
      source: "castra-session",
      content: "steward output\n",
    },
    {
      castraStatus: 404,
      archived: true,
      status: 200,
      source: "archive",
      content: "archived output\n",
    },
    {
      castraStatus: 404,
      archived: false,
      status: 502,
      source: undefined,
      content: "session unavailable",
    },
  ])("GET steward logs with Castra status $castraStatus and archive $archived", async ({
    castraStatus, archived, status, source, content,
  }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const body = castraStatus === 200
        ? { output: "steward output\n" }
        : { error: { code: "not_found", message: "session unavailable" } };
      return Response.json(body, { status: castraStatus });
    });
    const castra = new CastraClient({ baseUrl: "http://castra.test", fetchImpl });
    const readContainerLogs = vi.fn(() => "unexpected Docker output");
    const archiveExists = vi.fn(() => archived);
    const readArchive = vi.fn(() => "archived output\n");
    const teardown = vi.fn();
    const { app, store } = await buildApp(teardown, undefined, {
      logReader: { castra, readContainerLogs, archiveExists, readArchive },
    });
    store.register({
      id: "steward-row",
      kind: "steward",
      status: "running",
      agentDeckSessionId: "castra-id",
      profile: "tracked-profile",
    });
    const before = store.get("steward-row");

    const res = await app.inject({ method: "GET", url: "/sessions/steward-row/logs" });

    expect(res.statusCode).toBe(status);
    expect(res.headers["x-march-log-source"]).toBe(source);
    if (status === 200) {
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toBe(content);
    } else {
      expect(res.json().error).toContain(content);
    }
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "http://castra.test/v1/sessions/castra-id/output?profile=tracked-profile",
      expect.objectContaining({ method: "GET", body: undefined }),
    );
    expect(readContainerLogs).not.toHaveBeenCalled();
    expect(archiveExists).toHaveBeenCalledTimes(castraStatus === 200 ? 0 : 1);
    expect(readArchive).toHaveBeenCalledTimes(source === "archive" ? 1 : 0);
    expect(teardown).not.toHaveBeenCalled();
    expect(store.get("steward-row")).toEqual(before);
  });

  it("GET /sessions/:id/logs falls back to archive and distinguishes errors", async () => {
    const { app } = await buildApp(undefined, undefined, {
      logReader: {
        readContainerLogs: () => {
          throw new Error("no such container");
        },
        archiveExists: () => true,
        readArchive: () => "archive logs\n",
        homeDir: "/home/test",
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", containerId: "gone" },
    });

    const archived = await app.inject({ method: "GET", url: "/sessions/s1/logs" });
    expect(archived.statusCode).toBe(200);
    expect(archived.headers["x-march-log-source"]).toBe("archive");
    expect(archived.body).toBe("archive logs\n");
    expect(
      (await app.inject({ method: "GET", url: "/sessions/missing/logs" })).statusCode,
    ).toBe(404);
  });

  it("GET /sessions/:id/logs returns a service error when logs are unavailable", async () => {
    const { app } = await buildApp(undefined, undefined, {
      logReader: {
        readContainerLogs: () => {
          throw new Error("docker down");
        },
        archiveExists: () => false,
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", containerId: "c1" },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s2", kind: "legate" },
    });

    const upstream = await app.inject({ method: "GET", url: "/sessions/s1/logs" });
    expect(upstream.statusCode).toBe(502);
    expect(upstream.json().error).toContain("Live container logs");

    const unavailable = await app.inject({ method: "GET", url: "/sessions/s2/logs" });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().error).toContain("Logs for session");
  });

  it("GET /sessions/:id/logs still maps 502 when the archive is unreadable", async () => {
    const { app } = await buildApp(undefined, undefined, {
      logReader: {
        readContainerLogs: () => {
          throw new Error("docker down");
        },
        archiveExists: () => true,
        readArchive: () => {
          throw new Error("EACCES");
        },
        homeDir: "/home/test",
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn", containerId: "c1" },
    });

    const res = await app.inject({ method: "GET", url: "/sessions/s1/logs" });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("docker down");
  });

  it("GET /sessions/:id/logs reports a non-Error throw without losing it", async () => {
    const { app } = await buildApp(undefined, undefined, {
      logReader: {
        archiveExists: () => {
          throw "boom";
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "legate" },
    });

    const res = await app.inject({ method: "GET", url: "/sessions/s1/logs" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("boom");
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

  it("GET /sessions returns service-owned read views for all tracked kinds", async () => {
    const observer = stubObserver({
      "container-spawn-1": { present: true, running: true },
      "container-legate-1": { present: false, running: false },
    });
    const { app } = await buildApp(undefined, undefined, {
      containerObserver: observer,
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "spawn-1",
        kind: "spawn",
        status: "running",
        branch: "march/spawn/spawn-1",
        containerId: "container-spawn-1",
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "steward-1",
        kind: "steward",
        status: "failed",
        parentId: "spawn-1",
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "legate-1",
        kind: "legate",
        status: "torndown",
        containerId: "container-legate-1",
      },
    });

    const res = await app.inject({ method: "GET", url: "/sessions?reconcile=true" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual([
      "spawn-1",
      "steward-1",
      "legate-1",
    ]);
    expect(body.views).toHaveLength(3);
    expect(body.views[0]).toMatchObject({
      record: {
        id: "spawn-1",
        kind: "spawn",
        status: "running",
        branch: "march/spawn/spawn-1",
        containerId: "container-spawn-1",
      },
      needsAttention: false,
      disposed: false,
      containerLive: true,
      reconciled: true,
    });
    expect(body.views[1]).toMatchObject({
      record: {
        id: "steward-1",
        kind: "steward",
        status: "failed",
        parentId: "spawn-1",
      },
      needsAttention: true,
      disposed: false,
      containerLive: null,
      reconciled: true,
    });
    expect(body.views[1].record).not.toHaveProperty("branch");
    expect(body.views[2]).toMatchObject({
      record: {
        id: "legate-1",
        kind: "legate",
        status: "torndown",
        containerId: "container-legate-1",
      },
      needsAttention: false,
      disposed: true,
      containerLive: false,
      reconciled: true,
    });
    expect(body.views.every((view: { age: unknown }) => typeof view.age === "string")).toBe(true);
    // Only rows that actually track a container are handed to the observer.
    expect(observer.calls).toEqual([["container-spawn-1", "container-legate-1"]]);
  });

  it("GET /sessions reports observed liveness, not the persisted status", async () => {
    const observer = stubObserver({
      // The registry still says "running"; the container is gone.
      "container-spawn-1": { present: false, running: false },
    });
    const { app } = await buildApp(undefined, undefined, {
      containerObserver: observer,
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "spawn-1",
        kind: "spawn",
        status: "running",
        containerId: "container-spawn-1",
      },
    });

    const unreconciled = await app.inject({ method: "GET", url: "/sessions" });
    expect(unreconciled.json().views[0]).toMatchObject({
      containerLive: true,
      reconciled: false,
    });
    expect(observer.calls).toEqual([]);

    const reconciled = await app.inject({
      method: "GET",
      url: "/sessions?reconcile=true",
    });
    expect(reconciled.json().views[0]).toMatchObject({
      containerLive: false,
      reconciled: true,
    });
    // Observation is read-only: the registry row is untouched.
    expect(reconciled.json().sessions[0].status).toBe("running");
  });

  it("GET /sessions?reconcile=true returns 503 when the liveness source is unreachable", async () => {
    const { app } = await buildApp(undefined, undefined, {
      containerObserver: {
        async observe() {
          throw new ContainerObserverUnavailableError(
            "docker liveness observation failed: Cannot connect to the Docker daemon",
          );
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        id: "spawn-1",
        kind: "spawn",
        status: "running",
        containerId: "container-spawn-1",
      },
    });

    const res = await app.inject({ method: "GET", url: "/sessions?reconcile=true" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("docker liveness observation failed");

    // The unreconciled read still succeeds — reconciliation is the only casualty.
    const fallback = await app.inject({ method: "GET", url: "/sessions" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().views[0]).toMatchObject({ reconciled: false });
  });

  it("GET /sessions rejects repeated filter query values instead of ignoring them", async () => {
    const { app, store } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "spawn-1", kind: "spawn", status: "running" },
    });

    const list = vi.spyOn(store, "list");
    for (const [url, field] of [
      ["/sessions?kind=spawn&kind=wrong", "kind"],
      ["/sessions?status=running&status=bad", "status"],
      ["/sessions?parentId=a&parentId=b", "parentId"],
      ["/sessions?reconcile=true&reconcile=false", "reconcile"],
    ] as const) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe(`${field} must be supplied at most once.`);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("GET /sessions validates filters before listing and defaults to unreconciled views", async () => {
    const { app, store } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "spawn-1", kind: "spawn", status: "running" },
    });

    const list = vi.spyOn(store, "list");
    const badKind = await app.inject({ method: "GET", url: "/sessions?kind=wrong" });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error).toContain("kind must be one of");

    const badStatus = await app.inject({ method: "GET", url: "/sessions?status=bad" });
    expect(badStatus.statusCode).toBe(400);
    expect(badStatus.json().error).toContain("status must be one of");

    const badReconcile = await app.inject({
      method: "GET",
      url: "/sessions?reconcile=yes",
    });
    expect(badReconcile.statusCode).toBe(400);
    expect(badReconcile.json().error).toBe("reconcile must be true or false.");
    expect(list).not.toHaveBeenCalled();

    const defaultRead = await app.inject({ method: "GET", url: "/sessions" });
    expect(defaultRead.statusCode).toBe(200);
    expect(defaultRead.json().views[0]).toMatchObject({ reconciled: false });

    const explicitOff = await app.inject({
      method: "GET",
      url: "/sessions?reconcile=false",
    });
    expect(explicitOff.statusCode).toBe(200);
    expect(explicitOff.json().views[0]).toMatchObject({ reconciled: false });
  });

  it("deriveBroodReadView is pure over the source record", () => {
    const record = {
      id: "spawn-1",
      kind: "spawn" as const,
      status: "failed" as const,
      containerId: "container-spawn-1",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    };

    expect(
      deriveBroodReadView(record, {
        now: new Date("2026-08-19T00:02:00.000Z"),
      }),
    ).toEqual({
      record,
      age: "2m",
      needsAttention: true,
      disposed: false,
      containerLive: false,
      reconciled: false,
    });
    expect(record).toEqual({
      id: "spawn-1",
      kind: "spawn",
      status: "failed",
      containerId: "container-spawn-1",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
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

  it.each(["graceful", "kill", "unsupported", "unverified"] as const)(
    "enforces archive and removal ordering for %s teardown",
    async (mode) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-stop-"));
      const archiveDir = broodArchiveDir("live", homeDir);
      const log = path.join(archiveDir, "container.log");
      const calls: string[] = [];
      let state = "running";
      let failArchive = mode === "graceful";
      const stop = vi.fn(async (): Promise<StopComputeResult> => {
        calls.push("stop");
        if (mode === "unverified") throw new Error("Stop deadline exceeded");
        if (state === "stopped") return { outcome: "already-stopped", containerId: "runtime-id" };
        state = "stopped";
        return { outcome: "stopped", containerId: "runtime-id" };
      });
      const { app, store } = await buildApp((id, request) => teardownSession(store, id, request, {
        homeDir,
        substrate: {
          stopCompute: mode === "unsupported" ? undefined : stop,
          removeCompute: async (_target, stopped) => {
            calls.push("remove");
            expect(fs.readFileSync(log, "utf8")).toBe(`logs while ${state}`);
            expect(stopped).toEqual(mode === "kill" ? undefined : {
              outcome: "already-stopped", containerId: "runtime-id",
            });
            state = "removed";
          },
          removeWorkspace: (_repo, target) => {
            calls.push(target.worktreePath ? "worktree" : "branch");
            return { worktreeRemoved: true, branchDeleted: true };
          },
        },
        readContainerLogs: (id) => {
          calls.push(`logs:${id}`);
          if (failArchive) fs.mkdirSync(log);
          return `logs while ${state}`;
        },
        removeSteward: async () => {
          calls.push("steward");
          return { outcome: "removed", removedIds: ["steward"] };
        },
        pathExists: () => true,
      }));
      const teardown = (payload: TeardownRequest) =>
        app.inject({ method: "POST", url: "/sessions/live/teardown", payload });
      try {
        store.register({
          id: "live", kind: "spawn", status: "running", containerId: "recorded-log-id",
          repoPath: "/repo", worktreePath: "/wt/live", branch: "topic/live",
        });
        store.register({ id: "steward", kind: "steward", parentId: "live" });
        const kill = mode === "kill";
        expect((await teardown({ kill })).statusCode).toBe(409);
        const first = await teardown({ kill, force: true });
        expect(first.statusCode).toBe(200);
        if (kill) {
          expect(first.json().status).toBe("torndown");
          expect(first.json().steps.map((step: { step: string }) => step.step))
            .toEqual(["archive", "container", "steward", "worktree", "branch"]);
          expect(calls).toEqual(["logs:recorded-log-id", "remove", "steward", "worktree", "branch"]);
          expect(stop).not.toHaveBeenCalled();
          return;
        }
        expect(first.json().status).toBe("tearing-down");
        expect(store.get("live")?.status).toBe("tearing-down");
        if (mode !== "graceful") {
          expect(first.json().steps[0]).toMatchObject({ step: "stop", outcome: "failed" });
          expect(calls).toEqual(mode === "unsupported" ? [] : ["stop"]);
          return;
        }
        expect(stop).toHaveBeenCalledWith({
          sessionId: "live", kind: "spawn", containerName: "march-spawn-live",
        });
        expect(first.json().steps).toEqual([
          { step: "stop", outcome: "ok", detail: "graceful stop verified" },
          expect.objectContaining({ step: "archive", outcome: "failed" }),
          ...["container", "steward", "worktree", "branch"].map((step) =>
            ({ step, outcome: "skipped", detail: "deferred: archive failed" })),
        ]);
        expect(calls).toEqual(["stop", "logs:recorded-log-id"]);
        expect(state).toBe("stopped");
        expect((await teardown({})).statusCode).toBe(409);
        fs.rmdirSync(log);
        failArchive = false;
        const retry = await teardown({ force: true });
        expect(retry.json()).toMatchObject({
          status: "torndown",
          steps: [
            { step: "stop", outcome: "skipped", detail: "already stopped" },
            ...["archive", "container", "steward", "worktree", "branch"].map((step) =>
              expect.objectContaining({ step, outcome: "ok" })),
          ],
        });
        expect(calls.slice(2)).toEqual(["stop", "logs:recorded-log-id", "remove", "steward", "worktree", "branch"]);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { outcome: "success", problem: undefined },
    { outcome: "partial", problem: "branch" },
    { outcome: "error", problem: "steward" },
  ] as const)("correlates $outcome teardown across the response, spans, metrics and logs", async ({
    outcome,
    problem,
  }) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "brood-route-teardown-"));
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    try {
      const otel = getActiveOtel();
      const tracer = otel.getTracer();
      const startSpan = tracer.startSpan.bind(tracer);
      const spans: Span[] = [];
      vi.spyOn(tracer, "startSpan").mockImplementation((...args) => {
        const span = startSpan(...args) as Span;
        spans.push(span);
        return span;
      });
      const meter = otel.getMeter();
      const createCounter = meter.createCounter.bind(meter);
      const createHistogram = meter.createHistogram.bind(meter);
      const add = vi.fn();
      const record = vi.fn();
      vi.spyOn(meter, "createCounter").mockImplementation((name, options) =>
        name === "march.brood.teardowns" ? { add } : createCounter(name, options));
      vi.spyOn(meter, "createHistogram").mockImplementation((name, options) =>
        name === "march.brood.teardown.duration" ? { record } : createHistogram(name, options));

      const logs: Record<string, unknown>[] = [];
      const logger = pino({ level: "warn" }, { write: (line) => logs.push(JSON.parse(line)) });
      const diagnostic = "Castra unavailable ".padEnd(800, "x");
      const { app, store } = await buildApp((id, body, traceparent) =>
        teardownSession(store, id, body, {
          homeDir,
          traceparent,
          pathExists: () => true,
          substrate: {
            removeCompute: async () => {},
            removeWorkspace: () => ({ worktreeRemoved: true, branchDeleted: problem !== "branch" }),
          },
          removeSteward: async () => problem === "steward"
            ? { outcome: "failed", detail: diagnostic, removedIds: [] }
            : { outcome: "absent", removedIds: [] },
        }), undefined, { logger });
      store.register({
        id: "spawn-123", kind: "spawn", status: "stopped",
        repoPath: "/repo", worktreePath: "/wt/spawn-123", branch: "march/spawn-123",
      });
      store.register({
        id: "steward-123", kind: "steward", status: "stopped",
        parentId: "spawn-123", profile: "march",
      });

      const traceId = "0af7651916cd43dd8448eb211c80319c";
      const spanId = "b7ad6b7169203331";
      const response = await app.inject({
        method: "POST",
        url: "/sessions/steward-123/teardown",
        headers: { traceparent: `00-${traceId}-${spanId}-01` },
      });
      const status = problem ? "tearing-down" : "torndown";
      expect(response.statusCode).toBe(200);
      const result = response.json<TeardownResult>();
      expect(result).toMatchObject({ id: "spawn-123", status });
      expect(result.steps.map(({ step }) => step))
        .toEqual(["archive", "container", "steward", "worktree", "branch"]);

      const [parent, ...allChildren] = spans;
      // Archive finalization and the registry transition add their own
      // non-step child spans; the cleanup steps must still appear in order.
      const stepSpanNames = new Set(result.steps.map(({ step }) => `brood.teardown.${step}`));
      const children = allChildren.filter((child) => stepSpanNames.has(child.name));
      expect(parent.name).toBe("brood.teardown");
      expect(parent.spanContext().traceId).toBe(traceId);
      expect(parent.parentSpanContext?.spanId).toBe(spanId);
      expect(parent.status.code).toBe(problem ? SpanStatusCode.ERROR : SpanStatusCode.OK);
      expect(parent.attributes["march.teardown.outcome"]).toBe(outcome);
      expect(children.map((child) => child.name))
        .toEqual(result.steps.map(({ step }) => `brood.teardown.${step}`));
      for (const [index, child] of children.entries()) {
        const { step, outcome: stepOutcome, detail } = result.steps[index];
        expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
        expect(child.spanContext().traceId).toBe(traceId);
        expect(child.attributes["march.teardown.step"]).toBe(step);
        expect(child.attributes["march.teardown.outcome"]).toBeDefined();
        expect(child.attributes["march.teardown.detail"]).toBe(detail);
        expect(parent.events[index]).toMatchObject({
          name: `teardown.${step}`,
          attributes: { outcome: stepOutcome, ...(detail ? { detail } : {}) },
        });
      }
      const labels = { kind: "spawn", outcome, profile: "march" };
      expect(add.mock.calls).toEqual([[1, labels]]);
      expect(record.mock.calls).toEqual([[expect.any(Number), labels]]);
      expect(record.mock.calls[0][0]).toBeGreaterThanOrEqual(0);

      const affected = problem === "steward"
        ? [
            { step: "steward", outcome: "failed", detail: diagnostic.slice(0, 500) },
            { step: "worktree", outcome: "skipped", detail: "deferred: steward removal failed" },
            { step: "branch", outcome: "skipped", detail: "deferred: steward removal failed" },
          ]
        : problem === "branch"
          ? [{ step: "branch", outcome: "failed", detail: 'branch "march/spawn-123" may still exist' }]
          : [];
      if (problem) {
        expect(result.steps.slice(-affected.length)).toEqual(affected);
        expect(children.slice(-affected.length).map((child) => child.attributes["march.teardown.outcome"]))
          .toEqual(affected.map(({ outcome }) => outcome === "failed" ? "failed" : "deferred"));
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          route: "/sessions/:id/teardown", status_code: 200,
          session_id: "spawn-123", teardown_status: status, teardown_steps: affected,
        });
      } else {
        expect(logs).toEqual([]);
      }

      logs.length = 0;
      const missing = await app.inject({ method: "POST", url: "/sessions/missing/teardown" });
      expect(missing.statusCode).toBe(404);
      expect(logs).toEqual([expect.objectContaining({
        route: "/sessions/:id/teardown", status_code: 404, detail: expect.stringContaining("missing"),
      })]);
    } finally {
      vi.restoreAllMocks();
      initOtel({});
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
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
