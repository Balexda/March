import path from "node:path";
import os from "node:os";
import type { Logger } from "pino";
import { createServiceLogger } from "../observability/logger.js";
import { recordTesseraFallback, tesseraConsumerService } from "../observability/tessera-client-metrics.js";
import { resolveTesseraConfig } from "./config.js";
import type { GitHubEntitlement, GitHubTokenRequest, TesseraStatus } from "./types.js";
export type { GitHubEntitlement, GitHubTokenRequest, TesseraStatus } from "./types.js";

export class TesseraClientError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    // Never incorporate server messages, URLs, headers or transport exception text.
    super("Tessera request failed");
    this.name = "TesseraClientError";
  }
}
export interface TesseraClientOptions {
  baseUrl?: string;
  clientKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}
const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
const EXPIRY_MARGIN_MS = 600_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown) => v === null || date(v);
const nullableString = (v: unknown) => v === null || typeof v === "string";
function invalid(status?: number): never { throw new TesseraClientError("invalid_response", status); }
function validateRequest(req: GitHubTokenRequest): void {
  if (!["app", "user"].includes(req.identity) || !["read", "write"].includes(req.access) ||
    (req.identity === "app" && !req.repo) ||
    (req.repo !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(req.repo)) ||
    (req.refresh !== undefined && typeof req.refresh !== "boolean") ||
    (req.sliceId !== undefined && (!nonempty(req.sliceId) || /[^\x20-\x7e]/.test(req.sliceId)))) {
    throw new TesseraClientError("invalid_request");
  }
}
function entitlement(body: unknown, req: GitHubTokenRequest): GitHubEntitlement {
  if (!object(body) || !nonempty(body.token) || !nonempty(body.identity) ||
    !nullableDate(body.expires_at) || body.access !== req.access) invalid(200);
  const commit = body.commit_identity;
  if (req.identity === "app") {
    if (body.repo !== req.repo || !date(body.expires_at) || !object(commit) ||
      !nonempty(commit.name) || !nonempty(commit.email)) invalid(200);
  } else if (body.repo !== null || commit !== null) invalid(200);
  return {
    token: body.token, identity: body.identity, expiresAt: body.expires_at as string | null,
    commitIdentity: commit === null ? null : { name: (commit as Record<string, string>).name, email: (commit as Record<string, string>).email },
    source: "tessera",
  };
}
function statusBody(body: unknown): TesseraStatus {
  if (!object(body) || body.service !== "march-tessera" || typeof body.uptime_s !== "number" ||
    !Number.isFinite(body.uptime_s) || body.uptime_s < 0 || !nullableDate(body.soonest_expiry) ||
    !object(body.cache) || !Number.isInteger(body.cache.entries) || (body.cache.entries as number) < 0 ||
    !Array.isArray(body.providers) || body.providers.length !== 2) invalid(200);
  const providers = body.providers.map((p: unknown) => {
    if (!object(p) || !["github-app", "github-user"].includes(p.provider as string) ||
      !["ok", "unconfigured", "degraded", "invalid"].includes(p.state as string) ||
      !nullableString(p.login) || !nullableDate(p.credential_expires_at) ||
      typeof p.expiry_warning !== "boolean" || !nullableString(p.last_error)) invalid(200);
    return { provider: p.provider, state: p.state, login: p.login,
      credential_expires_at: p.credential_expires_at, expiry_warning: p.expiry_warning,
      last_error: p.last_error } as TesseraStatus["providers"][number];
  });
  if (new Set(providers.map(p => p.provider)).size !== 2) invalid(200);
  return { service: "march-tessera", uptime_s: body.uptime_s,
    providers, soonest_expiry: body.soonest_expiry as string | null,
    cache: { entries: body.cache.entries as number } };
}
function copy(value: GitHubEntitlement): GitHubEntitlement {
  return { ...value, commitIdentity: value.commitIdentity && { ...value.commitIdentity } };
}
export class TesseraClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: ReturnType<typeof resolveTesseraConfig>;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, GitHubEntitlement>();
  private readonly generations = new Map<string, number>();
  private logger?: Logger;
  constructor(options: TesseraClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.config = resolveTesseraConfig(options);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  private async request(route: string, req?: GitHubTokenRequest): Promise<unknown> {
    if (!this.config || (req && !this.config.clientKey)) throw new TesseraClientError("unconfigured");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        // Abort alone has been observed to leave a stalled body's socket open, keeping
        // one-shot callers (the token CLI) alive past the deadline; cancel the read too.
        reader?.cancel().catch(() => {});
        reject(new TesseraClientError("unreachable"));
      },
        route === "/healthz" ? PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    });
    const run = async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config!.baseUrl + route, {
          method: req ? "POST" : "GET", signal: controller.signal, redirect: "error",
          headers: req ? { authorization: `Bearer ${this.config!.clientKey}`, "content-type": "application/json",
            ...(req.sliceId ? { "x-march-slice-id": req.sliceId } : {}) } : {},
          body: req ? JSON.stringify({ identity: req.identity, repo: req.repo, access: req.access, refresh: req.refresh }) : undefined,
        });
      } catch { throw new TesseraClientError("unreachable"); }
      let body: unknown;
      let raw: string;
      try {
        const stream = response.body;
        if (!stream) raw = await response.text();
        else {
          reader = stream.getReader();
          const decoder = new TextDecoder();
          raw = "";
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            raw += decoder.decode(chunk.value, { stream: true });
          }
          raw += decoder.decode();
        }
      } catch { throw new TesseraClientError("unreachable"); }
      try { body = JSON.parse(raw); } catch { invalid(response.status); }
      if (response.status !== 200) {
        // Accept protocol codes only, never arbitrary server text masquerading as a code.
        const codes = ["unauthorized", "invalid_request", "policy_denied", "repo_not_installed", "provider_unconfigured", "credential_invalid", "provider_unavailable", "mint_failed"];
        if (!object(body) || !object(body.error) || !codes.includes(body.error.code as string)) invalid(response.status);
        throw new TesseraClientError(body.error.code as string, response.status);
      }
      return body;
    };
    try { return await Promise.race([run(), timeout]); }
    finally { clearTimeout(timer); }
  }
  async issueGitHubToken(req: GitHubTokenRequest): Promise<GitHubEntitlement> {
    validateRequest(req);
    const key = JSON.stringify([req.identity, req.repo ?? null, req.access]);
    const cached = this.cache.get(key);
    if (!req.refresh && cached?.expiresAt && Date.parse(cached.expiresAt) - Date.now() > EXPIRY_MARGIN_MS) return copy(cached);
    this.cache.delete(key);
    // A completion from before refresh must never restore an evicted token.
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    try {
      const result = entitlement(await this.request("/v1/github/token", req), req);
      if (this.generations.get(key) === generation && result.expiresAt &&
        Date.parse(result.expiresAt) - Date.now() > EXPIRY_MARGIN_MS) {
        this.cache.set(key, copy(result));
      }
      return result;
    } catch (error) {
      if (!(error instanceof TesseraClientError)) throw new TesseraClientError("invalid_response");
      if (req.identity !== "app" || this.env.MARCH_TESSERA_GH_TOKEN_FALLBACK !== "1") throw error;
      // Trimmed like other ambient-token readers; CR/LF would be header injection, so treat it as absent.
      // Each candidate is validated on its own, so a bad GH_TOKEN still lets GITHUB_TOKEN recover.
      const token = [this.env.GH_TOKEN, this.env.GITHUB_TOKEN].map(v => v?.trim()).find(v => v && !/[\r\n]/.test(v));
      if (!token) throw error;
      const service = tesseraConsumerService(this.env);
      try {
        this.logger ??= createServiceLogger({ serviceName: "march-tessera-client", env: this.env,
          logFilePath: path.join(this.env.HOME || os.homedir(), ".march", "logs", "tessera-client.jsonl"), stdout: process.stderr });
        this.logger.warn({ event: "tessera.client.fallback", service }, "Using ambient GitHub migration credential");
      } catch {
        // Durable log unavailable (e.g. read-only HOME): still warn, and keep the fallback usable.
        process.stderr.write(JSON.stringify({ level: "warn", event: "tessera.client.fallback", service, msg: "Using ambient GitHub migration credential" }) + "\n");
      }
      recordTesseraFallback(service);
      return { token, expiresAt: null, identity: "unknown", commitIdentity: null, source: "env-fallback" };
    }
  }
  async status(): Promise<TesseraStatus> { return statusBody(await this.request("/status")); }
  async reachable(): Promise<boolean> {
    try { const body = await this.request("/healthz"); return object(body) && body.status === "ok"; }
    catch { return false; }
  }
}
// One convenience client per effective configuration. Replacing it on configuration
// changes avoids retaining old credentials or sharing state across callers.
let defaultClient: { baseUrl?: string; clientKey?: string; fallback?: string; client: TesseraClient } | undefined;
export function getGitHubToken(req: GitHubTokenRequest): Promise<GitHubEntitlement> {
  const { MARCH_TESSERA_URL: baseUrl, MARCH_TESSERA_CLIENT_KEY: clientKey, MARCH_TESSERA_GH_TOKEN_FALLBACK: fallback } = process.env;
  if (!defaultClient || defaultClient.baseUrl !== baseUrl || defaultClient.clientKey !== clientKey || defaultClient.fallback !== fallback) {
    defaultClient = { baseUrl, clientKey, fallback, client: new TesseraClient() };
  }
  return defaultClient.client.issueGitHubToken(req);
}
