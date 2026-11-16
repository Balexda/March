import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { recordTesseraDenial, recordTesseraIssuance } from "../observability/tessera-metrics.js";
import { emitTesseraIssueSpan } from "../observability/tessera-trace.js";
import { type AuditContext, buildAuditRecord, createAuditContext } from "./audit.js";
import type { ClientRegistry } from "./auth/client-keys.js";
import { type Policy, authorize } from "./auth/policy.js";
import { TESSERA_SERVICE_NAME } from "./config.js";
import { isValidRepo } from "./repo-name.js";
import {
  type AccessLevel,
  type CredentialProvider,
  type Entitlement,
  type EntitlementRequest,
  type Identity,
  type ProviderStatus,
  ProviderUnavailableError,
  ProviderUnconfiguredError,
  type TesseraErrorBody,
  type TesseraErrorCode,
  TESSERA_SLICE_ID_HEADER,
  TesseraError,
  TesseraValidationError,
  UnauthorizedError,
} from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The authenticated client's name for a `/v1/*` request, set by the
     * client-key hook before the route runs; `undefined` on open routes.
     * Never returned in a response body or header.
     */
    tesseraClient: string | undefined;
    /**
     * What a `POST /v1/github/token` request has resolved so far, filled in
     * as it proceeds and read once, when the reply is sent, to emit its
     * `tessera.audit` event; `undefined` on every other route.
     */
    tesseraAudit: AuditContext | undefined;
  }
}

/** The token route's pattern; the only route that is audited. */
const TOKEN_ROUTE = "/v1/github/token";

/** Matched on the route pattern and method, so no other or unmatched path is audited. */
function isTokenRequest(request: FastifyRequest): boolean {
  return request.method === "POST" && request.routeOptions.url === TOKEN_ROUTE;
}

/** The providers the token route dispatches to, keyed by the identity they serve. */
export interface ProviderRegistry {
  /** The provider serving exactly this identity, if one is registered. */
  get(identity: Identity): CredentialProvider | undefined;
  /** Every registered provider, in registration order. */
  list(): readonly CredentialProvider[];
}

/**
 * Build a registry from providers. Each identity has at most one provider, so
 * a request can never be served by a provider for a different identity.
 */
export function createProviderRegistry(
  providers: readonly CredentialProvider[],
): ProviderRegistry {
  const byIdentity = new Map<Identity, CredentialProvider>();
  for (const provider of providers) {
    if (byIdentity.has(provider.identity)) {
      throw new TesseraValidationError(
        `More than one provider registered for identity "${provider.identity}".`,
      );
    }
    byIdentity.set(provider.identity, provider);
  }
  const list = Object.freeze([...providers]);
  return {
    get: (identity) => byIdentity.get(identity),
    list: () => list,
  };
}

export interface BuildTesseraServerOptions {
  /** The credential providers the token route dispatches to. */
  readonly registry: ProviderRegistry;
  /**
   * The registered clients every `/v1/*` request authenticates against.
   * Required: there is no unauthenticated mode.
   */
  readonly clients: ClientRegistry;
  /**
   * The per-client policy every token request is authorized against, after
   * validation and before any provider is looked up. Required: there is no
   * allow-all mode; a client with no rule is denied.
   */
  readonly policy: Policy;
  readonly logger?: FastifyBaseLogger | boolean;
  readonly startedAt?: number;
}

/** `GET /status` response body (contracts "Health and Status"), minimal for US1. */
export interface TesseraStatus {
  readonly service: string;
  readonly uptime_s: number;
  readonly providers: readonly ProviderStatus[];
  readonly soonest_expiry: string | null;
  readonly cache: { readonly entries: number };
}

const REQUEST_FIELDS = new Set(["identity", "repo", "access", "refresh", "subject"]);

function errorBody(code: TesseraErrorCode, message: string): TesseraErrorBody {
  return { error: { code, message } };
}

/**
 * Validate a `POST /v1/github/token` body (data model "Entitlement Request").
 * Messages name fields only, never the submitted values.
 */
export function parseEntitlementRequest(body: unknown): EntitlementRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TesseraValidationError("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new TesseraValidationError(`Unknown request field(s): ${unknown.join(", ")}.`);
  }

  const { identity, repo, access, refresh, subject } = record;
  if (identity !== "app" && identity !== "user") {
    throw new TesseraValidationError('identity must be "app" or "user".');
  }
  if (access !== "read" && access !== "write") {
    throw new TesseraValidationError('access must be "read" or "write".');
  }
  if (repo !== undefined && (typeof repo !== "string" || !isValidRepo(repo))) {
    throw new TesseraValidationError("repo must be in owner/name form.");
  }
  if (identity === "app" && repo === undefined) {
    throw new TesseraValidationError('repo is required for identity "app".');
  }
  if (refresh !== undefined && typeof refresh !== "boolean") {
    throw new TesseraValidationError("refresh must be a boolean when provided.");
  }
  if (subject !== undefined && typeof subject !== "string") {
    throw new TesseraValidationError("subject must be a string when provided.");
  }

  return {
    identity,
    access: access as AccessLevel,
    ...(repo !== undefined ? { repo: repo as string } : {}),
    ...(refresh !== undefined ? { refresh } : {}),
    ...(subject !== undefined ? { subject } : {}),
  };
}

