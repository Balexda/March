import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveOtel, initOtel } from "../observability/otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "../observability/trace-ids.js";
import { StatioClient } from "./client.js";
import type { RepoMetadataReader } from "./forge.js";
import { buildStatioServer } from "./server.js";
import { StatioForgeError, StatioValidationError, type RepoInfo } from "./types.js";

const REPO: RepoInfo = { owner: "Balexda/March", defaultBranch: "master" };

function fakeReader(overrides: Partial<RepoMetadataReader> = {}): RepoMetadataReader {
  return {
    repoInfo: vi.fn().mockResolvedValue(REPO),
    reachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function captureSpans(): Span[] {
  const tracer = getActiveOtel().getTracer();
  const created: Span[] = [];
  const real = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, "startSpan").mockImplementation((...args: Parameters<typeof real>) => {
    const span = real(...args) as Span;
    created.push(span);
    return span;
  });
  return created;
}

describe("statio server", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
    initOtel({});
  });

  it("exposes open health and status routes", async () => {
    const reader = fakeReader();
    app = buildStatioServer({ repoReader: reader, token: "secret", startedAt: Date.now() - 2000 });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const status = await app.inject({ method: "GET", url: "/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      service: "march-statio",
      gh: { reachable: true },
    });
    expect(typeof status.json().uptimeSeconds).toBe("number");
  });

  it("rejects missing and wrong bearer tokens on /v1 routes", async () => {
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const missing = await app.inject({ method: "GET", url: "/v1/repo" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { code: "unauthorized", message: "Missing or invalid bearer token." },
    });

    const wrong = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("unauthorized");
  });

  it("returns repo metadata through the authorized /v1/repo success wrapper", async () => {
    const reader = fakeReader();
    app = buildStatioServer({ repoReader: reader, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repo: REPO });
    expect(reader.repoInfo).toHaveBeenCalledOnce();
  });

  it("returns not_found envelopes for unknown routes", async () => {
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("does not gate sibling paths that merely share the /v1 prefix", async () => {
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    // `/v12` is not under `/v1/`, so the auth gate must not claim it: an
    // unknown route should fall through to not_found, never unauthorized.
    const res = await app.inject({ method: "GET", url: "/v12" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("maps forge failures to forge_error envelopes", async () => {
    app = buildStatioServer({
      repoReader: fakeReader({
        repoInfo: vi.fn(async () => {
          throw new StatioForgeError("gh failed");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "forge_error", message: "gh failed" } });
  });

  it("maps validation failures to invalid_request envelopes", async () => {
    app = buildStatioServer({
      repoReader: fakeReader({
        repoInfo: vi.fn(async () => {
          throw new StatioValidationError("bad request");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: "invalid_request", message: "bad request" },
    });
  });

  it("keeps repo reads stateless across concurrent requests", async () => {
    const reader = fakeReader();
    app = buildStatioServer({ repoReader: reader, token: "secret" });

    const [first, second] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/repo",
        headers: { authorization: "Bearer secret" },
      }),
      app.inject({
        method: "GET",
        url: "/v1/repo",
        headers: { authorization: "Bearer secret" },
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(reader.repoInfo).toHaveBeenCalledTimes(2);
  });
});

describe("statio request tracing", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
    initOtel({});
  });

  it("nests request spans under a valid x-march-slice-id when telemetry is enabled", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo?ignored=1",
      headers: {
        authorization: "Bearer secret",
        "x-march-slice-id": "slice-abc",
      },
    });

    expect(res.statusCode).toBe(200);
    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-abc"));
    expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-abc"));
    expect(span.attributes).toMatchObject({
      "statio.method": "GET",
      "statio.route": "/v1/repo",
      "statio.status_class": "2xx",
      "statio.outcome": "success",
    });
  });

  it("emits a service-local request span when no slice id is provided", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.parentSpanContext).toBeUndefined();
  });

  it("ignores malformed and oversized slice ids for correlation without affecting responses", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: {
        authorization: "Bearer secret",
        "x-march-slice-id": "bad slice id",
      },
    });

    expect(res.statusCode).toBe(200);
    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe(traceIdForDispatch("bad slice id"));

    const oversized = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: {
        authorization: "Bearer secret",
        "x-march-slice-id": "x".repeat(201),
      },
    });

    expect(oversized.statusCode).toBe(200);
    const oversizedSpan = spans.filter((s) => s.name === "statio.request").at(-1)!;
    expect(oversizedSpan).toBeDefined();
    expect(oversizedSpan.parentSpanContext).toBeUndefined();
  });

  it("does not emit request spans when telemetry is disabled", async () => {
    initOtel({});
    const start = vi.spyOn(getActiveOtel().getTracer(), "startSpan");
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: {
        authorization: "Bearer secret",
        "x-march-slice-id": "slice-abc",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("statio client/server compatibility", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
    initOtel({});
  });

  async function listen(reader: RepoMetadataReader, token = "secret"): Promise<string> {
    app = buildStatioServer({ repoReader: reader, token });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it("lets the async client call the authorized /v1/repo route", async () => {
    const baseUrl = await listen(fakeReader());
    const client = new StatioClient({ baseUrl, token: "secret" });

    await expect(client.repoInfo()).resolves.toEqual(REPO);
    await expect(client.reachable()).resolves.toBe(true);
  });

  it("maps service-generated non-2xx envelopes to client errors", async () => {
    const baseUrl = await listen(fakeReader());
    const client = new StatioClient({ baseUrl, token: "wrong" });

    await expect(client.repoInfo()).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  it("reports readiness only through the authenticated repo surface", async () => {
    const baseUrl = await listen(
      fakeReader({
        repoInfo: vi.fn(async () => {
          throw new StatioForgeError("gh down");
        }),
      }),
    );

    const wrongToken = new StatioClient({ baseUrl, token: "wrong" });
    await expect(wrongToken.reachable()).resolves.toBe(false);

    const forgeDown = new StatioClient({ baseUrl, token: "secret" });
    await expect(forgeDown.reachable()).resolves.toBe(false);
  });
});
