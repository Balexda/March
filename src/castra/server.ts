import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { CLI_VERSION } from "../shared/version.js";
import {
  CASTRA_DEFAULT_GROUP,
  CASTRA_SERVICE_NAME,
  CASTRA_SETTABLE_KEYS,
  IDENTIFIER_PATTERN,
} from "./config.js";
import {
  createAgentDeckAdapter,
  type AgentDeckAdapter,
} from "./adapter.js";
import { recordCastraRequest, statusClass, withCastraSpan } from "./metrics.js";
import {
  CastraAgentDeckError,
  CastraConflictError,
  CastraNotFoundError,
  type CastraErrorCode,
  CastraValidationError,
} from "./types.js";

/** Header consumers set to thread a dispatch slice id into Castra's traces. */
const SLICE_ID_HEADER = "x-march-slice-id";

export interface BuildServerOptions {
  /** agent-deck adapter; defaults to the real execFileSync-backed one. */
  readonly adapter?: AgentDeckAdapter;
  /**
   * Shared bearer token gating `/v1/*`. When empty/undefined, auth is disabled
   * (open) — the serve entry warns at startup so this is a deliberate, visible
   * posture rather than a silent hole.
   */
  readonly token?: string;
  /** Fastify logger config; defaults to off (callers/tests opt in). */
  readonly logger?: boolean;
  /** Process start time for `/status` uptime; defaults to now. */
  readonly startedAt?: number;
}

// Reusable JSON-schema fragments (kept in sync with config.ts validators).
const profileSchema = {
  type: "string",
  pattern: IDENTIFIER_PATTERN,
  maxLength: 64,
} as const;
const groupSchema = { type: "string", pattern: IDENTIFIER_PATTERN, maxLength: 64 } as const;
const sessionIdParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", maxLength: 128 } },
} as const;

function errorBody(code: CastraErrorCode, message: string) {
  return { error: { code, message } };
}

function extractProfile(request: FastifyRequest): string {
  const fromQuery = (request.query as { profile?: unknown } | undefined)?.profile;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  const fromBody = (request.body as { profile?: unknown } | undefined)?.profile;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  return "unknown";
}

function traceKeyFor(request: FastifyRequest): string {
  const header = request.headers[SLICE_ID_HEADER];
  if (typeof header === "string" && header) return header;
  return `castra-${randomUUID()}`;
}

