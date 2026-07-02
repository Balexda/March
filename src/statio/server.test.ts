/**
 * @l1 @deterministic @ci
 */
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveOtel, initOtel } from "../observability/otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "../observability/trace-ids.js";
import { StatioClient } from "./client.js";
import type { RepoMetadataReader } from "./forge.js";
import { buildStatioServer } from "./server.js";
import {
  type ForgeClient,
  type PullRequestListItem,
  type PullRequestSummary,
  type ReviewThread,
  StatioForgeError,
  StatioNotFoundError,
  StatioValidationError,
  type RepoInfo,
} from "./types.js";

const REPO: RepoInfo = { owner: "Balexda/March", defaultBranch: "master" };
const PR_LIST: PullRequestListItem[] = [
  {
    number: 42,
    url: "https://github.com/Balexda/March/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    headBranch: "feature/statio",
    title: "Add Statio",
    checks: "PASS",
    createdAt: "2026-05-26T00:00:00Z",
  },
];
const PR: PullRequestSummary = {
  number: 42,
  url: "https://github.com/Balexda/March/pull/42",
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  headBranch: "feature/statio",
  title: "Add Statio",
  author: "dev",
  checks: "PASS",
  failedChecks: [],
  unresolvedThreads: [
    {
      id: 10,
      path: "src/statio/server.ts",
      line: 112,
      author: "reviewer",
      bodyPreview: "Please adjust this.",
      lastAuthor: "reviewer",
      lastCommentAt: "2026-05-26T00:00:00Z",
      commentCount: 1,
      commentIds: [10],
      needsResponse: true,
    },
  ],
  threadCount: 1,
  needsResponseCount: 1,
};
const REVIEW_THREADS: ReviewThread[] = [
  {
    id: 10,
    path: "src/statio/server.ts",
    line: 112,
    author: "reviewer",
    bodyPreview: "Please adjust this.",
    lastAuthor: "reviewer",
    lastCommentAt: "2026-05-26T00:00:00Z",
    commentCount: 1,
    commentIds: [10],
  },
];

type StatioRouteForgeClient = Pick<
  ForgeClient,
  "repoInfo" | "listPrs" | "getPr" | "reviewThreads" | "reachable"
>;

