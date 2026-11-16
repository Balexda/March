import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { TESSERA_SERVICE_NAME } from "./config.js";
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
  TesseraError,
  TesseraValidationError,
} from "./types.js";

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
  readonly registry: ProviderRegistry;
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
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const MAX_OWNER_LENGTH = 39;
const MAX_REPO_NAME_LENGTH = 100;
const DOTS_ONLY = /^\.+$/;

/**
 * `owner/name`, with GitHub's length limits and no dot-only segment. A provider
 * puts this value into GitHub API paths, so `.` and `..` must never get through.
 */
function isValidRepo(repo: string): boolean {
  if (!REPO_PATTERN.test(repo)) return false;
  const [owner = "", name = ""] = repo.split("/");
  if (owner.length > MAX_OWNER_LENGTH || name.length > MAX_REPO_NAME_LENGTH) return false;
  return !DOTS_ONLY.test(owner) && !DOTS_ONLY.test(name);
}

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
 * Build the Tessera HTTP server. The route holds no GitHub-specific logic and
 * applies no caller authentication (US2); it validates, dispatches on
 * `identity`, and maps typed errors to the contract envelope. Request and
 * response bodies are never logged.
 */
export function buildTesseraServer(options: BuildTesseraServerOptions): FastifyInstance {
  const { registry } = options;
  const startedAt = options.startedAt ?? Date.now();
  const loggerOption = options.logger ?? false;
  const app =
    typeof loggerOption === "boolean"
      ? Fastify({ logger: loggerOption, disableRequestLogging: true })
      : Fastify({ loggerInstance: loggerOption, disableRequestLogging: true });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        "tessera.method": request.method,
        "tessera.route": request.routeOptions.url ?? "unmatched",
        "tessera.status_class": statusClass(reply.statusCode),
        "tessera.duration_ms": Math.round(reply.elapsedTime),
      },
      "tessera request handled",
    );
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: unknown }, request, reply) => {
    if (err instanceof TesseraError) {
      if (err instanceof ProviderUnavailableError) {
        void reply.header("retry-after", String(err.retryAfterSeconds));
      }
      void reply.code(err.status).send(errorBody(err.code, err.message));
      return;
    }
    if (isFastifyClientError(err)) {
      // Fastify body/content-type failures; the generic message never echoes the body.
      void reply.code(400).send(errorBody("invalid_request", "Malformed request body."));
      return;
    }
    // Log the error class only: an unexpected message could carry credential material.
    request.log.error({ "tessera.error_class": err.name }, "unhandled tessera error");
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

  app.post("/v1/github/token", async (request): Promise<Entitlement> => {
    const req = parseEntitlementRequest(request.body);
    const provider = registry.get(req.identity);
    // Strict identity match: no error path substitutes one identity for another.
    if (!provider || provider.identity !== req.identity) {
      throw new ProviderUnconfiguredError(
        `No provider is configured for identity "${req.identity}".`,
      );
    }
    const result = await provider.issue({
      ...(req.repo !== undefined ? { repo: req.repo } : {}),
      access: req.access,
      ...(req.refresh !== undefined ? { refresh: req.refresh } : {}),
    });
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
