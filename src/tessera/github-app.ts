import { createSign } from "node:crypto";
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
/** Uncached v1 provider. See docs/vision.md and docs/operating-philosophy.md:
 * bounded requests fail closed without asking an operator or widening scope. */
export class GithubAppProvider implements CredentialProvider {
  readonly id = "github-app";
  readonly identity = "app";
  private options: GithubAppOptions;
  private login: string | null = null;
  private commitIdentity: CommitIdentity | null = null;
  private state: ProviderStatus["state"] = "unconfigured";
  private lastError: string | null = null;
  constructor(options: GithubAppOptions = {}) {
    this.options = options;
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
  private fail(error: TesseraError): never {
    this.lastError = error.code;
    this.state = error.code === "credential_invalid" ? "invalid" : "degraded";
    throw error;
  }
  private async call(path: string, body?: unknown, repoOperation = false, authenticated = true): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const assertion = authenticated ? this.assertion() : undefined;
      const request = async () => {
        const response = await (this.options.fetchImpl ?? fetch)(`https://api.github.com${path}`, {
          method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
          headers: { ...(assertion ? { authorization: `Bearer ${assertion}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "march-tessera", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 401) throw new TesseraError("credential_invalid");
        if (response.status >= 500 || response.status === 429) throw new TesseraError("provider_unavailable");
        if (repoOperation && (response.status === 404 || response.status === 422)) throw new TesseraError("repo_not_installed");
        if (!response.ok) throw new TesseraError("mint_failed");
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TesseraError("mint_failed");
        return value as Record<string, unknown>;
      };
      // Race the entire operation including body parsing; injected transports cannot ignore the deadline.
      return await Promise.race([request(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new TesseraError("provider_unavailable")); }, this.options.timeoutMs ?? 5000);
      })]);
    } catch (error) { return this.fail(error instanceof TesseraError ? error : new TesseraError(error instanceof SyntaxError ? "mint_failed" : "provider_unavailable")); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async discover(): Promise<void> {
    const app = await this.call("/app");
    if (typeof app.slug !== "string" || !/^[A-Za-z0-9-]+$/.test(app.slug)) this.fail(new TesseraError("mint_failed"));
    const login = `${app.slug}[bot]`;
    const user = await this.call(`/users/${encodeURIComponent(login)}`, undefined, false, false);
    if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0 || user.login !== login) this.fail(new TesseraError("mint_failed"));
    this.login = login;
    this.commitIdentity = { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
    this.state = "ok";
    this.lastError = null;
  }
  async start(): Promise<void> {
    if (!this.configured()) return;
    try { await this.discover(); } catch (error) { this.options.onDiscoveryError?.((error as TesseraError).code); }
  }
  async reload(credentials: Pick<GithubAppOptions, "appId" | "privateKey" | "installationId">): Promise<void> {
    this.options = { ...this.options, ...credentials };
    this.login = null;
    this.commitIdentity = null;
    this.state = this.configured() ? "degraded" : "unconfigured";
    this.lastError = null;
    await this.start();
  }
  async issue(request: ProviderIssueRequest): Promise<ProviderIssueResult> {
    if (request.identity !== "app" || !request.repo || !REPO_PATTERN.test(request.repo) || !["read", "write"].includes(request.access)) throw new TesseraError("invalid_request");
    if (!this.configured()) throw new TesseraError("provider_unconfigured");
    if (this.state === "invalid") throw new TesseraError("credential_invalid");
    if (!this.login) await this.discover();
    const [owner, repository] = request.repo.split("/");
    let installationId = this.options.installationId;
    if (installationId === undefined) {
      const installation = await this.call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`, undefined, true);
      if (!Number.isSafeInteger(installation.id) || (installation.id as number) <= 0) this.fail(new TesseraError("mint_failed"));
      installationId = installation.id as number;
    }
    const minted = await this.call(`/app/installations/${installationId}/access_tokens`, { repositories: [repository], permissions: ACCESS_PROFILES[request.access] }, true);
    if (typeof minted.token !== "string" || !minted.token || typeof minted.expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(minted.expires_at) || !Number.isFinite(Date.parse(minted.expires_at)) || Date.parse(minted.expires_at) <= this.now() || Date.parse(minted.expires_at) > this.now() + 3_600_000) this.fail(new TesseraError("mint_failed"));
    if (minted.permissions !== undefined) {
      if (!minted.permissions || typeof minted.permissions !== "object" || Array.isArray(minted.permissions)) this.fail(new TesseraError("mint_failed"));
      const expected = ACCESS_PROFILES[request.access] as Record<string, string>;
      if (Object.entries(minted.permissions as Record<string, unknown>).some(([permission, level]) => expected[permission] !== level)) this.fail(new TesseraError("mint_failed"));
    }
    // GitHub must affirm the exact requested repository, especially for a pinned installation.
    if (!Array.isArray(minted.repositories) || minted.repositories.length !== 1 || !minted.repositories[0] || (minted.repositories[0] as Record<string, unknown>).full_name?.toString().toLowerCase() !== request.repo.toLowerCase()) this.fail(new TesseraError("repo_not_installed"));
    this.state = "ok";
    this.lastError = null;
    return { token: minted.token as string, expiresAt: minted.expires_at as string, identity: this.login!, commitIdentity: { ...this.commitIdentity! }, access: request.access, repo: request.repo, cache: "miss" };
  }
  status(): ProviderStatus {
    return { provider: this.id, state: this.state, login: this.login, credential_expires_at: null, expiry_warning: false, last_error: this.lastError };
  }
}
