import os from "node:os";

/**
 * Thin HTTP client for the running Legate service's operator levers (#593).
 * Every `march legate <lever>` verb posts through {@link legatePost}, which adds
 * the operator bearer token (when configured) and keeps the request bounded, so
 * a wedged listener fails as a clean exit instead of hanging.
 */

/** Default loopback port of the legate service (mirrors `DEFAULT_LOOP_PORT`). */
const DEFAULT_LEGATE_PORT = 8787;

/** Env var carrying the operator bearer token (mirrors `LEGATE_OPERATOR_TOKEN_ENV`). */
const OPERATOR_TOKEN_ENV = "MARCH_LEGATE_OPERATOR_TOKEN";

/** Bound on one lever request; the abort surfaces as the unreachable error. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Base URL of the running legate service (MARCH_LEGATE_URL, else loopback port). */
export function legateServiceBase(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MARCH_LEGATE_URL?.trim() ||
    `http://127.0.0.1:${env.MARCH_LEGATE_PORT?.trim() || env.MARCH_LEGATE_LOOP_PORT?.trim() || DEFAULT_LEGATE_PORT}`
  ).replace(/\/+$/, "");
}

/**
 * Who is asking, for the event-log attribution: `--operator`, else
 * `MARCH_OPERATOR`, else the OS username. Empty when none is available (some
 * containers have no passwd entry) — Legate then records "unknown".
 */
export function resolveOperator(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = explicit?.trim() || env.MARCH_OPERATOR?.trim();
  if (named) return named;
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

/** The legate service could not be reached (connection refused, timeout, ...). */
export class LegateUnreachableError extends Error {
  constructor(base: string, cause: string) {
    super(
      `Could not reach the legate service at ${base}: ${cause}. ` +
        "Is `march legate serve` up? Set MARCH_LEGATE_URL to override.",
    );
    this.name = "LegateUnreachableError";
  }
}

/** A lever response: the HTTP status and the parsed JSON body. */
export interface LegateResponse<T> {
  status: number;
  ok: boolean;
  body: T & { ok?: boolean; error?: string };
}

/** Loopback hosts, where plain HTTP never leaves the machine. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Refuse to send the operator bearer token in cleartext: a non-loopback
 * `MARCH_LEGATE_URL` must be https when a token is set (RFC 6750 §5.3). Loopback
 * http (the default) and any https base are fine.
 */
export function assertTokenTransport(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`MARCH_LEGATE_URL "${base}" is not a valid URL.`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) return;
  throw new Error(
    `Refusing to send ${OPERATOR_TOKEN_ENV} to ${base} over ${url.protocol.replace(/:$/, "")}: ` +
      "use an https MARCH_LEGATE_URL for a non-loopback legate.",
  );
}

/** POST a JSON body to a legate route with the operator token when configured. */
export async function legatePost<T = Record<string, unknown>>(
  route: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegateResponse<T>> {
  const base = legateServiceBase(env);
  const token = env[OPERATOR_TOKEN_ENV]?.trim();
  if (token) assertTokenTransport(base);
  let res: Response;
  try {
    res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LegateUnreachableError(base, (err as Error).message);
  }
  // A body that is not a JSON object is never an acknowledgement: a refusal keeps
  // its status (with the raw text as the error), but a 2xx that cannot be read —
  // say a proxy's HTML page — fails rather than reporting success.
  const text = await res.text().catch((err) => {
    throw new LegateUnreachableError(base, `reading the response failed: ${(err as Error).message}`);
  });
  let parsed: (T & { ok?: boolean; error?: string }) | null = null;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
  } catch {
    // fall through
  }
  if (!parsed) {
    const snippet = text.trim().slice(0, 200) || "(empty body)";
    if (res.ok) throw new Error(`The legate service at ${base} returned HTTP ${res.status} without a JSON acknowledgement: ${snippet}`);
    return { status: res.status, ok: false, body: { error: `HTTP ${res.status}: ${snippet}` } as T & { ok?: boolean; error?: string } };
  }
  // Every lever acknowledges with a boolean `ok`; a 2xx without `ok: true` is
  // not an acknowledgement and must not exit 0.
  if (res.ok && parsed.ok !== true) {
    const error = parsed.error ?? `The legate service at ${base} returned HTTP ${res.status} without an \`ok: true\` acknowledgement.`;
    return { status: res.status, ok: false, body: { ...parsed, error } };
  }
  return { status: res.status, ok: res.ok, body: parsed };
}
