import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
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
  createAgentDeckRecoveryRuntime,
  type AgentDeckAdapter,
  type RecoveryRuntime,
} from "./adapter.js";
import { recoverErrorSessions, type RecoverDeps } from "./recovery.js";
import {
  type CastraSpanContext,
  recordCastraRequest,
  statusClass,
  withCastraSpan,
} from "./metrics.js";
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
  /**
   * Fastify logger. Pass a pino instance (the serve entry passes
   * `createCastraLogger()` so request logs ship to Loki under
   * `service_name=march-castra`) or a boolean. Defaults to off so callers/tests
   * opt in.
   */
  readonly logger?: FastifyBaseLogger | boolean;
  /** Process start time for `/status` uptime; defaults to now. */
  readonly startedAt?: number;
  /**
   * Recovery sweep dependencies (#castra-recover). `runtime` defaults to the
   * real agent-deck/tmux-backed {@link createAgentDeckRecoveryRuntime}; the
   * remaining fields (sleep/now/timeouts) let tests run the sweep without real
   * timers or a live agent-deck. `sleep` defaults to a real `setTimeout`.
   */
  readonly recovery?: Partial<RecoverDeps> & { readonly runtime?: RecoveryRuntime };
}

/** Real-timer sleep used by the recovery sweep unless a test injects its own. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** The dispatch slice id from the x-march-slice-id header, when the caller set it. */
function sliceIdFrom(request: FastifyRequest): string | undefined {
  const header = request.headers[SLICE_ID_HEADER];
  return typeof header === "string" && header ? header : undefined;
}

function traceKeyFor(request: FastifyRequest): string {
  return sliceIdFrom(request) ?? `castra-${randomUUID()}`;
}

/** Max prompt chars recorded on a span/log — a preview for investigation, never the full body. */
const MESSAGE_PREVIEW_MAX = 200;

function messagePreview(prompt: string): string {
  return prompt.length > MESSAGE_PREVIEW_MAX
    ? `${prompt.slice(0, MESSAGE_PREVIEW_MAX)}…`
    : prompt;
}

/** A `march.slice_id` attribute fragment, present only when the header was set. */
function sliceAttr(sliceId: string | undefined): { "march.slice_id"?: string } {
  return sliceId ? { "march.slice_id": sliceId } : {};
}

/**
 * Trace-context log fields for the `castra.<op>` span. Attached EXPLICITLY (no
 * ContextManager is registered, so the pino traceMixin sees no active span);
 * the pino→OTel bridge promotes these to the log record's trace context so
 * Grafana's "Logs for this span" resolves. Empty when telemetry is off.
 */
