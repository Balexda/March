/**
 * The Tessera Node client: the one call site through which service code
 * obtains a GitHub credential (contracts "Node Client").
 *
 * It speaks only HTTP to `POST /v1/github/token`. It imports nothing from the
 * server module and never raises the server's `TesseraError` classes: every
 * failure is a {@link TesseraClientError}. The class does not log; only the
 * module-level {@link getGitHubToken} logs, once per migration fallback. No
 * error message or log line ever carries the client key or a token: messages
 * are fixed text or the server's own envelope message.
 */
import { createTesseraClientLogger } from "../observability/logger.js";
import { recordTesseraClientFallback } from "../observability/tessera-metrics.js";
import {
  resolveTesseraBaseUrl,
  resolveTesseraClientKey,
  resolveTesseraGhTokenFallback,
} from "./config.js";
import { isValidRepo } from "./repo-name.js";
import type { AccessLevel, CommitIdentity, Identity, TesseraErrorCode } from "./types.js";

/** Header carrying the caller's slice id, for span correlation only. */
export const TESSERA_SLICE_ID_HEADER = "x-march-slice-id";

/** Upper bound on one token request, in milliseconds. */
export const DEFAULT_TESSERA_TIMEOUT_MS = 10_000;

/**
 * An entitlement is reused only while strictly more than this much time is
 * left before its `expiresAt`, in milliseconds (ten minutes).
 */
export const TESSERA_REUSE_MARGIN_MS = 10 * 60_000;

const TOKEN_ROUTE = "/v1/github/token";

type FetchImpl = typeof fetch;

/** A request for a GitHub credential (contracts "Node Client"). */
export interface GitHubTokenRequest {
  readonly identity: Identity;
  /** `owner/name`; required for `app`. */
  readonly repo?: string;
  readonly access: AccessLevel;
  /** Ask Tessera to mint a fresh credential instead of reusing one. */
  readonly refresh?: boolean;
  /** Sent as the `x-march-slice-id` header; never in the body. */
  readonly sliceId?: string;
}

/** A GitHub credential as service code sees it. */
export interface GitHubEntitlement {
  /** The credential. Never logged. */
  readonly token: string;
  /** RFC 3339; `null` only for a `user` token with no discoverable expiry. */
  readonly expiresAt: string | null;
  /** Login the token acts as. */
  readonly identity: string;
  /** `null` for `user`. */
  readonly commitIdentity: CommitIdentity | null;
  /** `env-fallback` only when the gated migration fallback served the call. */
  readonly source: "tessera" | "env-fallback";
}

/**
 * Codes a {@link TesseraClientError} can carry: the server's codes, plus
 * `unreachable` (network failure, timeout, or a response that is not a valid
 * entitlement or error envelope) and `client_key_missing` (no client key
 * configured for this process; raised before any request). A locally invalid
 * request uses the server's `invalid_request`.
 */
export type TesseraClientErrorCode = TesseraErrorCode | "unreachable" | "client_key_missing";

const SERVER_CODES: ReadonlySet<string> = new Set<TesseraErrorCode>([
  "unauthorized",
  "policy_denied",
  "invalid_request",
  "repo_not_installed",
  "provider_unconfigured",
  "credential_invalid",
  "provider_unavailable",
  "mint_failed",
  "internal",
]);

/** The one error type the client raises. */
export class TesseraClientError extends Error {
  readonly code: TesseraClientErrorCode;
  /** HTTP status, when a response was received. */
  readonly status?: number;
  /** Seconds from a numeric `Retry-After` header, when the server sent one. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: TesseraClientErrorCode,
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "TesseraClientError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface TesseraClientOptions {
  /** Defaults to `MARCH_TESSERA_URL`, else `http://localhost:<port>`. */
  readonly baseUrl?: string;
  /** Defaults to `MARCH_TESSERA_CLIENT_KEY`. */
  readonly clientKey?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchImpl;
  /** Per-request bound; defaults to {@link DEFAULT_TESSERA_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Clock in epoch milliseconds, for the reuse window; defaults to `Date.now`. */
  readonly now?: () => number;
}

function invalid(message: string): TesseraClientError {
  return new TesseraClientError("invalid_request", message);
}

function unreachable(message: string, status?: number): TesseraClientError {
  return new TesseraClientError("unreachable", message, status === undefined ? {} : { status });
}

