import type { JobRecord, SpawnRequest } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:8080";
const POLL_INTERVAL_MS = 2000;
// Slightly above the server's 3600s spawn timeout so an at-limit spawn can still
// report a terminal status before the client gives up.
const DEFAULT_TIMEOUT_MS = 3_900_000;

export class HatcheryClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatcheryClientError";
  }
}

/** Resolve the hatchery service base URL (no trailing slash). */
export function resolveHatcheryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MARCH_HATCHERY_URL?.trim();
  return (explicit && explicit.length > 0 ? explicit : DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

export interface CreatedJob {
  readonly id: string;
  readonly status: string;
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

export async function postSpawn(
  baseUrl: string,
  request: SpawnRequest,
  fetchImpl: FetchImpl = fetch,
): Promise<CreatedJob> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/spawns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new HatcheryClientError(
      `Could not reach the hatchery service at ${baseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const body = await parseJsonBody(res);
  if (res.status !== 202) {
    throw new HatcheryClientError(
      bodyError(body, `hatchery POST /spawns failed with status ${res.status}`),
    );
  }
  return body as CreatedJob;
}

export async function getJob(
  baseUrl: string,
  id: string,
  fetchImpl: FetchImpl = fetch,
): Promise<JobRecord> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/spawns/${id}`);
  } catch (err) {
    throw new HatcheryClientError(
      `Could not reach the hatchery service at ${baseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const body = await parseJsonBody(res);
  if (res.status !== 200) {
    throw new HatcheryClientError(
      bodyError(body, `hatchery GET /spawns/${id} failed with status ${res.status}`),
    );
  }
  return body as JobRecord;
}

export interface PollOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchImpl;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export async function pollUntilTerminal(
  baseUrl: string,
  id: string,
  options: PollOptions = {},
): Promise<JobRecord> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  for (;;) {
    const job = await getJob(baseUrl, id, fetchImpl);
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (now() >= deadline) {
      throw new HatcheryClientError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for spawn job ${id}.`,
      );
    }
    await sleep(intervalMs);
  }
}

export interface RunSpawnViaServiceOptions extends PollOptions {
  readonly baseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** POST a spawn request and block (by polling) until the job reaches a terminal state. */
export async function runSpawnViaService(
  request: SpawnRequest,
  options: RunSpawnViaServiceOptions = {},
): Promise<JobRecord> {
  const baseUrl = options.baseUrl ?? resolveHatcheryUrl(options.env);
  const created = await postSpawn(baseUrl, request, options.fetchImpl);
  return pollUntilTerminal(baseUrl, created.id, options);
}
