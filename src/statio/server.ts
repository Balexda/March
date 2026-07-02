import { timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { emitStatioRequestSpan } from "../observability/statio-trace.js";
import { CLI_VERSION } from "../shared/version.js";
import { createGhForgeAdapter } from "./adapter.js";
import { STATIO_SERVICE_NAME } from "./config.js";
import type { RepoMetadataReader } from "./forge.js";
import {
  type ForgeClient,
  type ForgeErrorCode,
  type ListPrsRequest,
  StatioForgeError,
  StatioNotFoundError,
  StatioValidationError,
} from "./types.js";

type StatioRouteForgeClient = Pick<ForgeClient, "repoInfo" | "listPrs" | "getPr" | "reachable">;

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
      ? Fastify({ logger: loggerOption })
      : Fastify({ loggerInstance: loggerOption });

  app.addHook("onResponse", async (request, reply) => {
    const slice = request.headers["x-march-slice-id"];
    const sliceId = Array.isArray(slice) ? slice[0] : slice;
    // Fastify tracks request duration on a monotonic clock; backdate the span
    // start from it rather than recording our own wall-clock timestamp.
    const endTimeMs = Date.now();
    emitStatioRequestSpan({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      sliceId,
      startTimeMs: endTimeMs - reply.elapsedTime,
      endTimeMs,
    });
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

  app.get("/v1/repo", async () => ({ repo: await repoReader.repoInfo() }));

  app.get("/v1/prs", async (request) => {
    const filters = parseListPrsQuery(request.query);
    return { prs: await forgeClient.listPrs(filters) };
  });

  app.get<{ Params: { number: string } }>("/v1/prs/:number", async (request) => {
    const number = parsePullRequestNumber(request.params.number);
    return { pr: await forgeClient.getPr(number) };
  });

  return app;
}
