import { execFileSync } from "node:child_process";
import { type CastraErrorBody, type CastraSession } from "./types.js";
import { CASTRA_TOKEN_ENV, CASTRA_URL_ENV, resolveCastraPort } from "./config.js";

/**
 * HTTP client for the Castra API — the consumer-side counterpart to
 * `src/castra/server.ts`. The Hatchery uses it to drive interactive sessions
 * through Castra over HTTP instead of shelling out to (and mounting) agent-deck
 * itself. The wire shapes and error envelope live in `./types.ts`; this client
 * maps the API's non-2xx envelope back to a typed {@link CastraClientError} that
 * preserves the server's stable error code.
 */

/** Header consumers set to thread a dispatch slice id into Castra's traces. */
const SLICE_ID_HEADER = "x-march-slice-id";

/** Default per-request timeout. Launches can take a few seconds (agent-deck). */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Reachability probe timeout — kept short so `/readyz` stays snappy. */
const REACHABLE_TIMEOUT_MS = 3_000;
/**
 * Profile used by the readiness probe. `reachable()` lists this profile's
 * sessions to confirm Castra can actually serve authenticated `/v1/*` calls;
 * `default` mirrors the Hatchery's fallback profile so the probe exercises a
 * profile that real spawns may use.
 */
const READINESS_PROBE_PROFILE = "default";

type FetchImpl = typeof fetch;

/**
 * A Castra request failed: either the transport was unreachable, or the API
 * returned a non-2xx envelope. `code`/`status` are populated from the API error
 * envelope when present so callers can branch on (e.g.) a launch `conflict`.
 */
export class CastraClientError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "CastraClientError";
    this.code = options.code;
    this.status = options.status;
  }
}

/** Resolve Castra's base URL (no trailing slash). */
export function resolveCastraBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[CASTRA_URL_ENV]?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://localhost:${resolveCastraPort(undefined, env)}`;
}

/** Resolve the bearer token sent on every `/v1/*` request (undefined when unset). */
export function resolveCastraToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = env[CASTRA_TOKEN_ENV]?.trim();
  return token && token.length > 0 ? token : undefined;
}

export interface CastraClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly fetchImpl?: FetchImpl;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LaunchSessionRequest {
  readonly profile: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly title: string;
  readonly group?: string;
  readonly model?: string;
  /** Dispatch trace key forwarded as x-march-slice-id so spans share one trace. */
  readonly traceKey?: string;
  /**
   * Queryable session metadata (e.g. `{ sliceId, spawnId }`) Castra stores and
   * surfaces on {@link CastraSession} from `listSessions`/`show` (#214). Lets
   * Herald reconcile a session to its slice by exact id. Distinct from
   * `traceKey`, which is only forwarded as a span-correlation header.
   */
  readonly metadata?: Record<string, string>;
}

export interface SendPromptRequest {
  readonly profile: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly traceKey?: string;
}

export interface RemoveSessionRequest {
  readonly profile: string;
  readonly sessionId: string;
  readonly pruneWorktree: boolean;
  readonly traceKey?: string;
}

interface RequestOptions {
  readonly traceKey?: string;
  readonly json?: unknown;
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

export class CastraClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchImpl;

