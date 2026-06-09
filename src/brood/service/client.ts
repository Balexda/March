import { broodPort } from "../config.js";
import type { SweepResult } from "./steward-removal.js";
import type {
  ListSessionsFilter,
  RegisterSessionInput,
  SessionRecord,
  TeardownRequest,
  TeardownResult,
  UpdateSessionInput,
} from "./types.js";

export class BroodClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroodClientError";
  }
}

/** Brood was unreachable (connection refused / DNS / timeout). */
export class BroodUnavailableError extends BroodClientError {
  constructor(message: string) {
    super(message);
    this.name = "BroodUnavailableError";
  }
}

/** Brood returned 404 — the session is not tracked (teardown is a no-op). */
export class BroodNotFoundError extends BroodClientError {
  constructor(message: string) {
    super(message);
    this.name = "BroodNotFoundError";
  }
}

/**
 * True when a brood endpoint is explicitly configured (`MARCH_BROOD_URL`).
 * Producers (the Hatchery service) gate registration on this so a deployment
 * without brood — or a test — never attempts a doomed localhost connection.
 */
export function broodConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARCH_BROOD_URL?.trim().length ?? 0) > 0;
}

/** Resolve the brood service base URL (no trailing slash). */
export function resolveBroodUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MARCH_BROOD_URL?.trim();
  const base =
    explicit && explicit.length > 0
      ? explicit
      : `http://localhost:${broodPort()}`;
  return base.replace(/\/+$/, "");
}

type FetchImpl = typeof fetch;

async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function bodyError(body: unknown, fallback: string): string {
  const message = (body as { error?: unknown }).error;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

/** Default per-request timeout. The legate loop calls teardown synchronously
 *  (`execFileSync(march brood teardown …)`), so a stalled brood must not block
 *  it indefinitely. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface BroodClientOptions {
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchImpl;
  /** W3C traceparent to propagate so brood spans nest under the caller's trace. */
  readonly traceparent?: string;
  /** Per-request timeout in ms (default 30s). */
  readonly timeoutMs?: number;
  /** Bearer token for the break-glass `POST /admin/sweep` endpoint (#304).
   *  Defaults to `MARCH_BROOD_ADMIN_TOKEN`; only the admin sweep path reads it. */
  readonly adminToken?: string;
}

/**
 * Thin HTTP client for the brood service. Used by the Hatchery handoff to
 * register sessions and by operators/standalone dispatch to query and tear
 * them down. A connection failure raises {@link BroodUnavailableError} so
 * callers can degrade safely (the legate loop, critically, must NOT fall back
 * to pruning when brood is unreachable).
 */
export class BroodClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly traceparent?: string;
  private readonly timeoutMs: number;
  private readonly adminToken?: string;

  constructor(options: BroodClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? resolveBroodUrl(options.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.traceparent = options.traceparent;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.adminToken =
      options.adminToken ??
      ((options.env ?? process.env).MARCH_BROOD_ADMIN_TOKEN?.trim() || undefined);
  }

  private headers(
    json: boolean,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers["content-type"] = "application/json";
    if (this.traceparent) headers["traceparent"] = this.traceparent;
    return { ...headers, ...extra };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined, extraHeaders),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BroodUnavailableError(
        `Could not reach the brood service at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { status: res.status, body: await parseJsonBody(res) };
  }

  async register(input: RegisterSessionInput): Promise<SessionRecord> {
    const { status, body } = await this.request("POST", "/sessions", input);
    if (status !== 201) {
      throw new BroodClientError(
        bodyError(body, `brood POST /sessions failed (${status})`),
      );
    }
    return body as SessionRecord;
  }

  async update(
    id: string,
    changes: UpdateSessionInput,
  ): Promise<SessionRecord> {
    const { status, body } = await this.request(
      "PATCH",
      `/sessions/${encodeURIComponent(id)}`,
      changes,
    );
    if (status !== 200) {
      throw new BroodClientError(
        bodyError(body, `brood PATCH /sessions/${id} failed (${status})`),
      );
    }
    return body as SessionRecord;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const { status, body } = await this.request(
      "GET",
      `/sessions/${encodeURIComponent(id)}`,
    );
    if (status === 404) return undefined;
    if (status !== 200) {
      throw new BroodClientError(
        bodyError(body, `brood GET /sessions/${id} failed (${status})`),
      );
    }
    return body as SessionRecord;
  }

  async list(filter: ListSessionsFilter = {}): Promise<SessionRecord[]> {
    const params = new URLSearchParams();
    if (filter.kind) params.set("kind", filter.kind);
    if (filter.status) params.set("status", filter.status);
    if (filter.parentId) params.set("parentId", filter.parentId);
    const query = params.toString();
    const { status, body } = await this.request(
      "GET",
      `/sessions${query ? `?${query}` : ""}`,
    );
    if (status !== 200) {
      throw new BroodClientError(
        bodyError(body, `brood GET /sessions failed (${status})`),
      );
    }
    return (body as { sessions?: SessionRecord[] }).sessions ?? [];
  }

  async teardown(
    id: string,
    request: TeardownRequest = {},
  ): Promise<TeardownResult> {
    const { status, body } = await this.request(
      "POST",
      `/sessions/${encodeURIComponent(id)}/teardown`,
      request,
    );
    if (status === 404) {
      throw new BroodNotFoundError(
        bodyError(body, `brood has no session "${id}"`),
      );
    }
    if (status !== 200) {
      throw new BroodClientError(
        bodyError(body, `brood teardown ${id} failed (${status})`),
      );
    }
    return body as TeardownResult;
  }

  /**
   * Reap leaked Castra stewards (#304) — true orphans (no active Brood record)
   * whose work is genuinely done (PR merged/closed or worktree gone). Calls the
   * gated break-glass `POST /admin/sweep` endpoint with the admin bearer token.
   * Idempotent; returns what was reaped (and what was deliberately skipped).
   */
  async sweep(): Promise<SweepResult> {
    if (!this.adminToken) {
      throw new BroodClientError(
        "MARCH_BROOD_ADMIN_TOKEN is not set — the brood admin sweep endpoint is disabled.",
      );
    }
    const { status, body } = await this.request("POST", "/admin/sweep", undefined, {
      authorization: `Bearer ${this.adminToken}`,
    });
    if (status === 401) {
      throw new BroodClientError(
        bodyError(body, "brood admin sweep rejected the bearer token (401)"),
      );
    }
    if (status === 404) {
      throw new BroodClientError(
        "brood admin sweep is disabled (MARCH_BROOD_ADMIN_TOKEN unset on the service).",
      );
    }
    if (status !== 200) {
      throw new BroodClientError(bodyError(body, `brood sweep failed (${status})`));
    }
    return body as SweepResult;
  }
}
