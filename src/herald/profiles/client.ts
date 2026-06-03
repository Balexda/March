import {
  HeraldClientError,
  HeraldNotFoundError,
  HeraldUnavailableError,
  resolveHeraldUrl,
} from "../service/client.js";
import type { ProfileRecord, RegisterProfileInput } from "./types.js";

type FetchImpl = typeof fetch;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

export interface ProfileClientOptions {
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchImpl;
  /** W3C traceparent to propagate so herald spans nest under the caller's trace. */
  readonly traceparent?: string;
  readonly timeoutMs?: number;
}

/**
 * Thin HTTP client for Herald's profile registry. The legate and Herald's own
 * observer call {@link list} each tick to learn which profiles to drive/observe;
 * `march legate init` calls {@link register}. Mirrors {@link HeraldClient}'s
 * transport so the future profile service is a base-URL swap.
 */
export class ProfileClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly traceparent?: string;
  private readonly timeoutMs: number;

  constructor(options: ProfileClientOptions = {}) {
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

  /** List registered profiles (active only unless `includeRemoved`). */
  async list(options: { includeRemoved?: boolean } = {}): Promise<ProfileRecord[]> {
    const qs = options.includeRemoved ? "?all=1" : "";
    const { status, body } = await this.request("GET", `/profiles${qs}`);
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald GET /profiles failed (${status})`));
    }
    return ((body as { profiles?: ProfileRecord[] }).profiles ?? []);
  }

  /** Fetch one profile, or null when Herald returns 404. */
  async get(profile: string): Promise<ProfileRecord | null> {
    const { status, body } = await this.request("GET", `/profiles/${encodeURIComponent(profile)}`);
    if (status === 404) return null;
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald GET /profiles/${profile} failed (${status})`));
    }
    return body as ProfileRecord;
  }

  /** Register/upsert a profile. */
  async register(input: RegisterProfileInput): Promise<ProfileRecord> {
    const { status, body } = await this.request("POST", "/profiles", input);
    if (status !== 201) {
      throw new HeraldClientError(bodyError(body, `herald POST /profiles failed (${status})`));
    }
    return body as ProfileRecord;
  }

  /** Soft-remove a profile. Throws {@link HeraldNotFoundError} on 404. */
  async remove(profile: string): Promise<ProfileRecord> {
    const { status, body } = await this.request("DELETE", `/profiles/${encodeURIComponent(profile)}`);
    if (status === 404) {
      throw new HeraldNotFoundError(bodyError(body, `unknown profile "${profile}".`));
    }
    if (status !== 200) {
      throw new HeraldClientError(bodyError(body, `herald DELETE /profiles/${profile} failed (${status})`));
    }
    return body as ProfileRecord;
  }
}