  constructor(options: CastraClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (options.baseUrl ?? resolveCastraBaseUrl(env)).replace(/\/+$/, "");
    this.token = options.token ?? resolveCastraToken(env);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /v1/sessions — list sessions (optionally filtered by group). */
  async listSessions(profile: string, group?: string): Promise<CastraSession[]> {
    const qs = new URLSearchParams({ profile });
    if (group) qs.set("group", group);
    const body = await this.request("GET", `/v1/sessions?${qs.toString()}`, { expectStatus: 200 });
    const sessions = (body as { sessions?: CastraSession[] }).sessions;
    return Array.isArray(sessions) ? sessions : [];
  }

  /** GET /v1/sessions/:id/output — recent session output. */
  async sessionOutput(profile: string, sessionId: string, lines?: number): Promise<string> {
    const qs = new URLSearchParams({ profile });
    if (lines !== undefined) qs.set("lines", String(lines));
    const body = await this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/output?${qs.toString()}`,
      { expectStatus: 200 },
    );
    const output = (body as { output?: unknown }).output;
    return typeof output === "string" ? output : "";
  }

  /** Launch a steward session. Returns the identified session (404/409 → throws). */
  async launchSession(req: LaunchSessionRequest): Promise<CastraSession> {
    const body = await this.request("POST", "/v1/sessions", {
      traceKey: req.traceKey,
      json: {
        profile: req.profile,
        repoPath: req.repoPath,
        branch: req.branch,
        title: req.title,
        ...(req.group ? { group: req.group } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.metadata ? { metadata: req.metadata } : {}),
      },
      expectStatus: 201,
    });
    return (body as { session: CastraSession }).session;
  }

  /** Send a prompt to a session (fire-and-forget on the server; 202 Accepted). */
  async sendPrompt(req: SendPromptRequest): Promise<void> {
    await this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(req.sessionId)}/send`,
      {
        traceKey: req.traceKey,
        json: { profile: req.profile, prompt: req.prompt },
        expectStatus: 202,
      },
    );
  }

