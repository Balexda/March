/**
 * Thin, bounded GitHub REST client for the github-app provider.
 *
 * Covers exactly the four calls the provider needs: the app lookup, the
 * installation lookup per repository owner, installation token creation and
 * the bot user lookup. Every call carries a timeout ({@link GITHUB_REQUEST_TIMEOUT_MS}
 * by default, via `AbortSignal.timeout`), and every failure is turned into a
 * typed Tessera error by the one classifier, {@link classifyGitHubFailure}.
 *
 * Secrets: the app assertion is passed per call and only ever placed in the
 * `Authorization` header. This module logs nothing, and no error message
 * carries an upstream response body, a token or the assertion — messages are
 * fixed, operator-readable text because they reach HTTP callers verbatim.
 */
import type { GitHubPermissions, TesseraError } from "../../types.js";
import {
  CredentialInvalidError,
  MintFailedError,
  ProviderUnavailableError,
  RepoNotInstalledError,
} from "../../types.js";

/** Public GitHub REST API base URL; overridable for GHES or a fake. */
export const GITHUB_API_BASE_URL = "https://api.github.com";

/** Upper bound on any one GitHub call, including reading its body. */
export const GITHUB_REQUEST_TIMEOUT_MS = 5_000;

/** GitHub REST API version header value. */
export const GITHUB_API_VERSION = "2022-11-28";

/** The GitHub call being made; drives failure classification. */
export type GitHubOperation = "app" | "installation" | "token" | "user";

