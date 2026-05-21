import { heraldPort } from "../config.js";
import type { HeraldEvent, SystemState } from "../events.js";
import type { EventsPage } from "./types.js";

export class HeraldClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeraldClientError";
  }
}

/** Herald was unreachable (connection refused / DNS / timeout). */
export class HeraldUnavailableError extends HeraldClientError {
  constructor(message: string) {
    super(message);
    this.name = "HeraldUnavailableError";
  }
}

/** Herald returned 404 for a requested resource. */
export class HeraldNotFoundError extends HeraldClientError {
  constructor(message: string) {
    super(message);
    this.name = "HeraldNotFoundError";
  }
}

/**
 * True when a Herald endpoint is explicitly configured (`MARCH_HERALD_URL`).
 * The legate gates inbox consumption on this so a deployment without Herald —
 * or a test — keeps its own polling path instead of attempting a doomed
 * localhost connection.
 */
export function heraldConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARCH_HERALD_URL?.trim().length ?? 0) > 0;
}

/** Resolve the Herald service base URL (no trailing slash). */
export function resolveHeraldUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MARCH_HERALD_URL?.trim();
  const base =
    explicit && explicit.length > 0
      ? explicit
      : `http://localhost:${heraldPort()}`;
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

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HeraldClientOptions {
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchImpl;
  /** W3C traceparent to propagate so herald spans nest under the caller's trace. */
  readonly traceparent?: string;
  /** Per-request timeout in ms (default 30s). */
  readonly timeoutMs?: number;
}

/**
 * Thin HTTP client for the Herald service. The legate drains the inbox with
 * {@link events} (and posts transition events with {@link append}, PR2);
 * operators read {@link state}/{@link status}. A connection failure raises
 * {@link HeraldUnavailableError} so callers degrade safely.
 */
export class HeraldClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly traceparent?: string;
  private readonly timeoutMs: number;

  constructor(options: HeraldClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? resolveHeraldUrl(options.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.traceparent = options.traceparent;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers["content-type"] = "application/json";
    if (this.traceparent) headers["traceparent"] = this.traceparent;
    return headers;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new HeraldUnavailableError(
        `Could not reach the herald service at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { status: res.status, body: await parseJsonBody(res) };
  }

  /** Drain the inbox: events with `seq` strictly greater than `after`. */
  async events(query: { after?: number; limit?: number } = {}): Promise<EventsPage> {
    const params = new URLSearchParams();
    if (query.after !== undefined) params.set("after", String(query.after));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    const { status, body } = await this.request("GET", `/events${qs ? `?${qs}` : ""}`);
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald GET /events failed (${status})`));
    }
    const page = body as Partial<EventsPage>;
    return { events: page.events ?? [], lastSeq: page.lastSeq ?? (query.after ?? 0) };
  }

  /** Append a transition event (the legate's write path; Herald assigns seq). */
  async append(input: { type: string; [k: string]: unknown }): Promise<HeraldEvent> {
    const { status, body } = await this.request("POST", "/events", { source: "legate", ...input });
    if (status !== 201) {
      throw new HeraldClientError(bodyError(body, `herald POST /events failed (${status})`));
    }
    return body as HeraldEvent;
  }

  /** The current projection (or, with `at`, the projection as of a seq). */
  async state(at?: number): Promise<SystemState> {
    const qs = at !== undefined ? `?at=${at}` : "";
    const { status, body } = await this.request("GET", `/state${qs}`);
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald GET /state failed (${status})`));
    }
    return body as SystemState;
  }

  /** The events that moved state from `from` to `to` (default `to` = latest). */
  async delta(from: number, to?: number): Promise<{ from: number; to: number; events: HeraldEvent[] }> {
    const params = new URLSearchParams({ from: String(from) });
    if (to !== undefined) params.set("to", String(to));
    const { status, body } = await this.request("GET", `/state/delta?${params.toString()}`);
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald GET /state/delta failed (${status})`));
    }
    return body as { from: number; to: number; events: HeraldEvent[] };
  }

  /** Heartbeat/observe summary (mirrors the legate loop's /status). */
  async status(): Promise<Record<string, unknown>> {
    const { status, body } = await this.request("GET", "/status");
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald GET /status failed (${status})`));
    }
    return body as Record<string, unknown>;
  }
}