function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Build the Castra Fastify app. The agent-deck adapter is injected so tests can
 * pass a fake and exercise routing/validation/auth without a real agent-deck.
 * Caller is responsible for `listen()` / `close()`.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const adapter = options.adapter ?? createAgentDeckAdapter();
  const token = options.token?.trim() || undefined;
  const startedAt = options.startedAt ?? Date.now();

  const app = Fastify({ logger: options.logger ?? false });

  // Auth: gate every /v1/* route behind the shared bearer token. Health/status
  // stay open. Skipped entirely when no token is configured.
  app.addHook("onRequest", async (request, reply) => {
    if (!token) return;
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/v1")) return;
    if (!bearerMatches(request.headers.authorization, token)) {
      await reply
        .code(401)
        .send(errorBody("unauthorized", "Missing or invalid bearer token."));
    }
  });

  // Metrics: one counter+histogram sample per response, low-cardinality labels.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unknown";
    const status = reply.statusCode;
    recordCastraRequest({
      route,
      method: request.method,
      statusClass: statusClass(status),
      profile: extractProfile(request),
      outcome: status < 500 ? "success" : "failure",
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  app.setErrorHandler((err: Error & { validation?: unknown }, request, reply) => {
    if (err.validation) {
      void reply.code(400).send(errorBody("invalid_request", err.message));
      return;
    }
    if (err instanceof CastraValidationError) {
      void reply.code(400).send(errorBody("invalid_request", err.message));
      return;
    }
    if (err instanceof CastraNotFoundError) {
      void reply.code(404).send(errorBody("not_found", err.message));
      return;
    }
    if (err instanceof CastraConflictError) {
      void reply.code(409).send(errorBody("conflict", err.message));
      return;
    }
    if (err instanceof CastraAgentDeckError) {
      void reply.code(502).send(errorBody("agent_deck_error", err.message));
      return;
    }
    // Unexpected error: log the full detail server-side, but return a generic
    // message so paths/stderr/dependency internals don't leak to clients and
    // the public 500 contract stays stable.
    request.log.error({ err }, "unhandled castra error");
    void reply.code(500).send(errorBody("internal", "Internal server error."));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorBody("not_found", `No route for ${request.method} ${request.url}`));
  });

  // --- health / status (open) ---------------------------------------------
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/status", async () => ({
    service: CASTRA_SERVICE_NAME,
    version: CLI_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    agentDeck: { reachable: adapter.reachable() },
  }));

  // --- sessions ------------------------------------------------------------
  app.get(
    "/v1/sessions",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["profile"],
          properties: { profile: profileSchema, group: groupSchema },
        },
      },
    },
    async (request) => {
      const { profile, group } = request.query as { profile: string; group?: string };
      return { sessions: adapter.list({ profile, group }) };
    },
  );

  app.post(
    "/v1/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["profile", "repoPath", "branch", "title"],
          properties: {
            profile: profileSchema,
            repoPath: { type: "string", minLength: 1 },
            branch: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            group: groupSchema,
            model: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        profile: string;
        repoPath: string;
        branch: string;
        title: string;
        group?: string;
        model?: string;
      };
      const session = withCastraSpan(
        {
          op: "launch",
          traceKey: traceKeyFor(request),
          attributes: { "march.profile": body.profile, "castra.branch": body.branch },
        },
        () =>
          adapter.launch({
            profile: body.profile,
            repoPath: body.repoPath,
            branch: body.branch,
            title: body.title,
            group: body.group ?? CASTRA_DEFAULT_GROUP,
            model: body.model,
          }),
      );
      return reply.code(201).send({ session });
    },
  );

  app.get(
    "/v1/sessions/:id",
    {
      schema: {
        params: sessionIdParams,
        querystring: {
          type: "object",
          required: ["profile"],
          properties: { profile: profileSchema },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { profile } = request.query as { profile: string };
      return { session: adapter.show({ profile, sessionId: id }) };
    },
  );

  app.post(
    "/v1/sessions/:id/send",
    {
      schema: {
        params: sessionIdParams,
        body: {
          type: "object",
          required: ["profile", "prompt"],
          properties: { profile: profileSchema, prompt: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { profile, prompt } = request.body as { profile: string; prompt: string };
      withCastraSpan(
        { op: "send", traceKey: traceKeyFor(request), attributes: { "march.profile": profile } },
        () => adapter.send({ profile, sessionId: id, prompt }),
      );
      return reply.code(202).send({ ok: true });
    },
  );

  app.get(
    "/v1/sessions/:id/output",
    {
      schema: {
        params: sessionIdParams,
        querystring: {
          type: "object",
          required: ["profile"],
          properties: {
            profile: profileSchema,
            lines: { type: "integer", minimum: 1, maximum: 100000 },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { profile, lines } = request.query as { profile: string; lines?: number };
      return adapter.output({ profile, sessionId: id, lines });
    },
  );

  app.post(
    "/v1/sessions/:id/set",
    {
      schema: {
        params: sessionIdParams,
        body: {
          type: "object",
          required: ["profile", "key", "value"],
          properties: {
            profile: profileSchema,
            key: { type: "string", enum: [...CASTRA_SETTABLE_KEYS] },
            value: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { profile, key, value } = request.body as {
        profile: string;
        key: string;
        value: string;
      };
      withCastraSpan(
        { op: "set", traceKey: traceKeyFor(request), attributes: { "march.profile": profile } },
        () => adapter.set({ profile, sessionId: id, key, value }),
      );
      return { ok: true };
    },
  );

  app.delete(
    "/v1/sessions/:id",
    {
      schema: {
        params: sessionIdParams,
        querystring: {
          type: "object",
          required: ["profile"],
          properties: {
            profile: profileSchema,
            pruneWorktree: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { profile, pruneWorktree } = request.query as {
        profile: string;
        pruneWorktree?: boolean;
      };
      const result = withCastraSpan(
        { op: "remove", traceKey: traceKeyFor(request), attributes: { "march.profile": profile } },
        () => adapter.remove({ profile, sessionId: id, pruneWorktree: pruneWorktree ?? false }),
      );
      return { ok: true, removed: result.removed };
    },
  );

  return app;
}