function fakeReader(overrides: Partial<RepoMetadataReader> = {}): RepoMetadataReader {
  return {
    repoInfo: vi.fn().mockResolvedValue(REPO),
    reachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function fakeForge(overrides: Partial<StatioRouteForgeClient> = {}): StatioRouteForgeClient {
  return {
    repoInfo: vi.fn().mockResolvedValue(REPO),
    listPrs: vi.fn().mockResolvedValue(PR_LIST),
    getPr: vi.fn().mockResolvedValue(PR),
    reviewThreads: vi.fn().mockResolvedValue(REVIEW_THREADS),
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
      url: "/v1/unknown",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns pull request lists through the authorized /v1/prs wrapper", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs?author=%40me&state=open",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prs: PR_LIST });
    expect(forgeClient.listPrs).toHaveBeenCalledWith({
      author: "@me",
      head: undefined,
      state: "open",
    });
  });

  it("passes head filters to the pull request list forge seam", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs?head=feature%2Fstatio",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prs: PR_LIST });
    expect(forgeClient.listPrs).toHaveBeenCalledWith({
      author: undefined,
      head: "feature/statio",
      state: undefined,
    });
  });

  it("returns an empty pull request list as a successful response", async () => {
    const forgeClient = fakeForge({ listPrs: vi.fn().mockResolvedValue([]) });
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs?head=no-match",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prs: [] });
  });

  it("returns invalid_request envelopes for malformed pull request list filters", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    for (const url of ["/v1/prs?state=draft", "/v1/prs?head=", "/v1/prs?author=%20me"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer secret" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    }
    expect(forgeClient.listPrs).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated pull request list reads before calling the forge seam", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({ method: "GET", url: "/v1/prs?author=%40me" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect(forgeClient.listPrs).not.toHaveBeenCalled();
  });

  it("maps pull request list forge failures to forge_error envelopes", async () => {
    app = buildStatioServer({
      forgeClient: fakeForge({
        listPrs: vi.fn(async () => {
          throw new StatioForgeError("gh list failed");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs?author=%40me",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "forge_error", message: "gh list failed" } });
  });

  it("returns pull request summaries through the authorized /v1/prs/:number wrapper", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pr: PR });
    expect(forgeClient.getPr).toHaveBeenCalledWith(42);
  });

  it("rejects unauthenticated pull request reads before calling the forge seam", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({ method: "GET", url: "/v1/prs/42" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect(forgeClient.getPr).not.toHaveBeenCalled();
  });

  it("returns invalid_request envelopes for malformed pull request numbers", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    for (const number of ["abc", "0", "-1", "1.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/prs/${number}`,
        headers: { authorization: "Bearer secret" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    }
    expect(forgeClient.getPr).not.toHaveBeenCalled();
  });

  it("maps absent pull requests to not_found envelopes", async () => {
    app = buildStatioServer({
      forgeClient: fakeForge({
        getPr: vi.fn(async () => {
          throw new StatioNotFoundError("pull request not found");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/404",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "not_found", message: "pull request not found" },
    });
  });

  it("maps pull request forge failures to forge_error envelopes", async () => {
    app = buildStatioServer({
      forgeClient: fakeForge({
        getPr: vi.fn(async () => {
          throw new StatioForgeError("gh failed");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "forge_error", message: "gh failed" } });
  });

  it("returns review threads through the authorized /v1/prs/:number/review-threads wrapper", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42/review-threads",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ threads: REVIEW_THREADS });
    expect(forgeClient.reviewThreads).toHaveBeenCalledWith(42);
  });

  it("rejects unauthenticated review thread reads before calling the forge seam", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({ method: "GET", url: "/v1/prs/42/review-threads" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect(forgeClient.reviewThreads).not.toHaveBeenCalled();
  });

  it("returns invalid_request envelopes for malformed review thread PR numbers", async () => {
    const forgeClient = fakeForge();
    app = buildStatioServer({ forgeClient, token: "secret" });

    for (const number of ["abc", "0", "-1", "1.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/prs/${number}/review-threads`,
        headers: { authorization: "Bearer secret" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    }
    expect(forgeClient.reviewThreads).not.toHaveBeenCalled();
  });

  it("returns owner-unavailable empty review thread results as a success", async () => {
    const forgeClient = fakeForge({ reviewThreads: vi.fn().mockResolvedValue([]) });
    app = buildStatioServer({ forgeClient, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42/review-threads",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ threads: [] });
  });

  it("maps review thread forge failures to forge_error envelopes", async () => {
    app = buildStatioServer({
      forgeClient: fakeForge({
        reviewThreads: vi.fn(async () => {
          throw new StatioForgeError("gh api graphql failed");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42/review-threads",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { code: "forge_error", message: "gh api graphql failed" },
    });
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

  it("maps not-found failures to not_found envelopes", async () => {
    app = buildStatioServer({
      repoReader: fakeReader({
        repoInfo: vi.fn(async () => {
          throw new StatioNotFoundError("pull request not found");
        }),
      }),
      token: "secret",
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "not_found", message: "pull request not found" },
    });
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

  it("keeps slice correlation on pull request reads", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ forgeClient: fakeForge(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42",
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
      "statio.route": "/v1/prs/:number",
      "statio.status_class": "2xx",
    });
  });

  it("keeps slice correlation on pull request list reads", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ forgeClient: fakeForge(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs?head=feature%2Fstatio",
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
      "statio.route": "/v1/prs",
      "statio.status_class": "2xx",
    });
  });

  it("keeps slice correlation on review thread reads", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ forgeClient: fakeForge(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prs/42/review-threads",
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
      "statio.route": "/v1/prs/:number/review-threads",
      "statio.status_class": "2xx",
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

  it("emits a success-outcome span for a 4xx auth failure", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    app = buildStatioServer({ repoReader: fakeReader(), token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer wrong" },
    });

    expect(res.statusCode).toBe(401);
    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.attributes).toMatchObject({
      "statio.status_class": "4xx",
      "statio.outcome": "success",
    });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("emits a failure-outcome error span for a 5xx forge failure", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    const reader = fakeReader({
      repoInfo: vi.fn().mockRejectedValue(new StatioForgeError("forge down")),
    });
    app = buildStatioServer({ repoReader: reader, token: "secret" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/repo",
      headers: { authorization: "Bearer secret" },
    });

    expect(res.statusCode).toBe(502);
    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.attributes).toMatchObject({
      "statio.status_class": "5xx",
      "statio.outcome": "failure",
    });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
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
    app =
      "getPr" in reader
        ? buildStatioServer({ forgeClient: reader as StatioRouteForgeClient, token })
        : buildStatioServer({ repoReader: reader, token });
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

  it("lets the async client call the authorized /v1/prs/:number route", async () => {
    const forgeClient = fakeForge();
    const baseUrl = await listen(forgeClient);
    const client = new StatioClient({ baseUrl, token: "secret", traceKey: "slice-abc" });

    await expect(client.getPr(42)).resolves.toEqual(PR);
    expect(forgeClient.getPr).toHaveBeenCalledWith(42);
  });

  it("lets the async client call the authorized /v1/prs route with author and state filters", async () => {
    const forgeClient = fakeForge();
    const baseUrl = await listen(forgeClient);
    const client = new StatioClient({ baseUrl, token: "secret", traceKey: "slice-abc" });

    await expect(client.listPrs({ author: "@me", state: "open" })).resolves.toEqual(PR_LIST);
    expect(forgeClient.listPrs).toHaveBeenCalledWith({
      author: "@me",
      head: undefined,
      state: "open",
    });
  });

  it("lets the async client call the authorized /v1/prs/:number/review-threads route", async () => {
    const forgeClient = fakeForge();
    const baseUrl = await listen(forgeClient);
    const client = new StatioClient({ baseUrl, token: "secret", traceKey: "slice-abc" });

    await expect(client.reviewThreads(42)).resolves.toEqual(REVIEW_THREADS);
    expect(forgeClient.reviewThreads).toHaveBeenCalledWith(42);
  });

  it("forwards client trace headers to the pull request list service route", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    const baseUrl = await listen(fakeForge());
    const client = new StatioClient({ baseUrl, token: "secret", traceKey: "slice-client" });

    await expect(client.listPrs({ author: "@me", state: "open" })).resolves.toEqual(PR_LIST);

    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-client"));
    expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-client"));
    expect(span.attributes["statio.route"]).toBe("/v1/prs");
  });

  it("forwards client trace headers to the review thread service route", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const spans = captureSpans();
    const baseUrl = await listen(fakeForge());
    const client = new StatioClient({ baseUrl, token: "secret", traceKey: "slice-client" });

    await expect(client.reviewThreads(42)).resolves.toEqual(REVIEW_THREADS);

    const span = spans.find((s) => s.name === "statio.request")!;
    expect(span).toBeDefined();
    expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-client"));
    expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-client"));
    expect(span.attributes["statio.route"]).toBe("/v1/prs/:number/review-threads");
  });

  it("lets the async client call the authorized /v1/prs route with head filters", async () => {
    const forgeClient = fakeForge();
    const baseUrl = await listen(forgeClient);
    const client = new StatioClient({ baseUrl, token: "secret" });

    await expect(client.listPrs({ head: "feature/statio" })).resolves.toEqual(PR_LIST);
    expect(forgeClient.listPrs).toHaveBeenCalledWith({
      author: undefined,
      head: "feature/statio",
      state: undefined,
    });
  });

  it("preserves empty pull request list responses through the client boundary", async () => {
    const forgeClient = fakeForge({ listPrs: vi.fn().mockResolvedValue([]) });
    const baseUrl = await listen(forgeClient);
    const client = new StatioClient({ baseUrl, token: "secret" });

    await expect(client.listPrs({ head: "missing" })).resolves.toEqual([]);
  });

  it("maps service-generated non-2xx envelopes to client errors", async () => {
    const baseUrl = await listen(fakeReader());
    const client = new StatioClient({ baseUrl, token: "wrong" });

    await expect(client.repoInfo()).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  it("maps pull request route envelopes to client errors", async () => {
    const baseUrl = await listen(
      fakeForge({
        getPr: vi.fn(async () => {
          throw new StatioForgeError("gh down");
        }),
      }),
    );
    const client = new StatioClient({ baseUrl, token: "secret" });

    await expect(client.getPr(42)).rejects.toMatchObject({
      code: "forge_error",
      status: 502,
      message: "gh down",
    });
  });

  it("maps pull request list route envelopes to client errors", async () => {
    const baseUrl = await listen(
      fakeForge({
        listPrs: vi.fn(async () => {
          throw new StatioForgeError("gh list down");
        }),
      }),
    );
    const client = new StatioClient({ baseUrl, token: "secret" });

    await expect(client.listPrs({ author: "@me" })).rejects.toMatchObject({
      code: "forge_error",
      status: 502,
      message: "gh list down",
    });
  });

  it("maps review thread route envelopes to client errors", async () => {
    const baseUrl = await listen(
      fakeForge({
        reviewThreads: vi.fn(async () => {
          throw new StatioForgeError("gh api graphql down");
        }),
      }),
    );
    const client = new StatioClient({ baseUrl, token: "secret" });

    await expect(client.reviewThreads(42)).rejects.toMatchObject({
      code: "forge_error",
      status: 502,
      message: "gh api graphql down",
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
