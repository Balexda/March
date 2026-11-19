import { createSign } from "node:crypto";
import { recordTesseraMint, recordTesseraRateLimit, recordTesseraSecondaryLimit } from "../observability/tessera-service-metrics.js";
import { ACCESS_PROFILES, REPO_PATTERN, TesseraError, type TesseraErrorCode, type CredentialProvider, type ProviderIssueRequest, type ProviderIssueResult, type ProviderStatus, type CommitIdentity } from "./models.js";

export interface GithubAppOptions {
  appId?: string;
  privateKey?: string;
  installationId?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  onDiscoveryError?: (code: TesseraErrorCode) => void;
}
/** GitHub installation tokens last one hour; allow bounded drift between Tessera and GitHub clocks. */
const MAX_TOKEN_LIFETIME_MS = 3_600_000;
const CLOCK_SKEW_MS = 60_000;
const REFRESH_WINDOW_MS = 600_000;
type CachedToken = { token: string; expiresAt: string; expiryMs: number };
type CacheSlot = {
  token?: CachedToken;
  mint?: Promise<CachedToken>;
  explicit: boolean;
  superseded?: boolean;
};

/** Repository-scoped provider. See docs/vision.md and docs/operating-philosophy.md:
 * bounded requests fail closed without asking an operator or widening scope. */
export class GithubAppProvider implements CredentialProvider {
  readonly id = "github-app";
  readonly identity = "app";
  private options: GithubAppOptions;
  private login: string | null = null;
  private commitIdentity: CommitIdentity | null = null;
  private state: ProviderStatus["state"] = "unconfigured";
  private lastError: string | null = null;
  private generation = 0;
  private discovery?: Promise<void>;
  private readonly bindings = new Map<string, number>();
  private readonly rejectedBindings = new Map<string, number>();
  private readonly lookups = new Map<string, Promise<number>>();
  private readonly cache = new Map<string, CacheSlot>();

