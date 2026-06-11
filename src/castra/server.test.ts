import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import type { AgentDeckAdapter, RecoveryRuntime } from "./adapter.js";
import {
  CastraAgentDeckError,
  CastraConflictError,
  CastraNotFoundError,
  type CastraSession,
} from "./types.js";
import { createCastraLogger } from "../observability/logger.js";
import { initOtel } from "../observability/otel.js";
import { traceIdForDispatch } from "../observability/trace-ids.js";
import type { FastifyInstance } from "fastify";

const SAMPLE: CastraSession = {
  sessionId: "sess-1",
  title: "Steward",
  group: "march-spawn-managers",
  branch: "march/spawn/x",
  worktreePath: "/repo/feature-march-spawn-x",
  createdAt: "2026-05-20T00:00:00Z",
  status: "idle",
};

function fakeAdapter(overrides: Partial<AgentDeckAdapter> = {}): AgentDeckAdapter {
  return {
    list: vi.fn().mockReturnValue([SAMPLE]),
    launch: vi.fn().mockReturnValue(SAMPLE),
    show: vi.fn().mockReturnValue(SAMPLE),
    send: vi.fn(),
    set: vi.fn(),
    remove: vi.fn().mockReturnValue({ removed: true }),
    output: vi.fn().mockReturnValue({ output: "hello", truncated: false }),
    reachable: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

describe("castra server", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe("health & status (open, no auth)", () => {
    beforeEach(() => {
      app = buildServer({ adapter: fakeAdapter(), token: "secret" });
    });

    it("GET /healthz returns ok without a token", async () => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    });

    it("GET /status reports service, version and agent-deck reachability", async () => {
      const res = await app.inject({ method: "GET", url: "/status" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.service).toBe("march-castra");
      expect(body.agentDeck).toEqual({ reachable: true });
      expect(typeof body.uptimeSeconds).toBe("number");
    });
  });

  describe("auth", () => {
    beforeEach(() => {
      app = buildServer({ adapter: fakeAdapter(), token: "secret" });
    });

    it("rejects /v1/* without a bearer token", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/sessions?profile=march" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    });

    it("rejects /v1/* with the wrong token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions?profile=march",
        headers: { authorization: "Bearer nope" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("accepts /v1/* with the right token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions?profile=march",
        headers: { authorization: "Bearer secret" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions).toHaveLength(1);
    });
  });

  describe("routes (auth disabled)", () => {
    let adapter: AgentDeckAdapter;
    beforeEach(() => {
      adapter = fakeAdapter();
      app = buildServer({ adapter });
    });

    it("GET /v1/sessions passes profile and group to the adapter", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/sessions?profile=march&group=g" });
      expect(res.statusCode).toBe(200);
      expect(adapter.list).toHaveBeenCalledWith({ profile: "march", group: "g" });
    });

    it("GET /v1/sessions rejects a missing profile with 400", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/sessions" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    });

    it("GET /v1/sessions rejects an invalid profile shape with 400", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/sessions?profile=../etc" });
      expect(res.statusCode).toBe(400);
    });

    it("POST /v1/sessions launches and returns 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { profile: "march", repoPath: "/repo", branch: "march/spawn/x", title: "Steward" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().session.sessionId).toBe("sess-1");
      expect(adapter.launch).toHaveBeenCalledWith(
        expect.objectContaining({ profile: "march", group: "march-spawn-managers" }),
      );
    });

    it("POST /v1/sessions surfaces a launch race as 409 conflict", async () => {
      adapter = fakeAdapter({
        launch: vi.fn(() => {
          throw new CastraConflictError("wrong worktree");
        }),
      });
      app = buildServer({ adapter });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { profile: "march", repoPath: "/repo", branch: "b", title: "t" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("conflict");
    });

    it("GET /v1/sessions/:id returns 404 for a missing session", async () => {
      adapter = fakeAdapter({
        show: vi.fn(() => {
          throw new CastraNotFoundError("gone");
        }),
      });
      app = buildServer({ adapter });
      const res = await app.inject({ method: "GET", url: "/v1/sessions/sess-1?profile=march" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    });

    it("POST /v1/sessions/:id/send returns 202", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/sess-1/send",
        payload: { profile: "march", prompt: "go" },
      });
      expect(res.statusCode).toBe(202);
      expect(adapter.send).toHaveBeenCalledWith({ profile: "march", sessionId: "sess-1", prompt: "go" });
    });

    it("POST /v1/sessions/:id/send accepts an x-march-slice-id header (span/log correlation)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/sess-1/send",
        headers: { "x-march-slice-id": "my-slice-us1-forge" },
        payload: { profile: "march", prompt: "go" },
      });
      expect(res.statusCode).toBe(202);
      expect(adapter.send).toHaveBeenCalledWith({ profile: "march", sessionId: "sess-1", prompt: "go" });
    });

    it("POST /v1/sessions/:id/set rejects a non-allowlisted key with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/sess-1/set",
        payload: { profile: "march", key: "danger", value: "x" },
      });
      expect(res.statusCode).toBe(400);
      expect(adapter.set).not.toHaveBeenCalled();
    });

    it("POST /v1/sessions/:id/set accepts an allowlisted key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/sess-1/set",
        payload: { profile: "march", key: "auto-mode", value: "true" },
      });
      expect(res.statusCode).toBe(200);
      expect(adapter.set).toHaveBeenCalledWith({
        profile: "march",
        sessionId: "sess-1",
        key: "auto-mode",
        value: "true",
      });
    });

    it("GET /v1/sessions/:id/output returns output payload", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/sessions/sess-1/output?profile=march&lines=10",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ output: "hello", truncated: false });
      expect(adapter.output).toHaveBeenCalledWith({ profile: "march", sessionId: "sess-1", lines: 10 });
    });

    it("DELETE /v1/sessions/:id is idempotent (removed:false when already gone)", async () => {
      adapter = fakeAdapter({ remove: vi.fn().mockReturnValue({ removed: false }) });
      app = buildServer({ adapter });
      const res = await app.inject({
        method: "DELETE",
        url: "/v1/sessions/sess-1?profile=march&pruneWorktree=true",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, removed: false });
      expect(adapter.remove).toHaveBeenCalledWith({
        profile: "march",
        sessionId: "sess-1",
        pruneWorktree: true,
      });
    });

    it("maps an agent-deck failure to 502", async () => {
      adapter = fakeAdapter({
        list: vi.fn(() => {
          throw new CastraAgentDeckError("tmux down");
        }),
      });
      app = buildServer({ adapter });
      const res = await app.inject({ method: "GET", url: "/v1/sessions?profile=march" });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("agent_deck_error");
    });

    it("returns a generic message for an unexpected 500 (no internal detail leak)", async () => {
      adapter = fakeAdapter({
        list: vi.fn(() => {
          throw new Error("secret path /etc/march/token leaked");
        }),
      });
      app = buildServer({ adapter });
      const res = await app.inject({ method: "GET", url: "/v1/sessions?profile=march" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("internal");
      expect(res.json().error.message).toBe("Internal server error.");
      expect(res.payload).not.toContain("secret path");
    });

    it("returns the uniform envelope for an unknown route", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    });
  });

  // The fix for #207's "Logs for this span": with no OTel ContextManager
  // registered, the in-span log must carry the span's trace ids EXPLICITLY.
  // Exercise the full Fastify+pino path and assert the JSONL line proves it.
  describe("trace-correlated logs", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-castra-corr-"));
      initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    });
    afterEach(() => {
      initOtel({}); // restore the no-op handle for other suites
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("the 'castra send accepted' log carries the castra.send span's trace_id/span_id", async () => {
      const logFilePath = path.join(dir, "castra.jsonl");
      // env:{} keeps the OTLP bridge off (no collector in CI); the file sink
      // records the same pino line the bridge would forward.
      const logger = createCastraLogger({ logFilePath, env: {}, sync: true });
      app = buildServer({ adapter: fakeAdapter(), logger });

      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/sess-1/send",
        headers: { "x-march-slice-id": "slice-abc" },
        payload: { profile: "march", prompt: "hello there" },
      });
      expect(res.statusCode).toBe(202);
      await app.close();

      const sendLine = fs
        .readFileSync(logFilePath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.msg === "castra send accepted");

      expect(sendLine).toBeDefined();
      // The slice-keyed deterministic trace, so the line shares the slice's trace.
      expect(sendLine!.trace_id).toBe(traceIdForDispatch("slice-abc"));
      expect(sendLine!.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(sendLine!["castra.session_id"]).toBe("sess-1");
      expect(sendLine!["march.slice_id"]).toBe("slice-abc");
      expect(sendLine!["castra.message_bytes"]).toBe(11);
    });
  });

  describe("POST /v1/sessions/recover", () => {
    function recoveryRuntime(overrides: Partial<RecoveryRuntime> = {}): RecoveryRuntime {
      return {
        listSessions: vi
          .fn()
          .mockReturnValue([
            { sessionId: "w1", title: "forge", group: "legate-workers", status: "error", tmuxSession: "t1" },
          ]),
        restart: vi.fn(),
        readSession: vi.fn().mockReturnValue({
          sessionId: "w1",
          title: "forge",
          group: "legate-workers",
          status: "waiting",
          tmuxSession: "t1",
        }),
        capturePane: vi.fn().mockReturnValue("❯ "),
        sendEnter: vi.fn(),
        ...overrides,
      };
    }

    // Fast, finite poll loops: advance a fake clock on each sleep.
    function fastRecovery(runtime: RecoveryRuntime) {
      let clock = 0;
      return {
        runtime,
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
      };
    }

    it("requires a bearer token", async () => {
      app = buildServer({ adapter: fakeAdapter(), token: "secret" });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/recover",
        payload: { profile: "march" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a body without a profile", async () => {
      app = buildServer({ adapter: fakeAdapter(), token: "secret" });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/recover",
        headers: { authorization: "Bearer secret" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    });

    it("runs the sweep and returns the per-session report", async () => {
      const runtime = recoveryRuntime();
      app = buildServer({
        adapter: fakeAdapter(),
        token: "secret",
        recovery: fastRecovery(runtime),
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/recover",
        headers: { authorization: "Bearer secret" },
        payload: { profile: "march" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        recovered: [
          {
            sessionId: "w1",
            title: "forge",
            group: "legate-workers",
            outcome: "recovered",
            pickerResolved: false,
            finalStatus: "waiting",
          },
        ],
      });
      expect(runtime.restart).toHaveBeenCalledWith("march", "w1");
    });

    it("restricts the sweep to explicit sessionIds", async () => {
      const runtime = recoveryRuntime({
        listSessions: vi.fn().mockReturnValue([
          { sessionId: "w1", title: "a", group: "legate-workers", status: "error", tmuxSession: "t1" },
          { sessionId: "w2", title: "b", group: "legate-workers", status: "error", tmuxSession: "t2" },
        ]),
        readSession: vi.fn().mockReturnValue({
          sessionId: "w2", title: "b", group: "legate-workers", status: "idle", tmuxSession: "t2",
        }),
      });
      app = buildServer({
        adapter: fakeAdapter(),
        token: "secret",
        recovery: fastRecovery(runtime),
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/recover",
        headers: { authorization: "Bearer secret" },
        payload: { profile: "march", sessionIds: ["w2"] },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().recovered.map((r: { sessionId: string }) => r.sessionId);
      expect(ids).toEqual(["w2"]);
      expect(runtime.restart).toHaveBeenCalledTimes(1);
      expect(runtime.restart).toHaveBeenCalledWith("march", "w2");
    });

    it("forwards an explicit group filter to the sweep", async () => {
      const runtime = recoveryRuntime({
        listSessions: vi
          .fn()
          .mockReturnValue([
            { sessionId: "c1", title: "conductor", group: "conductor", status: "error", tmuxSession: "tc" },
          ]),
        readSession: vi.fn().mockReturnValue({
          sessionId: "c1",
          title: "conductor",
          group: "conductor",
          status: "idle",
          tmuxSession: "tc",
        }),
      });
      app = buildServer({
        adapter: fakeAdapter(),
        token: "secret",
        recovery: fastRecovery(runtime),
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/sessions/recover",
        headers: { authorization: "Bearer secret" },
        payload: { profile: "march", group: "conductor" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().recovered[0].sessionId).toBe("c1");
      expect(runtime.restart).toHaveBeenCalledWith("march", "c1");
    });
  });
});
