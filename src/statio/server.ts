import { timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { emitStatioRequestSpan } from "../observability/statio-trace.js";
import { CLI_VERSION } from "../shared/version.js";
import { STATIO_SERVICE_NAME } from "./config.js";
import { createGhRepoMetadataReader, type RepoMetadataReader } from "./forge.js";
import {
  type ForgeErrorCode,
  StatioForgeError,
  StatioValidationError,
} from "./types.js";

export interface BuildStatioServerOptions {
  readonly repoReader?: RepoMetadataReader;
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

export function buildStatioServer(options: BuildStatioServerOptions = {}): FastifyInstance {
  const repoReader = options.repoReader ?? createGhRepoMetadataReader();
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

  return app;
}