/** Constructor options for {@link GitHubClient}. */
export interface GitHubClientOptions {
  /** API base URL, without a trailing slash. Defaults to {@link GITHUB_API_BASE_URL}. */
  readonly baseUrl?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Per-call timeout in milliseconds. Defaults to {@link GITHUB_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The authenticated GitHub App (`GET /app`). */
export interface GitHubApp {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
}

/** An app installation resolved for an owner. */
export interface GitHubInstallation {
  readonly id: number;
  /** Login of the account the app is installed on, when GitHub reports it. */
  readonly account: string | null;
}

/** A minted installation token (`POST /app/installations/{id}/access_tokens`). */
export interface InstallationToken {
  /** The credential. Never logged. */
  readonly token: string;
  /** RFC 3339 expiry as reported by GitHub. */
  readonly expiresAt: string;
}

/** A GitHub user (`GET /users/{login}`). */
export interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

/** Scope of an installation token request; one repository in v1. */
export interface InstallationTokenScope {
  /** Repository names (without owner) the token is restricted to. */
  readonly repositories: readonly string[];
  /** Exact permissions the token carries. */
  readonly permissions: GitHubPermissions;
}

/** What went wrong with a GitHub call, before classification. */
export type GitHubFailure =
  | { readonly kind: "network" }
  | { readonly kind: "timeout" }
  | { readonly kind: "status"; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: "malformed" };

const OPERATION_LABEL: Readonly<Record<GitHubOperation, string>> = {
  app: "GitHub App lookup",
  installation: "GitHub App installation lookup",
  token: "GitHub installation token mint",
  user: "GitHub bot user lookup",
};

/** Calls authenticated with the app assertion; a 401 there means the app credential is rejected. */
const APP_AUTHENTICATED: ReadonlySet<GitHubOperation> = new Set(["app", "installation", "token"]);

/**
 * The single failure classifier for GitHub calls:
 * - network error, timeout, or 5xx → `provider_unavailable` (numeric `Retry-After` forwarded);
 * - 401 on an app-authenticated call → `credential_invalid`;
 * - 404 on installation lookup, 404/422 on token creation → `repo_not_installed`;
 * - anything else → `mint_failed` (including secondary rate limits, open debt SD-011).
 */
export function classifyGitHubFailure(operation: GitHubOperation, failure: GitHubFailure): TesseraError {
  const label = OPERATION_LABEL[operation];
  switch (failure.kind) {
    case "network":
      return new ProviderUnavailableError(`${label} failed: GitHub is unreachable.`);
    case "timeout":
      return new ProviderUnavailableError(`${label} failed: GitHub did not respond in time.`);
    case "malformed":
      return new MintFailedError(`${label} failed: GitHub returned an unexpected response.`);
    case "status": {
      const { status } = failure;
      if (status >= 500) {
        const message = `${label} failed: GitHub returned a server error.`;
        return failure.retryAfterSeconds === undefined
          ? new ProviderUnavailableError(message)
          : new ProviderUnavailableError(message, failure.retryAfterSeconds);
      }
      if (status === 401 && APP_AUTHENTICATED.has(operation)) {
        return new CredentialInvalidError(
          "GitHub rejected the GitHub App credential; check the app id and private key.",
        );
      }
      if (
        (operation === "installation" && status === 404) ||
        (operation === "token" && (status === 404 || status === 422))
      ) {
        return new RepoNotInstalledError("The GitHub App is not installed on the requested repository.");
      }
      return new MintFailedError(`${label} failed: GitHub returned status ${status}.`);
    }
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

interface CallOptions {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly assertion?: string;
  readonly body?: unknown;
}

/** Returned by a call made with `allow404` when GitHub answers 404. */
const NOT_FOUND: unique symbol = Symbol("github-not-found");

/** Bounded GitHub REST client. Holds no credential; the assertion is passed per call. */
export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  }

  /** `GET /app`: the app the assertion authenticates as. */
  async getApp(assertion: string): Promise<GitHubApp> {
    const body = await this.call("app", { method: "GET", path: "/app", assertion });
    if (!isRecord(body) || typeof body.id !== "number" || typeof body.slug !== "string") {
      throw classifyGitHubFailure("app", { kind: "malformed" });
    }
    return { id: body.id, slug: body.slug, name: typeof body.name === "string" ? body.name : body.slug };
  }

  /**
   * Resolve the app's installation on `owner`. Approach: GitHub exposes the
   * per-owner lookup as two endpoints by account type, so this tries
   * `GET /orgs/{owner}/installation` first and, on 404, falls back to
   * `GET /users/{owner}/installation`. A 404 from both means the app is not
   * installed on the owner (`repo_not_installed`).
   */
  async getOwnerInstallation(assertion: string, owner: string): Promise<GitHubInstallation> {
    const segment = encodeURIComponent(owner);
    const org = await this.call(
      "installation",
      { method: "GET", path: `/orgs/${segment}/installation`, assertion },
      true,
    );
    const body =
      org === NOT_FOUND
        ? await this.call("installation", { method: "GET", path: `/users/${segment}/installation`, assertion })
        : org;
    if (!isRecord(body) || typeof body.id !== "number") {
      throw classifyGitHubFailure("installation", { kind: "malformed" });
    }
    const account = isRecord(body.account) && typeof body.account.login === "string" ? body.account.login : null;
    return { id: body.id, account };
  }

  /** `POST /app/installations/{id}/access_tokens`, restricted to `scope`. */
  async createInstallationToken(
    assertion: string,
    installationId: number,
    scope: InstallationTokenScope,
  ): Promise<InstallationToken> {
    const body = await this.call("token", {
      method: "POST",
      path: `/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
      assertion,
      body: { repositories: [...scope.repositories], permissions: { ...scope.permissions } },
    });
    if (!isRecord(body) || typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw classifyGitHubFailure("token", { kind: "malformed" });
    }
    return { token: body.token, expiresAt: body.expires_at };
  }

  /** `GET /users/{slug}[bot]` (unauthenticated): the app's bot user. */
  async getBotUser(slug: string): Promise<GitHubUser> {
    const body = await this.call("user", { method: "GET", path: `/users/${encodeURIComponent(`${slug}[bot]`)}` });
    if (!isRecord(body) || typeof body.id !== "number" || typeof body.login !== "string") {
      throw classifyGitHubFailure("user", { kind: "malformed" });
    }
    return { id: body.id, login: body.login };
  }

  /**
   * Make one bounded call and return its parsed JSON body. With `allow404`, a
   * 404 returns {@link NOT_FOUND} instead of throwing.
   */
  private async call(operation: GitHubOperation, opts: CallOptions, allow404 = false): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "march-tessera",
    };
    if (opts.assertion !== undefined) headers.authorization = `Bearer ${opts.assertion}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${opts.path}`, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw classifyGitHubFailure(operation, { kind: isTimeout(error) ? "timeout" : "network" });
    }

    if (!response.ok) {
      if (allow404 && response.status === 404) return NOT_FOUND;
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      throw classifyGitHubFailure(operation, {
        kind: "status",
        status: response.status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw classifyGitHubFailure(operation, { kind: "malformed" });
    }
  }
}