/** Validate a request locally, so a malformed one never reaches Tessera. */
function validateRequest(req: GitHubTokenRequest): void {
  if (!req || typeof req !== "object") throw invalid("Token request must be an object.");
  const { identity, repo, access, refresh, sliceId } = req as unknown as Record<string, unknown>;
  if (identity !== "app" && identity !== "user") {
    throw invalid('identity must be "app" or "user".');
  }
  if (access !== "read" && access !== "write") {
    throw invalid('access must be "read" or "write".');
  }
  if (repo !== undefined && (typeof repo !== "string" || !isValidRepo(repo))) {
    throw invalid("repo must be in owner/name form.");
  }
  if (identity === "app" && repo === undefined) {
    throw invalid('repo is required for identity "app".');
  }
  if (refresh !== undefined && typeof refresh !== "boolean") {
    throw invalid("refresh must be a boolean when provided.");
  }
  if (sliceId !== undefined && typeof sliceId !== "string") {
    throw invalid("sliceId must be a string when provided.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommitIdentity(value: unknown): CommitIdentity | null | undefined {
  if (value === null) return null;
  if (isRecord(value) && typeof value.name === "string" && typeof value.email === "string") {
    return { name: value.name, email: value.email };
  }
  return undefined;
}

/** Map a 2xx body to a {@link GitHubEntitlement}, or `undefined` when it is malformed. */
function parseEntitlement(body: unknown): GitHubEntitlement | undefined {
  if (!isRecord(body)) return undefined;
  const { token, expires_at: expiresAt, identity } = body;
  if (typeof token !== "string" || token === "") return undefined;
  if (expiresAt !== null && typeof expiresAt !== "string") return undefined;
  if (typeof identity !== "string") return undefined;
  const commitIdentity = parseCommitIdentity(body.commit_identity);
  if (commitIdentity === undefined) return undefined;
  return Object.freeze({
    token,
    expiresAt,
    identity,
    commitIdentity: commitIdentity === null ? null : Object.freeze(commitIdentity),
    source: "tessera" as const,
  });
}

/** Cache key: identity, lower-cased repository (or empty) and access. Never the slice id. */
function cacheKey(req: GitHubTokenRequest): string {
  return JSON.stringify([req.identity, req.repo?.toLowerCase() ?? "", req.access]);
}

interface CacheEntry {
  readonly entitlement: GitHubEntitlement;
  /** `expiresAt` in epoch milliseconds. */
  readonly expiresAtMs: number;
}

/** The server's error envelope as a typed error, or `undefined` when it is not one. */
function parseErrorEnvelope(
  body: unknown,
  status: number,
  retryAfter: string | null,
): TesseraClientError | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const { code, message } = body.error;
  if (typeof code !== "string" || !SERVER_CODES.has(code) || typeof message !== "string") {
    return undefined;
  }
  const trimmed = retryAfter?.trim();
  const retryAfterSeconds =
    trimmed !== undefined && /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
  return new TesseraClientError(code as TesseraErrorCode, message, {
    status,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

async function readJson(res: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const text = await res.text();
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Client for Tessera's token route. Each instance keeps an in-memory cache of
 * entitlements (never written to disk), reused while strictly more than
 * {@link TESSERA_REUSE_MARGIN_MS} is left before expiry. An entitlement with
 * no (or an unparseable) expiry is never cached, and failures are never cached.
 * `refresh: true` skips the lookup and evicts the matching entry before the
 * request, so a successful refresh replaces it and a failed refresh leaves no
 * entry; a failure without `refresh` leaves the cache unchanged.
 */
export class TesseraClient {
  private readonly baseUrl: string;
  private readonly clientKey: string | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: TesseraClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (options.baseUrl ?? resolveTesseraBaseUrl(env)).replace(/\/+$/, "");
    const key = options.clientKey ?? resolveTesseraClientKey(env);
    this.clientKey = key?.trim() ? key.trim() : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TESSERA_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Ask Tessera for a GitHub credential. Raises {@link TesseraClientError}:
   * `invalid_request` or `client_key_missing` before any request, the
   * server's code and status for an error envelope, else `unreachable`.
   * Served from the in-memory cache while the reuse window holds.
   */
  async issueGitHubToken(req: GitHubTokenRequest): Promise<GitHubEntitlement> {
    validateRequest(req);
    const clientKey = this.clientKey;
    if (clientKey === undefined) {
      throw new TesseraClientError(
        "client_key_missing",
        "No Tessera client key is configured for this process.",
      );
    }

    const key = cacheKey(req);
    if (req.refresh === true) {
      this.cache.delete(key);
    } else {
      const hit = this.cache.get(key);
      if (hit !== undefined && hit.expiresAtMs - this.now() > TESSERA_REUSE_MARGIN_MS) {
        return hit.entitlement;
      }
    }

    const entitlement = await this.fetchEntitlement(req, clientKey);
    const expiresAtMs =
      entitlement.expiresAt === null ? Number.NaN : Date.parse(entitlement.expiresAt);
    if (Number.isFinite(expiresAtMs)) {
      this.cache.set(key, { entitlement, expiresAtMs });
    } else {
      this.cache.delete(key);
    }
    return entitlement;
  }

  private async fetchEntitlement(
    req: GitHubTokenRequest,
    clientKey: string,
  ): Promise<GitHubEntitlement> {

    const headers: Record<string, string> = {
      authorization: `Bearer ${clientKey}`,
      "content-type": "application/json",
    };
    if (req.sliceId !== undefined) headers[TESSERA_SLICE_ID_HEADER] = req.sliceId;
    const body = {
      identity: req.identity,
      ...(req.repo !== undefined ? { repo: req.repo } : {}),
      access: req.access,
      ...(req.refresh !== undefined ? { refresh: req.refresh } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${TOKEN_ROUTE}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // The cause is not echoed: a transport error could quote request headers.
      throw unreachable("Tessera could not be reached or did not answer in time.");
    }

    const parsed = await readJson(res);

    if (res.ok) {
      const entitlement = parsed.ok ? parseEntitlement(parsed.value) : undefined;
      if (entitlement === undefined) {
        throw unreachable("Tessera returned a malformed entitlement.", res.status);
      }
      return entitlement;
    }

    const typed = parsed.ok
      ? parseErrorEnvelope(parsed.value, res.status, res.headers.get("retry-after"))
      : undefined;
    throw typed ?? unreachable("Tessera returned an error without a valid envelope.", res.status);
  }
}

/**
 * Failures for which the gated migration fallback may serve an `app` request:
 * Tessera could not be reached, this process has no client key yet, or the
 * provider could not issue. A key Tessera refused (`unauthorized`), a policy
 * denial, an invalid request and an uninstalled repository never fall back.
 *
 * Working default for open spec debt SD-017 (option (a) plus the client-side
 * missing key); change this list if SD-017 resolves differently.
 */
const FALLBACK_CODES: ReadonlySet<TesseraClientErrorCode> = new Set<TesseraClientErrorCode>([
  "unreachable",
  "client_key_missing",
  "provider_unavailable",
  "provider_unconfigured",
  "credential_invalid",
  "mint_failed",
  "internal",
]);

/** The minimal logger shape {@link getGitHubToken} needs. */
export interface TesseraClientLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Injection points for {@link getGitHubToken}; all optional. */
export interface GetGitHubTokenOptions {
  /** Defaults to a lazily created, process-wide client built from `env`. */
  readonly client?: TesseraClient;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to the file-only Tessera client logger; never stdout. */
  readonly logger?: TesseraClientLogger;
  /** Counter and warning label; defaults to `MARCH_OTEL_SERVICE_NAME`, else `unknown`. */
  readonly service?: string;
}

let defaultClient: TesseraClient | undefined;
let defaultLogger: TesseraClientLogger | undefined;

/** The shared default client, so its cache spans every call in the process. */
function getDefaultClient(env: NodeJS.ProcessEnv): TesseraClient {
  defaultClient ??= new TesseraClient({ env });
  return defaultClient;
}

/** Drop the process-wide default client (and its cache). Tests only. */
export function resetDefaultTesseraClientForTests(): void {
  defaultClient = undefined;
  defaultLogger = undefined;
}

function warnFallback(
  logger: TesseraClientLogger | undefined,
  env: NodeJS.ProcessEnv,
  fields: Record<string, unknown>,
): void {
  try {
    const target = logger ?? (defaultLogger ??= createTesseraClientLogger({ env }));
    target.warn(
      fields,
      "Tessera could not issue a GitHub token; using the environment token (migration fallback).",
    );
  } catch {
    // Logging must never break the token call.
  }
}

/** `GH_TOKEN`, then `GITHUB_TOKEN`; blank counts as unset. Read only on fallback. */
function readEnvToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * Get a GitHub credential from Tessera — the one call service code uses
 * (contracts "Node Client"). Fails closed: every failure is a
 * {@link TesseraClientError}.
 *
 * Only when `MARCH_TESSERA_GH_TOKEN_FALLBACK=1`, the identity is `app` and the
 * failure is one of {@link FALLBACK_CODES} does it return `GH_TOKEN` (else
 * `GITHUB_TOKEN`) marked `source: "env-fallback"`, logging one warning and
 * counting `march.tessera.client.fallbacks{service}`. Otherwise the token
 * variables are never read. With no env token set, the original error is
 * rethrown. A fallback result is never cached.
 */
export async function getGitHubToken(
  req: GitHubTokenRequest,
  options: GetGitHubTokenOptions = {},
): Promise<GitHubEntitlement> {
  const env = options.env ?? process.env;
  const client = options.client ?? getDefaultClient(env);
  try {
    return await client.issueGitHubToken(req);
  } catch (err) {
    if (
      !(err instanceof TesseraClientError) ||
      !FALLBACK_CODES.has(err.code) ||
      req?.identity !== "app" ||
      !resolveTesseraGhTokenFallback(env)
    ) {
      throw err;
    }
    const token = readEnvToken(env);
    if (token === undefined) throw err;

    const service = options.service?.trim() || env.MARCH_OTEL_SERVICE_NAME?.trim() || "unknown";
    warnFallback(options.logger, env, { reason: err.code, identity: "app", service });
    recordTesseraClientFallback({ service });
    return Object.freeze({
      token,
      expiresAt: null,
      // The login behind an env token is unknown without asking GitHub; empty
      // is the working default for open spec debt SD-019.
      identity: "",
      commitIdentity: null,
      source: "env-fallback" as const,
    });
  }
}
