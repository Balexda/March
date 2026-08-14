import { timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import {
  recordStatioRequest,
  statusClass,
} from "../observability/statio-metrics.js";
import {
  emitStatioRequestSpan,
  type StatioSpanContext,
  validStatioSliceId,
  withStatioOperationSpan,
} from "../observability/statio-trace.js";
import { CLI_VERSION } from "../shared/version.js";
import { createGhForgeAdapter } from "./adapter.js";
import { STATIO_SERVICE_NAME } from "./config.js";
import type { RepoMetadataReader } from "./forge.js";
import {
  type ForgeClient,
  type ForgeErrorCode,
  type ListPrsRequest,
  type ReviewThread,
  StatioForgeError,
  StatioNotFoundError,
  StatioValidationError,
} from "./types.js";

type StatioRouteForgeClient = Pick<
  ForgeClient,
  "repoInfo" | "listPrs" | "getPr" | "reviewThreads" | "reachable"
>;

export interface BuildStatioServerOptions {
  readonly repoReader?: RepoMetadataReader;
  readonly forgeClient?: StatioRouteForgeClient;
  readonly token?: string;
  readonly logger?: FastifyBaseLogger | boolean;
  readonly startedAt?: number;
}

function errorBody(code: ForgeErrorCode, message: string) {
  return { error: { code, message } };
}

function sliceIdFrom(request: FastifyRequest): string | undefined {
  const slice = request.headers["x-march-slice-id"];
  return Array.isArray(slice) ? slice[0] : slice;
}

function operationForRoute(route: string | undefined): string {
  switch (route) {
    case "/healthz":
      return "healthz";
    case "/status":
      return "status";
    case "/v1/repo":
      return "repo_info";
    case "/v1/prs":
      return "list_prs";
    case "/v1/prs/:number":
      return "get_pr";
    case "/v1/prs/:number/review-threads":
      return "review_threads";
    default:
      return "unmatched";
  }
}

function traceLogFields(
  span: StatioSpanContext | undefined,
): { trace_id?: string; span_id?: string } {
  return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
}

function sliceAttr(sliceId: string | undefined): { "march.slice_id"?: string } {
  const valid = validStatioSliceId(sliceId);
  return valid ? { "march.slice_id": valid } : {};
}

function statioLogFields(
  request: FastifyRequest,
  route: string,
  statusCode: number,
  durationMs: number,
  span: StatioSpanContext | undefined,
) {
  const operation = operationForRoute(route);
  return {
    "statio.method": request.method,
    "statio.route": route,
    "statio.status_class": statusClass(statusCode),
    "statio.operation": operation,
    "statio.outcome": statusCode >= 500 ? "failure" : "success",
    "statio.duration_ms": Math.round(durationMs),
    ...traceLogFields(span),
  };
}

function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function createDefaultForgeClient(): StatioRouteForgeClient {
  const adapter = createGhForgeAdapter();
  return {
    repoInfo: adapter.repoInfo,
    listPrs: adapter.listPrs,
    getPr: adapter.getPr,
    reviewThreads: adapter.reviewThreads,
    async reachable(): Promise<boolean> {
      try {
        await adapter.repoInfo();
        return true;
      } catch {
        return false;
      }
    },
  };
}

function parsePullRequestNumber(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new StatioValidationError(
      `Pull request number must be a positive integer; received ${raw}.`,
    );
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) {
    throw new StatioValidationError(
      `Pull request number must be a safe integer; received ${raw}.`,
    );
  }
  return number;
}

function parseOptionalQueryString(
  value: unknown,
  field: "author" | "head",
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new StatioValidationError(`${field} must be a non-empty string when provided.`);
  }
  return value;
}

function parseListPrsQuery(query: unknown): ListPrsRequest {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new StatioValidationError("PR list query must be an object.");
  }
  const record = query as Record<string, unknown>;
  const state = record.state;
  if (
    state !== undefined &&
    state !== "open" &&
    state !== "closed" &&
    state !== "merged" &&
    state !== "all"
  ) {
    throw new StatioValidationError(
      "state must be one of open, closed, merged, or all when provided.",
    );
  }

  return {
    author: parseOptionalQueryString(record.author, "author"),
    head: parseOptionalQueryString(record.head, "head"),
    state: state as ListPrsRequest["state"],
  };
}