function traceLogFields(
  span: CastraSpanContext | undefined,
): { trace_id?: string; span_id?: string } {
  return span ? { trace_id: span.traceId, span_id: span.spanId } : {};
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

  // Recovery sweep deps: real agent-deck/tmux runtime + real-timer sleep unless
  // a test overrides them. Built once and reused per `POST /v1/sessions/recover`.
  const recoveryRuntime = options.recovery?.runtime ?? createAgentDeckRecoveryRuntime();
  const recoverDeps: RecoverDeps = {
    runtime: recoveryRuntime,
    sleep: options.recovery?.sleep ?? defaultSleep,
    ...(options.recovery?.now ? { now: options.recovery.now } : {}),
    ...(options.recovery?.pickerTimeoutMs !== undefined
      ? { pickerTimeoutMs: options.recovery.pickerTimeoutMs }
      : {}),
    ...(options.recovery?.pickerPollMs !== undefined
      ? { pickerPollMs: options.recovery.pickerPollMs }
      : {}),
    ...(options.recovery?.statusTimeoutMs !== undefined
      ? { statusTimeoutMs: options.recovery.statusTimeoutMs }
      : {}),
    ...(options.recovery?.statusPollMs !== undefined
      ? { statusPollMs: options.recovery.statusPollMs }
      : {}),
  };

  // A logger instance wires through Fastify's `loggerInstance`; a boolean (or
  // the off default) goes through `logger` so request logs stay disabled.
  const loggerOption = options.logger ?? false;
  const app =
    typeof loggerOption === "boolean"
      ? Fastify({ logger: loggerOption })
      : Fastify({ loggerInstance: loggerOption });

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
            createBranch: { type: "boolean" },
            // Queryable session metadata (#214): a small string→string map Castra
            // stores and returns from listSessions/show. Bounded on key length,
            // value length, AND entry count so it stays a correlation map, not
            // arbitrary blob storage / an unbounded request.
            metadata: {
              type: "object",
              maxProperties: 16,
              propertyNames: { type: "string", maxLength: 64 },
              additionalProperties: { type: "string", maxLength: 256 },
            },
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
        createBranch?: boolean;
        metadata?: Record<string, string>;
      };
      const sliceId = sliceIdFrom(request);
      const session = withCastraSpan(
        {
          op: "launch",
          traceKey: traceKeyFor(request),
          attributes: {
            "march.profile": body.profile,
            "castra.branch": body.branch,
            ...sliceAttr(sliceId),
          },
        },
        (span) => {
          const launched = adapter.launch({
            profile: body.profile,
            repoPath: body.repoPath,
            branch: body.branch,
            title: body.title,
            group: body.group ?? CASTRA_DEFAULT_GROUP,
            model: body.model,
            createBranch: body.createBranch,
            metadata: body.metadata,
          });
          request.log.info(
            {
              "castra.op": "launch",
              "castra.session_id": launched.sessionId,
              "march.profile": body.profile,
              "castra.branch": body.branch,
              ...sliceAttr(sliceId),
              ...traceLogFields(span),
            },
            "castra session launched",
          );
          return launched;
        },
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
      const sliceId = sliceIdFrom(request);
      const sendFields = {
        "march.profile": profile,
        "castra.session_id": id,
        "castra.message_bytes": Buffer.byteLength(prompt, "utf8"),
        "castra.message_preview": messagePreview(prompt),
        ...sliceAttr(sliceId),
      };
      withCastraSpan(
        { op: "send", traceKey: traceKeyFor(request), attributes: sendFields },
        (span) => {
          request.log.info(
            { "castra.op": "send", ...sendFields, ...traceLogFields(span) },
            "castra send accepted",
          );
          return adapter.send({ profile, sessionId: id, prompt });
        },
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
      const sliceId = sliceIdFrom(request);
      const setFields = {
        "march.profile": profile,
        "castra.session_id": id,
        "castra.set_key": key,
        ...sliceAttr(sliceId),
      };
      withCastraSpan(
        { op: "set", traceKey: traceKeyFor(request), attributes: setFields },
        (span) => {
          request.log.info(
            { "castra.op": "set", ...setFields, ...traceLogFields(span) },
            "castra session set",
          );
          return adapter.set({ profile, sessionId: id, key, value });
        },
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
      const sliceId = sliceIdFrom(request);
      const removeFields = {
        "march.profile": profile,
        "castra.session_id": id,
        "castra.prune_worktree": pruneWorktree ?? false,
        ...sliceAttr(sliceId),
      };
      const result = withCastraSpan(
        { op: "remove", traceKey: traceKeyFor(request), attributes: removeFields },
        (span) => {
          request.log.info(
            { "castra.op": "remove", ...removeFields, ...traceLogFields(span) },
            "castra session removed",
          );
          return adapter.remove({ profile, sessionId: id, pruneWorktree: pruneWorktree ?? false });
        },
      );
      return { ok: true, removed: result.removed };
    },
  );

  app.post(
    "/v1/sessions/recover",
    {
      schema: {
        body: {
          type: "object",
          required: ["profile"],
          properties: {
            profile: profileSchema,
            group: groupSchema,
            // Explicit session-id targeting for a controlled "recover just these"
            // sweep (bounded so the body stays a targeting list, not a blob).
            sessionIds: {
              type: "array",
              maxItems: 64,
              items: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", maxLength: 128 },
            },
          },
        },
      },
    },
    async (request) => {
      const { profile, group, sessionIds } = request.body as {
        profile: string;
        group?: string;
        sessionIds?: string[];
      };
      const sliceId = sliceIdFrom(request);
      // Run the sweep first (it awaits restarts + picker/status polls), then
      // record a correlated summary span/log. HTTP latency is captured by the
      // onResponse metrics hook, so the marker span stays zero-duration.
      const report = await recoverErrorSessions(recoverDeps, {
        profile,
        ...(group ? { group } : {}),
        ...(sessionIds && sessionIds.length ? { sessionIds } : {}),
      });
      const resolved = report.recovered.filter((r) => r.outcome !== "restart_failed").length;
      const pickers = report.recovered.filter((r) => r.pickerResolved).length;
      withCastraSpan(
        {
          op: "recover",
          traceKey: traceKeyFor(request),
          attributes: {
            "march.profile": profile,
            ...(group ? { "castra.group": group } : {}),
            "castra.recover_total": report.recovered.length,
            "castra.recover_resolved": resolved,
            "castra.recover_pickers": pickers,
            ...sliceAttr(sliceId),
          },
        },
        (span) => {
          request.log.info(
            {
              "castra.op": "recover",
              "march.profile": profile,
              ...(group ? { "castra.group": group } : {}),
              "castra.recover_total": report.recovered.length,
              "castra.recover_resolved": resolved,
              "castra.recover_pickers": pickers,
              ...sliceAttr(sliceId),
              ...traceLogFields(span),
            },
            "castra recovery sweep",
          );
        },
      );
      return report;
    },
  );

  return app;
}
