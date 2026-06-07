import {
  type ForgeClient,
  type ForgeErrorBody,
  type ForgeErrorCode,
  type ListPrsRequest,
  type PullRequestListItem,
  type PullRequestSummary,
  type RepoInfo,
  type ReviewThread,
} from "./types.js";
import { resolveStatioBaseUrl, resolveStatioToken } from "./config.js";

const SLICE_ID_HEADER = "x-march-slice-id";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const REACHABLE_TIMEOUT_MS = 3_000;

type FetchImpl = typeof fetch;

export class StatioClientError extends Error {
  readonly code?: ForgeErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    options: { code?: ForgeErrorCode; status?: number } = {},
  ) {
    super(message);
    this.name = "StatioClientError";
    this.code = options.code;
    this.status = options.status;
  }
}

export interface StatioClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly traceKey?: string;
  readonly fetchImpl?: FetchImpl;
  readonly env?: NodeJS.ProcessEnv;
}

interface RequestOptions {
  readonly traceKey?: string;
  readonly expectStatus: number;
  readonly timeoutMs?: number;
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export class StatioClient implements ForgeClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly traceKey: string | undefined;
  private readonly fetchImpl: FetchImpl;

  constructor(options: StatioClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (options.baseUrl ?? resolveStatioBaseUrl(env)).replace(/\/+$/, "");
    this.token = options.token ?? resolveStatioToken(env);
    this.traceKey = options.traceKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /v1/repo — repository owner/name and default branch. */
  async repoInfo(): Promise<RepoInfo> {
    const body = await this.request("GET", "/v1/repo", { expectStatus: 200 });
    return (body as { repo: RepoInfo }).repo;
  }

  /** GET /v1/prs — list pull requests by optional head/author/state filters. */
  async listPrs(req: ListPrsRequest = {}): Promise<PullRequestListItem[]> {
    const qs = new URLSearchParams();
    if (req.head) qs.set("head", req.head);
    if (req.author) qs.set("author", req.author);
    if (req.state) qs.set("state", req.state);
    const query = qs.toString();
    const suffix = query ? `?${query}` : "";
    const body = await this.request("GET", `/v1/prs${suffix}`, { expectStatus: 200 });
    const prs = (body as { prs?: PullRequestListItem[] }).prs;
    return Array.isArray(prs) ? prs : [];
  }

  /** GET /v1/prs/:number — rich single-PR read. */
  async getPr(number: number): Promise<PullRequestSummary> {
    const body = await this.request("GET", `/v1/prs/${encodeURIComponent(String(number))}`, {
      expectStatus: 200,
    });
    return (body as { pr: PullRequestSummary }).pr;
  }

  /** GET /v1/prs/:number/review-threads — unresolved review threads. */
  async reviewThreads(prNumber: number): Promise<ReviewThread[]> {
    const body = await this.request(
      "GET",
      `/v1/prs/${encodeURIComponent(String(prNumber))}/review-threads`,
      { expectStatus: 200 },
    );
    const threads = (body as { threads?: ReviewThread[] }).threads;
    return Array.isArray(threads) ? threads : [];
  }

  /**
   * Best-effort readiness probe. It exercises the authenticated forge-backed
   * `/v1/repo` surface, so wrong tokens, forge failures, and transport failures
   * all report not-ready without throwing.
   */
  async reachable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (this.traceKey) headers[SLICE_ID_HEADER] = this.traceKey;
      const res = await this.fetchImpl(`${this.baseUrl}/v1/repo`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request(
    method: string,
    pathWithQuery: string,
    opts: RequestOptions,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const traceKey = opts.traceKey ?? this.traceKey;
    if (traceKey) headers[SLICE_ID_HEADER] = traceKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathWithQuery}`, {
        method,
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new StatioClientError(
        `Could not reach Statio at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const parsed = await parseJsonBody(res);
    if (res.status !== opts.expectStatus) {
      const envelope = parsed as Partial<ForgeErrorBody>;
      const code = envelope?.error?.code;
      const message =
        envelope?.error?.message ??
        `Statio ${method} ${pathWithQuery} failed with status ${res.status}`;
      throw new StatioClientError(message, { code, status: res.status });
    }
    return parsed;
  }
}

/** Construct a {@link StatioClient} from environment configuration. */
export function createStatioClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StatioClient {
  return new StatioClient({ env });
}