export function buildStatioServer(options: BuildStatioServerOptions = {}): FastifyInstance {
  const forgeClient = options.forgeClient ?? createDefaultForgeClient();
  const repoReader = options.repoReader ?? forgeClient;
  const token = options.token?.trim() || undefined;
  const startedAt = options.startedAt ?? Date.now();
  const loggerOption = options.logger ?? false;
  const app =
    typeof loggerOption === "boolean"
      ? Fastify({ logger: loggerOption, disableRequestLogging: true })
      : Fastify({ loggerInstance: loggerOption, disableRequestLogging: true });

  app.addHook("onResponse", async (request, reply) => {
    const sliceId = sliceIdFrom(request);
    const route = request.routeOptions.url ?? "unmatched";
    const status = reply.statusCode;
    // Fastify tracks request duration on a monotonic clock; backdate the span
    // start from it rather than recording our own wall-clock timestamp.
    const endTimeMs = Date.now();
    const span = emitStatioRequestSpan({
      method: request.method,
      route,
      statusCode: status,
      sliceId,
      startTimeMs: endTimeMs - reply.elapsedTime,
      endTimeMs,
    });
    recordStatioRequest({
      route,
      method: request.method,
      statusClass: statusClass(status),
      operation: operationForRoute(route),
      outcome: status >= 500 ? "failure" : "success",
      durationSeconds: reply.elapsedTime / 1000,
    });
    request.log.info(
      statioLogFields(request, route, status, reply.elapsedTime, span),
      "statio request handled",
    );
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!token) return;
    const pathname = request.url.split("?")[0] ?? "";
    if (pathname !== "/v1" && !pathname.startsWith("/v1/")) return;
    if (!bearerMatches(request.headers.authorization, token)) {
      return reply
        .code(401)
        .send(errorBody("unauthorized", "Missing or invalid bearer token."));
    }
  });

  app.setErrorHandler((err: Error & { validation?: unknown }, request, reply) => {
    if (err.validation || err instanceof StatioValidationError) {
      void reply.code(400).send(errorBody("invalid_request", err.message));
      return;
    }
    if (err instanceof StatioForgeError) {
      void reply.code(502).send(errorBody("forge_error", err.message));
      return;
    }
    if (err instanceof StatioNotFoundError) {
      void reply.code(404).send(errorBody("not_found", err.message));
      return;
    }
    request.log.error({ err }, "unhandled statio error");
    void reply.code(500).send(errorBody("internal", "Internal server error."));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorBody("not_found", `No route for ${request.method} ${request.url}`));
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/status", async () => ({
    service: STATIO_SERVICE_NAME,
    version: CLI_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    gh: { reachable: await repoReader.reachable() },
  }));

  app.get("/v1/repo", async (request) => {
    const sliceId = sliceIdFrom(request);
    return withStatioOperationSpan(
      {
        operation: "repo_info",
        route: "/v1/repo",
        method: request.method,
        sliceId,
        attributes: sliceAttr(sliceId),
      },
      async (span) => {
        const repo = await repoReader.repoInfo();
        request.log.info(
          {
            "statio.operation": "repo_info",
            "statio.route": "/v1/repo",
            ...traceLogFields(span),
          },
          "statio operation handled",
        );
        return { repo };
      },
    );
  });

  app.get("/v1/prs", async (request) => {
    const filters = parseListPrsQuery(request.query);
    const sliceId = sliceIdFrom(request);
    return withStatioOperationSpan(
      {
        operation: "list_prs",
        route: "/v1/prs",
        method: request.method,
        sliceId,
        attributes: {
          ...sliceAttr(sliceId),
          "statio.has_head_filter": filters.head !== undefined,
          "statio.has_author_filter": filters.author !== undefined,
          "statio.state_filter": filters.state ?? "default",
        },
      },
      async (span) => {
        const prs = await forgeClient.listPrs(filters);
        request.log.info(
          {
            "statio.operation": "list_prs",
            "statio.route": "/v1/prs",
            "statio.has_head_filter": filters.head !== undefined,
            "statio.has_author_filter": filters.author !== undefined,
            "statio.state_filter": filters.state ?? "default",
            ...traceLogFields(span),
          },
          "statio operation handled",
        );
        return { prs };
      },
    );
  });

  app.get<{ Params: { number: string } }>("/v1/prs/:number", async (request) => {
    const number = parsePullRequestNumber(request.params.number);
    const sliceId = sliceIdFrom(request);
    return withStatioOperationSpan(
      {
        operation: "get_pr",
        route: "/v1/prs/:number",
        method: request.method,
        sliceId,
        attributes: sliceAttr(sliceId),
      },
      async (span) => {
        const pr = await forgeClient.getPr(number);
        request.log.info(
          {
            "statio.operation": "get_pr",
            "statio.route": "/v1/prs/:number",
            ...traceLogFields(span),
          },
          "statio operation handled",
        );
        return { pr };
      },
    );
  });

  app.get<{ Params: { number: string } }>(
    "/v1/prs/:number/review-threads",
    async (request): Promise<{ threads: ReviewThread[] }> => {
      const number = parsePullRequestNumber(request.params.number);
      const sliceId = sliceIdFrom(request);
      return withStatioOperationSpan(
        {
          operation: "review_threads",
          route: "/v1/prs/:number/review-threads",
          method: request.method,
          sliceId,
          attributes: sliceAttr(sliceId),
        },
        async (span) => {
          const threads = await forgeClient.reviewThreads(number);
          request.log.info(
            {
              "statio.operation": "review_threads",
              "statio.route": "/v1/prs/:number/review-threads",
              ...traceLogFields(span),
            },
            "statio operation handled",
          );
          return { threads };
        },
      );
    },
  );

  return app;
}