  /** Remove a session (idempotent: `removed:false` when it was already gone). */
  async removeSession(req: RemoveSessionRequest): Promise<{ removed: boolean }> {
    const qs = new URLSearchParams({
      profile: req.profile,
      pruneWorktree: String(req.pruneWorktree),
    });
    const body = await this.request(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(req.sessionId)}?${qs.toString()}`,
      { traceKey: req.traceKey, expectStatus: 200 },
    );
    return { removed: Boolean((body as { removed?: boolean }).removed) };
  }

  /**
   * Best-effort readiness probe (never throws). Lists the readiness-probe
   * profile's sessions through the authenticated `/v1/*` surface so a `true`
   * means Castra is up, the bearer token is accepted, AND the agent-deck backend
   * answered — not merely that the open `/healthz` is live. A wrong/missing
   * token (401/403) or an unreachable backend (5xx) reports not-ready.
   */
  async reachable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const res = await this.fetchImpl(
        `${this.baseUrl}/v1/sessions?profile=${encodeURIComponent(READINESS_PROBE_PROFILE)}`,
        { headers, signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS) },
      );
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
    const url = `${this.baseUrl}${pathWithQuery}`;
    const headers: Record<string, string> = {};
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.traceKey) headers[SLICE_ID_HEADER] = opts.traceKey;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CastraClientError(
        `Could not reach Castra at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const parsed = await parseJsonBody(res);
    if (res.status !== opts.expectStatus) {
      const envelope = parsed as Partial<CastraErrorBody>;
      const code = envelope?.error?.code;
      const message =
        envelope?.error?.message ??
        `Castra ${method} ${pathWithQuery} failed with status ${res.status}`;
      throw new CastraClientError(message, { code, status: res.status });
    }
    return parsed;
  }
}

/** Construct a {@link CastraClient} from environment configuration. */
export function createCastraClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CastraClient {
  return new CastraClient({ env });
}

// ---------------------------------------------------------------------------
// Synchronous client (curl transport)
// ---------------------------------------------------------------------------

/** Per-request timeout (seconds) for the sync transport. */
const SYNC_TIMEOUT_SECONDS = 60;
const SYNC_MAX_BUFFER = 16 * 1024 * 1024;

export interface SyncLaunchSessionRequest extends LaunchSessionRequest {
  /** False attaches to an existing worktree/branch (steward relaunch). Default true. */
  readonly createBranch?: boolean;
}

/**
 * Synchronous twin of {@link CastraClient}, for the **legate loop**: its tick is
 * fully synchronous (execFileSync throughout), so it cannot await the async
 * client. This speaks the identical API via `curl` — one more child process
 * alongside the git/gh/smithy ones the loop already runs — and reuses the same
 * base-url/token resolution, slice-id header, error envelope ({@link
 * CastraClientError}), and wire types. Prefer the async {@link CastraClient}
 * everywhere that runs on the event loop.
 */
export class SyncCastraClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: { baseUrl?: string; token?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (options.baseUrl ?? resolveCastraBaseUrl(env)).replace(/\/+$/, "");
    this.token = options.token ?? resolveCastraToken(env);
  }

  /** GET /v1/sessions — list sessions (optionally filtered by group). */
  listSessions(profile: string, group?: string): CastraSession[] {
    const qs = new URLSearchParams({ profile });
    if (group) qs.set("group", group);
    const body = this.request("GET", `/v1/sessions?${qs.toString()}`, { expectStatus: 200 });
    const sessions = (body as { sessions?: CastraSession[] }).sessions;
    return Array.isArray(sessions) ? sessions : [];
  }

  /** POST /v1/sessions — launch a steward session. */
  launchSession(req: SyncLaunchSessionRequest): CastraSession {
    const body = this.request("POST", "/v1/sessions", {
      traceKey: req.traceKey,
      json: {
        profile: req.profile,
        repoPath: req.repoPath,
        branch: req.branch,
        title: req.title,
        ...(req.group ? { group: req.group } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.createBranch === false ? { createBranch: false } : {}),
        ...(req.metadata ? { metadata: req.metadata } : {}),
      },
      expectStatus: 201,
    });
    return (body as { session: CastraSession }).session;
  }

  /** GET /v1/sessions/:id/output — recent session output. */
  sessionOutput(profile: string, sessionId: string, lines?: number): string {
    const qs = new URLSearchParams({ profile });
    if (lines !== undefined) qs.set("lines", String(lines));
    const body = this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/output?${qs.toString()}`,
      { expectStatus: 200 },
    );
    const output = (body as { output?: unknown }).output;
    return typeof output === "string" ? output : "";
  }

  /** POST /v1/sessions/:id/send — message a session (202). */
  sendPrompt(req: SendPromptRequest): void {
    this.request("POST", `/v1/sessions/${encodeURIComponent(req.sessionId)}/send`, {
      traceKey: req.traceKey,
      json: { profile: req.profile, prompt: req.prompt },
      expectStatus: 202,
    });
  }

  /** DELETE /v1/sessions/:id — remove a session (idempotent). */
  removeSession(req: RemoveSessionRequest): { removed: boolean } {
    const qs = new URLSearchParams({
      profile: req.profile,
      pruneWorktree: String(req.pruneWorktree),
    });
    const body = this.request(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(req.sessionId)}?${qs.toString()}`,
      { traceKey: req.traceKey, expectStatus: 200 },
    );
    return { removed: Boolean((body as { removed?: boolean }).removed) };
  }

  private request(
    method: string,
    pathWithQuery: string,
    opts: { traceKey?: string; json?: unknown; expectStatus: number },
  ): unknown {
    // `-w \n%{http_code}` appends the status after the body so we can split it.
    const args = ["-sS", "--max-time", String(SYNC_TIMEOUT_SECONDS), "-X", method, "-w", "\n%{http_code}"];
    if (this.token) args.push("-H", `authorization: Bearer ${this.token}`);
    if (opts.traceKey) args.push("-H", `${SLICE_ID_HEADER}: ${opts.traceKey}`);
    if (opts.json !== undefined) {
      args.push("-H", "content-type: application/json", "--data-binary", JSON.stringify(opts.json));
    }
    args.push(`${this.baseUrl}${pathWithQuery}`);

    let raw: string;
    try {
      raw = execFileSync("curl", args, { encoding: "utf-8", maxBuffer: SYNC_MAX_BUFFER });
    } catch (err) {
      throw new CastraClientError(
        `Could not reach Castra at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const nl = raw.lastIndexOf("\n");
    const status = Number((nl >= 0 ? raw.slice(nl + 1) : raw).trim());
    const text = nl >= 0 ? raw.slice(0, nl) : "";
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
    }
    if (status !== opts.expectStatus) {
      const envelope = parsed as Partial<CastraErrorBody>;
      throw new CastraClientError(
        envelope?.error?.message ?? `Castra ${method} ${pathWithQuery} failed with status ${status || "?"}`,
        { code: envelope?.error?.code, status: status || undefined },
      );
    }
    return parsed;
  }
}