  constructor(options: GithubAppOptions = {}) {
    this.options = { ...options };
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error("Invalid GitHub timeout");
    if (options.installationId !== undefined && (!Number.isSafeInteger(options.installationId) || options.installationId <= 0)) throw new Error("Invalid GitHub installation id");
    if (this.configured()) this.state = "degraded";
  }
  private configured(): boolean { return !!this.options.appId && !!this.options.privateKey; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private assertion(): string {
    try {
      const seconds = Math.floor(this.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: this.options.appId })}`;
      const signer = createSign("RSA-SHA256");
      signer.update(payload);
      return `${payload}.${signer.sign(this.options.privateKey!, "base64url")}`;
    } catch { throw new TesseraError("credential_invalid"); }
  }
  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new TesseraError("provider_unavailable");
  }
  private assertValid(): void {
    if (this.state === "invalid") throw new TesseraError("credential_invalid");
  }
  private healthy(): void {
    this.assertValid();
    this.state = "ok";
    this.lastError = null;
  }
  private fail(error: TesseraError): never {
    if (this.state !== "invalid") {
      this.lastError = error.code;
      this.state = error.code === "credential_invalid" ? "invalid" : "degraded";
    }
    throw error;
  }
  private async call(path: string, body?: unknown, repoOperation = false, authenticated = true): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set before any diagnostic body read so a stalled read cannot replace the HTTP failure.
    let statusError: TesseraError | undefined;
    try {
      const assertion = authenticated ? this.assertion() : undefined;
      const request = async () => {
        const response = await (this.options.fetchImpl ?? fetch)(`https://api.github.com${path}`, {
          method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
          headers: { ...(assertion ? { authorization: `Bearer ${assertion}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "march-tessera", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const remainingHeader = response.headers.get("x-ratelimit-remaining");
        const remaining = remainingHeader && /^\d+$/.test(remainingHeader) ? Number(remainingHeader) : NaN;
        if (Number.isSafeInteger(remaining)) recordTesseraRateLimit(this.id, remaining);
        if (response.status === 401) statusError = new TesseraError("credential_invalid");
        else if (response.status >= 500 || response.status === 429) statusError = new TesseraError("provider_unavailable");
        else if (repoOperation && (response.status === 404 || response.status === 422)) statusError = new TesseraError("repo_not_installed");
        else if (!response.ok) statusError = new TesseraError("mint_failed");
        if (response.status === 403 || response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          if (Number.isSafeInteger(remaining) && remaining > 0 && retryAfter && /^\d+$/.test(retryAfter)) {
            recordTesseraSecondaryLimit(this.id);
          } else {
            // GitHub may signal a secondary limit only in the error message.
            const error = await response.json().catch(() => null);
            if (typeof error?.message === "string" && /secondary rate limit/i.test(error.message)) {
              recordTesseraSecondaryLimit(this.id);
            }
          }
        }
        if (statusError) throw statusError;
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TesseraError("mint_failed");
        return value as Record<string, unknown>;
      };
      // Race the entire operation including body parsing; injected transports cannot ignore the deadline.
      return await Promise.race([request(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new TesseraError("provider_unavailable")); }, this.options.timeoutMs ?? 5000);
      })]);
    } catch (error) {
      if (statusError) throw statusError;
      throw error instanceof TesseraError ? error : new TesseraError(error instanceof SyntaxError ? "mint_failed" : "provider_unavailable");
    }
    // Abort on every exit so an unread error body cannot hold the connection past the deadline.
    finally { controller.abort(); if (timer) clearTimeout(timer); }
  }
  private async discover(generation: number): Promise<void> {
    const app = await this.call("/app");
    this.assertCurrent(generation);
    if (typeof app.slug !== "string" || !/^[A-Za-z0-9-]+$/.test(app.slug)) throw new TesseraError("mint_failed");
    const login = `${app.slug}[bot]`;
    const user = await this.call(`/users/${encodeURIComponent(login)}`, undefined, false, false);
    this.assertCurrent(generation);
    if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0 || user.login !== login) throw new TesseraError("mint_failed");
    this.healthy();
    this.login = login;
    this.commitIdentity = { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
  }

  private ensureIdentity(generation: number): Promise<void> {
    if (this.login) return Promise.resolve();
    this.discovery ??= this.discover(generation).catch((error: TesseraError) => {
      this.assertCurrent(generation);
      this.fail(error);
    }).finally(() => {
      if (generation === this.generation) this.discovery = undefined;
    });
    return this.discovery;
  }

  async start(): Promise<void> {
    if (!this.configured()) return;
    const generation = this.generation;
    try {
      await this.ensureIdentity(generation);
    } catch (error) {
      if (generation === this.generation) this.options.onDiscoveryError?.((error as TesseraError).code);
    }
  }
  async reload(credentials: Pick<GithubAppOptions, "appId" | "privateKey" | "installationId">): Promise<void> {
    this.generation++;
    this.options = { ...this.options, ...credentials };
    this.discovery = undefined;
    this.bindings.clear();
    this.rejectedBindings.clear();
    this.lookups.clear();
    this.cache.clear();
    this.login = null;
    this.commitIdentity = null;
    this.state = this.configured() ? "degraded" : "unconfigured";
    this.lastError = null;
    await this.start();
  }
  private async resolveInstallation(repo: string, generation: number): Promise<number> {
    const owner = repo.split("/")[0];
    if (this.options.installationId !== undefined) return this.options.installationId;
    const known = this.bindings.get(owner);
    if (known !== undefined && this.rejectedBindings.get(repo) !== known) return known;
    const pending = this.lookups.get(repo);
    if (pending) return pending;

    const lookup = this.call(`/repos/${repo}/installation`, undefined, true).then(installation => {
      this.assertCurrent(generation);
      const id = installation.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new TesseraError("mint_failed");
      this.bindings.set(owner, id);
      this.rejectedBindings.delete(repo);
      return id;
    }).catch((error: TesseraError) => {
      this.assertCurrent(generation);
      this.fail(error);
    }).finally(() => {
      if (generation === this.generation) this.lookups.delete(repo);
    });
    this.lookups.set(repo, lookup);
    return lookup;
  }

  private async mint(installationId: number, repo: string, access: ProviderIssueRequest["access"]): Promise<CachedToken> {
    const start = performance.now();
    let outcome: "issued" | "failed" = "failed";
    try {
      const entry = await this.requestMint(installationId, repo, access);
      outcome = "issued";
      return entry;
    } finally {
      recordTesseraMint(this.id, performance.now() - start, outcome);
    }
  }

  private async requestMint(installationId: number, repo: string, access: ProviderIssueRequest["access"]): Promise<CachedToken> {
    const repository = repo.split("/")[1];
    const minted = await this.call(`/app/installations/${installationId}/access_tokens`, { repositories: [repository], permissions: ACCESS_PROFILES[access] }, true);
    const expiryMs = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : NaN;
    const now = this.now();
    if (typeof minted.token !== "string" || !minted.token || typeof minted.expires_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T/.test(minted.expires_at) || !Number.isFinite(expiryMs) ||
        expiryMs <= now || expiryMs > now + MAX_TOKEN_LIFETIME_MS + CLOCK_SKEW_MS) throw new TesseraError("mint_failed");
    if (minted.permissions !== undefined) {
      if (!minted.permissions || typeof minted.permissions !== "object" || Array.isArray(minted.permissions)) throw new TesseraError("mint_failed");
      const expected = ACCESS_PROFILES[access] as Record<string, string>;
      if (Object.entries(minted.permissions as Record<string, unknown>).some(([permission, level]) => expected[permission] !== level)) throw new TesseraError("mint_failed");
    }
    // GitHub must affirm the exact requested repository, especially for a pinned installation.
    if (!Array.isArray(minted.repositories) || minted.repositories.length !== 1 ||
        typeof minted.repositories[0]?.full_name !== "string" ||
        minted.repositories[0].full_name.toLowerCase() !== repo) throw new TesseraError("repo_not_installed");
    return { token: minted.token, expiresAt: minted.expires_at, expiryMs };
  }

  cacheSize(): number {
    const now = this.now();
    let entries = 0;
    for (const [key, slot] of this.cache) {
      if (slot.token && slot.token.expiryMs > now) {
        entries++;
      } else {
        slot.token = undefined;
        if (!slot.mint) this.cache.delete(key);
      }
    }
    return entries;
  }

  async issue(request: ProviderIssueRequest): Promise<ProviderIssueResult> {
    const { repo, access, refresh } = request;
    if (request.identity !== "app" || !repo || !REPO_PATTERN.test(repo) || !["read", "write"].includes(access)) throw new TesseraError("invalid_request");
    if (!this.configured()) throw new TesseraError("provider_unconfigured");
    this.assertValid();

    const generation = this.generation;
    const canonicalRepo = repo.toLowerCase();
    await this.ensureIdentity(generation);
    this.assertCurrent(generation);
    const installationId = await this.resolveInstallation(canonicalRepo, generation);
    this.assertCurrent(generation);
    this.assertValid();

    // Each fixed access level uniquely identifies its permission set.
    const key = JSON.stringify([installationId, canonicalRepo, access]);
    this.cacheSize();
    let slot = this.cache.get(key);
    // Replace the slot to supersede an older mint. Concurrent explicit refreshes can share their new mint.
    if (!slot || (refresh && !slot.explicit)) {
      if (slot) {
        slot.token = undefined;
        slot.superseded = true;
      }
      slot = { explicit: refresh === true };
      this.cache.set(key, slot);
    }
    const current = slot;
    const assertSlot = () => {
      this.assertCurrent(generation);
      if (current.superseded) throw new TesseraError("provider_unavailable");
    };
    const result = (entry: CachedToken, cache: "hit" | "miss"): ProviderIssueResult => ({
      token: entry.token, expiresAt: entry.expiresAt, identity: this.login!,
      commitIdentity: { ...this.commitIdentity! }, access, repo, cache,
    });
    const cached = current.token;
    if (cached && cached.expiryMs - this.now() >= REFRESH_WINDOW_MS) return result(cached, "hit");

    current.mint ??= this.mint(installationId, canonicalRepo, access).then(entry => {
      assertSlot();
      this.healthy();
      current.token = entry;
      return entry;
    }, (error: TesseraError) => {
      assertSlot();
      if (error.code !== "provider_unavailable") current.token = undefined;
      if (error.code === "repo_not_installed" && this.options.installationId === undefined) {
        this.rejectedBindings.set(canonicalRepo, installationId);
      }
      return this.fail(error);
    });
    const mint = current.mint;
    try {
      const entry = await mint;
      assertSlot();
      this.assertValid();
      if (entry.expiryMs <= this.now()) throw new TesseraError("mint_failed");
      return result(entry, "miss");
    } catch (error) {
      assertSlot();
      this.assertValid();
      if (error instanceof TesseraError && error.code === "provider_unavailable" &&
          cached && current.token === cached && cached.expiryMs > this.now()) {
        return { ...result(cached, "hit"), degradedReason: error.code };
      }
      throw error;
    } finally {
      if (current.mint === mint) {
        current.mint = undefined;
        current.explicit = false;
      }
    }
  }

  status(): ProviderStatus {
    return { provider: this.id, state: this.state, login: this.login, credential_expires_at: null, expiry_warning: false, last_error: this.lastError };
  }
}