const BEARER_PATTERN = /^bearer +(\S+)$/i;

/** The key from a strict `Authorization: Bearer <key>` header, else `undefined`. */
function bearerKey(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  return BEARER_PATTERN.exec(header)?.[1];
}

/** `/v1` itself or any path below it, whether or not a route matched. */
function isGatedPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function soonestExpiry(statuses: readonly ProviderStatus[]): string | null {
  let soonest: { at: number; raw: string } | null = null;
  for (const status of statuses) {
    const raw = status.credential_expires_at;
    if (raw === null) continue;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) continue;
    if (soonest === null || at < soonest.at) soonest = { at, raw };
  }
  return soonest?.raw ?? null;
}

/**
 * A Fastify framework rejection of the request itself (bad JSON, empty body,
 * unsupported media type, oversized body): an `FST_*` code with a 4xx status.
 * Any other error, even one carrying a 4xx `statusCode`, is not the caller's
 * fault and is reported as `internal`.
 */
function isFastifyClientError(err: { statusCode?: number; code?: unknown }): boolean {
  return (
    typeof err.code === "string" &&
    err.code.startsWith("FST_") &&
    typeof err.statusCode === "number" &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  );
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

interface ProviderReport {
  readonly status: ProviderStatus;
  readonly entries: number;
  /** Error class when `status()` or `cacheEntries()` threw, else `null`. */
  readonly failedClass: string | null;
}

/**
 * One provider's `/status` contribution. A provider whose `status()` or
 * `cacheEntries()` throws is reported `degraded` with 0 entries and the error
 * class as `last_error`, so one faulty provider cannot fail `/status`.
 */
function providerReport(provider: CredentialProvider): ProviderReport {
  let status: ProviderStatus | null = null;
  try {
    status = provider.status();
    const entries = provider.cacheEntries?.() ?? 0;
    return { status, entries, failedClass: null };
  } catch (error) {
    const failedClass = errorClass(error);
    return {
      status: {
        provider: provider.id,
        login: null,
        credential_expires_at: null,
        expiry_warning: false,
        ...status,
        state: "degraded",
        last_error: failedClass,
      },
      entries: 0,
      failedClass,
    };
  }
}

/**
 * Build the Tessera HTTP server. Every `/v1/*` request must present a
 * registered client's bearer key, checked before the body is parsed; the
 * route holds no GitHub-specific logic, validates, dispatches on `identity`,
 * and maps typed errors to the contract envelope. Order: authenticate,
 * validate, authorize against the client's policy rule (default deny, 403
 * `policy_denied`), then dispatch to a provider. Request and
 * response bodies, keys and the Authorization header are never logged.
 */
export function buildTesseraServer(options: BuildTesseraServerOptions): FastifyInstance {
  const { registry, clients, policy } = options;
  const startedAt = options.startedAt ?? Date.now();
  const loggerOption = options.logger ?? false;
  const app =
    typeof loggerOption === "boolean"
      ? Fastify({ logger: loggerOption, disableRequestLogging: true })
      : Fastify({ loggerInstance: loggerOption, disableRequestLogging: true });

  app.decorateRequest("tesseraClient", undefined);
  app.decorateRequest("tesseraAudit", undefined);

  // Registered before the auth hook, so a request it rejects is audited too.
  app.addHook("onRequest", async (request) => {
    if (isTokenRequest(request)) request.tesseraAudit = createAuditContext();
  });

  // Authenticate before body parsing, so an unauthenticated request is 401
  // whatever its body, and an unmatched /v1 path is 401 rather than 404. The
  // matched route pattern is checked too, so no URL encoding of the path can
  // reach a /v1 route without a key. /healthz and /status stay open.
  app.addHook("onRequest", async (request) => {
    const pathname = request.url.split("?")[0] ?? "";
    const route = request.routeOptions.url ?? "";
    if (!isGatedPath(pathname) && !isGatedPath(route)) return;
    const key = bearerKey(request.headers.authorization);
    const client = key === undefined ? undefined : clients.authenticate(key);
    if (client === undefined) throw new UnauthorizedError();
    request.tesseraClient = client;
    if (request.tesseraAudit) request.tesseraAudit.caller = client;
  });

  /**
   * Emit the request's audit line, `tessera.issue` span and counter, at most
   * once per token request. Called from `onSend` — which Fastify runs inside
   * `reply.send` whatever the socket's state, for a route reply, an
   * error-handler reply and a hook rejection alike, with the final status
   * code set — so a request whose client disconnected before the response
   * (where `onResponse` never fires) is still recorded, and a token minted but
   * never delivered is recorded as `issued`. `onResponse` calls it again as a
   * fallback; the `emitted` flag keeps that from double-recording.
   */
  function emitOnce(request: FastifyRequest, reply: FastifyReply): void {
    const audit = request.tesseraAudit;
    if (!audit || audit.emitted) return;
    audit.emitted = true;
    const record = buildAuditRecord(audit, reply.statusCode);
    const endTimeMs = Date.now();
    // Only an authenticated caller may attach a span to a slice's trace; an
    // unauthenticated request naming a slice gets a service-local span.
    const sliceId = audit.caller === null ? undefined : request.headers[TESSERA_SLICE_ID_HEADER];
    const span = emitTesseraIssueSpan({
      ...(typeof sliceId === "string" ? { sliceId } : {}),
      startTimeMs: endTimeMs - reply.elapsedTime,
      endTimeMs,
      caller: record.caller,
      identity: record.identity,
      provider: record.provider,
      access: record.access,
      cache: record.cache,
      outcome: record.outcome,
      reason: record.reason,
    });
    // Exactly one counter per request, driven by the same record.
    if (record.outcome === "issued") {
      recordTesseraIssuance({
        identity: record.identity,
        provider: record.provider,
        access: record.access,
        cache: record.cache,
      });
    } else {
      recordTesseraDenial({ identity: record.identity, reason: record.reason });
    }
    // Correlation ids sit beside the record, never inside it; absent when
    // telemetry is off (March has no ContextManager to supply them).
    request.log.info(
      {
        ...(span === undefined ? {} : { trace_id: span.traceId, span_id: span.spanId }),
        audit: record,
      },
      "tessera.audit",
    );
  }

  app.addHook("onSend", async (request, reply) => {
    emitOnce(request, reply);
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        ...(request.tesseraClient === undefined ? {} : { "tessera.client": request.tesseraClient }),
        "tessera.method": request.method,
        "tessera.route": request.routeOptions.url ?? "unmatched",
        "tessera.status_class": statusClass(reply.statusCode),
        "tessera.duration_ms": Math.round(reply.elapsedTime),
      },
      "tessera request handled",
    );
    emitOnce(request, reply);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: unknown }, request, reply) => {
    const audit = request.tesseraAudit;
    if (err instanceof TesseraError) {
      if (audit) audit.errorCode = err.code;
      if (err instanceof ProviderUnavailableError) {
        void reply.header("retry-after", String(err.retryAfterSeconds));
      }
      void reply.code(err.status).send(errorBody(err.code, err.message));
      return;
    }
    if (isFastifyClientError(err)) {
      if (audit) audit.errorCode = "invalid_request";
      // Fastify body/content-type failures; the generic message never echoes the body.
      void reply.code(400).send(errorBody("invalid_request", "Malformed request body."));
      return;
    }
    // Log the error class only: an unexpected message could carry credential material.
    request.log.error({ "tessera.error_class": err.name }, "unhandled tessera error");
    if (audit) audit.errorCode = "internal";
    void reply.code(500).send(errorBody("internal", "Internal server error."));
  });

  // Fixed message: the request URL is never echoed back.
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(errorBody("invalid_request", "No such route."));
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/status", async (request): Promise<TesseraStatus> => {
    const reports = registry.list().map((provider) => {
      const report = providerReport(provider);
      if (report.failedClass !== null) {
        request.log.error(
          { "tessera.provider": provider.id, "tessera.error_class": report.failedClass },
          "tessera provider status failed",
        );
      }
      return report;
    });
    const statuses = reports.map((report) => report.status);
    const entries = reports.reduce((sum, report) => sum + report.entries, 0);
    return {
      service: TESSERA_SERVICE_NAME,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      providers: statuses,
      soonest_expiry: soonestExpiry(statuses),
      cache: { entries },
    };
  });

  app.post(TOKEN_ROUTE, async (request): Promise<Entitlement> => {
    const req = parseEntitlementRequest(request.body);
    const audit = request.tesseraAudit;
    if (audit) {
      audit.identity = req.identity;
      audit.repo = req.repo ?? null;
      audit.access = req.access;
      audit.subject = req.subject ?? null;
    }
    // The auth hook always sets the client on /v1 routes; fail closed if not.
    const client = request.tesseraClient;
    if (client === undefined) throw new UnauthorizedError();
    // Authorize before any provider lookup, so a denial never reaches a
    // provider or reports provider_unconfigured. `subject` is not passed: it
    // never affects a decision.
    authorize(policy, client, {
      identity: req.identity,
      access: req.access,
      ...(req.repo !== undefined ? { repo: req.repo } : {}),
    });
    const provider = registry.get(req.identity);
    // Strict identity match: no error path substitutes one identity for another.
    if (!provider || provider.identity !== req.identity) {
      throw new ProviderUnconfiguredError(
        `No provider is configured for identity "${req.identity}".`,
      );
    }
    if (audit) audit.provider = provider.id;
    const result = await provider.issue({
      ...(req.repo !== undefined ? { repo: req.repo } : {}),
      access: req.access,
      ...(req.refresh !== undefined ? { refresh: req.refresh } : {}),
    });
    if (audit) {
      audit.cache = result.cache;
      audit.expiresAt = result.expiresAt;
    }
    return {
      token: result.token,
      expires_at: result.expiresAt,
      identity: result.identity,
      commit_identity: result.commitIdentity,
      access: req.access,
      repo: req.identity === "user" ? null : (req.repo ?? null),
    };
  });

  return app;
}
