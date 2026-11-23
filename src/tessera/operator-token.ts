import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { REPO_PATTERN, TesseraError, type CommitIdentity, type CredentialProvider, type Identity, type ProviderIssueRequest, type ProviderIssueResult, type ProviderStatus } from "./models.js";

/**
 * Operator-token credential source: the interim way Tessera vends a WORKING
 * GitHub token while the GitHub App is not configured. The operator's
 * `gh auth token` lives in a 0600 file (`TESSERA_GITHUB_TOKEN_FILE`, written by
 * `march tessera provision --from-gh`). Tessera validates it against
 * `GET https://api.github.com/user`, derives the login and commit identity from
 * GitHub, and re-reads the file whenever it changes (or on a caller `refresh`),
 * so rotating the token needs no restart.
 *
 * This is NOT a bypass: every request still goes through Tessera's client
 * authentication and per-client policy before a provider is selected. The token
 * is the operator's own (not repository-scoped), so the policy's repo/access
 * grants are the only scope bound; the GitHub App remains the goal.
 */

/** Nominal re-check horizon reported as `expires_at` (the token has no real expiry). */
export const OPERATOR_TOKEN_HORIZON_MS = 3_600_000;
const MAX_TOKEN_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5_000;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

export interface OperatorTokenSourceOptions {
  /** Path to the 0600 token file. */
  readonly tokenFile: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface Fingerprint { readonly ino: number; readonly size: number; readonly mtimeMs: number }

type ReadResult = { token: string; fingerprint: Fingerprint } | { error: "missing" | "unreadable" };

/** Read the token file: a regular, non-group/world-accessible file of bounded size. */
async function readTokenFile(path: string): Promise<ReadResult> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_TOKEN_BYTES) return { error: "unreadable" };
    const token = (await file.readFile("utf8")).trim();
    if (!token) return { error: "missing" };
    if (/[\s\0]/.test(token)) return { error: "unreadable" };
    return { token, fingerprint: { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } };
  } catch {
    return { error: "unreadable" };
  } finally {
    await file.close().catch(() => {});
  }
}

const sameFingerprint = (a?: Fingerprint, b?: Fingerprint) =>
  !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Shared by the app and user slots: one file, one validation, one login. */
export class OperatorTokenSource {
  private readonly options: OperatorTokenSourceOptions;
  private token?: string;
  private fingerprint?: Fingerprint;
  private login: string | null = null;
  private commitIdentity: CommitIdentity | null = null;
  private state: ProviderStatus["state"] = "unconfigured";
  private lastError: ProviderStatus["last_error"] = null;
  private revision: object = {};
  private pending?: Promise<void>;

  constructor(options: OperatorTokenSourceOptions) {
    this.options = options;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Validate the token against GitHub `/user`; sets state + login. Never throws. */
  private async validate(token: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await (this.options.fetchImpl ?? fetch)("https://api.github.com/user", {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "march-tessera" },
      });
      if (response.status === 401) {
        this.state = "invalid";
        this.lastError = "credential_invalid";
        this.login = null;
        this.commitIdentity = null;
        return;
      }
      if (!response.ok) throw new Error("unavailable");
      const user = await response.json() as Record<string, unknown>;
      if (typeof user?.login !== "string" || !LOGIN.test(user.login) ||
          !Number.isSafeInteger(user.id) || (user.id as number) <= 0) {
        this.state = "degraded";
        this.lastError = "mint_failed";
        return;
      }
      const login = user.login;
      const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : login;
      const email = typeof user.email === "string" && /^[^\s@]+@[^\s@]+$/.test(user.email)
        ? user.email
        : `${user.id}+${login}@users.noreply.github.com`;
      this.login = login;
      this.commitIdentity = { name, email };
      this.state = "ok";
      this.lastError = null;
    } catch {
      // Network failure / timeout / 5xx: keep any known identity, report degraded.
      this.state = "degraded";
      this.lastError = "provider_unavailable";
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * Re-read the file when it changed (or when forced) and revalidate a new or
   * not-yet-healthy token. Concurrent callers share one load.
   */
  async load(force = false): Promise<void> {
    this.pending ??= (async () => {
      const read = await readTokenFile(this.options.tokenFile);
      if ("error" in read) {
        this.token = undefined;
        this.fingerprint = undefined;
        this.login = null;
        this.commitIdentity = null;
        this.state = read.error === "missing" ? "unconfigured" : "invalid";
        this.lastError = read.error === "missing" ? null : "credential_invalid";
        return;
      }
      const changed = read.token !== this.token || !sameFingerprint(read.fingerprint, this.fingerprint);
      if (changed) this.revision = {};
      this.token = read.token;
      this.fingerprint = read.fingerprint;
      if (changed || force || this.state !== "ok") await this.validate(read.token);
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** The current token + identity, or the typed error a request should fail with. */
  async current(refresh: boolean): Promise<{ token: string; login: string; commitIdentity: CommitIdentity }> {
    await this.load(refresh);
    if (!this.token || this.state === "unconfigured") throw new TesseraError("provider_unconfigured");
    if (this.state === "invalid") throw new TesseraError("credential_invalid");
    if (this.state !== "ok" || !this.login || !this.commitIdentity) throw new TesseraError("provider_unavailable");
    return { token: this.token, login: this.login, commitIdentity: { ...this.commitIdentity } };
  }

  status(provider: string): ProviderStatus {
    return {
      credentialRevision: this.revision,
      provider, state: this.state, login: this.login,
      credential_expires_at: null, expiry_warning: false, last_error: this.lastError,
    };
  }

  /** Nominal expiry for an issued entitlement. */
  horizon(): string {
    return new Date(this.now() + OPERATOR_TOKEN_HORIZON_MS).toISOString();
  }
}

/**
 * A provider slot (`github-app` or `github-user`) backed by the operator token.
 * App requests echo the requested repository and carry the operator's commit
 * identity; user requests return no repository or commit identity, matching
 * the wire contract the client validates.
 */
export class OperatorTokenProvider implements CredentialProvider {
  readonly id: string;
  constructor(readonly identity: Identity, private readonly source: OperatorTokenSource) {
    this.id = `github-${identity}`;
  }

  async start(): Promise<void> {
    await this.source.load(true);
  }

  async issue(request: ProviderIssueRequest): Promise<ProviderIssueResult> {
    const { repo, access, refresh } = request;
    if (request.identity !== this.identity || !["read", "write"].includes(access) ||
        (this.identity === "app" && (!repo || !REPO_PATTERN.test(repo)))) throw new TesseraError("invalid_request");
    const current = await this.source.current(refresh === true);
    return {
      token: current.token,
      expiresAt: this.identity === "app" ? this.source.horizon() : null,
      identity: current.login,
      commitIdentity: this.identity === "app" ? current.commitIdentity : null,
      access,
      repo: this.identity === "app" ? repo! : null,
      cache: "n/a",
    };
  }

  status(): ProviderStatus {
    return this.source.status(this.id);
  }
}
