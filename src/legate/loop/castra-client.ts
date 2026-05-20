import { execFileSync } from "node:child_process";

/**
 * Synchronous Castra client for the legate loop. The tick loop is synchronous
 * (execFileSync throughout), so rather than make every agent-deck call async we
 * speak to the Castra HTTP API via `curl` — one more child process alongside the
 * git/gh/smithy ones the loop already runs. This is the interdiction layer that
 * lets the loop stop bind-mounting / shelling out to `agent-deck`: Castra owns
 * the one agent-deck install and we make backend-agnostic HTTP calls to it.
 *
 * Responses are mapped back to the agent-deck-shaped session objects the loop
 * already consumes (`id`/`status`/`group`/`worktree_path`/…) so the loop's
 * classification + babysit logic is unchanged.
 */

const DEFAULT_URL = "http://localhost:9264";
const CURL_MAX_BUFFER = 16 * 1024 * 1024;
const CURL_TIMEOUT_SECONDS = 30;

export class CastraClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "CastraClientError";
    this.status = status;
  }
}

/** Base URL of the Castra service (no trailing slash). */
export function resolveCastraUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MARCH_CASTRA_URL?.trim() || env.CASTRA_URL?.trim();
  return (explicit && explicit.length > 0 ? explicit : DEFAULT_URL).replace(/\/+$/, "");
}

/** Agent-deck-shaped session the loop consumes (mapped from Castra's CastraSession). */
export interface LoopSession {
  readonly id: string;
  readonly title: string;
  readonly name: string;
  readonly group: string;
  readonly status: string;
  readonly branch: string;
  readonly worktree_path: string;
  readonly created_at: string;
}

interface CastraSessionWire {
  sessionId: string;
  title: string;
  group: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
  status: string;
}

function toLoopSession(s: CastraSessionWire): LoopSession {
  return {
    id: s.sessionId,
    title: s.title,
    name: s.title,
    group: s.group,
    status: s.status || "other",
    branch: s.branch,
    worktree_path: s.worktreePath,
    created_at: s.createdAt,
  };
}

export interface CastraRequestInput {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  /** Sets `x-march-slice-id` so Castra's span nests under the dispatch trace. */
  readonly sliceId?: string;
}

/**
 * Make one synchronous Castra API call via curl. Returns the parsed JSON body.
 * Throws {@link CastraClientError} (carrying the HTTP status) on transport
 * failure or any non-2xx response, mapping Castra's `{error:{message}}` envelope.
 */
export function castraRequest(
  input: CastraRequestInput,
  env: NodeJS.ProcessEnv = process.env,
): any {
  const base = resolveCastraUrl(env);
  const token = env.CASTRA_API_TOKEN?.trim() || "";
  // `-w \n%{http_code}` appends the status after the body so we can split it off.
  const args = [
    "-sS",
    "--max-time",
    String(CURL_TIMEOUT_SECONDS),
    "-X",
    input.method,
    "-w",
    "\n%{http_code}",
  ];
  if (token) args.push("-H", `authorization: Bearer ${token}`);
  if (input.sliceId) args.push("-H", `x-march-slice-id: ${input.sliceId}`);
  if (input.body !== undefined) {
    args.push("-H", "content-type: application/json", "--data-binary", JSON.stringify(input.body));
  }
  args.push(base + input.path);

  let raw: string;
  try {
    raw = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: CURL_MAX_BUFFER,
    });
  } catch (err) {
    throw new CastraClientError(
      `Could not reach Castra at ${base}: ${(err as Error).message}`,
    );
  }
  const nl = raw.lastIndexOf("\n");
  const code = Number((nl >= 0 ? raw.slice(nl + 1) : raw).trim());
  const bodyText = nl >= 0 ? raw.slice(0, nl) : "";
  let parsed: any = {};
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = {};
    }
  }
  if (!Number.isFinite(code) || code < 200 || code >= 300) {
    const msg = parsed?.error?.message || `Castra ${input.method} ${input.path} -> ${code || "?"}`;
    throw new CastraClientError(msg, code || 0);
  }
  return parsed;
}

function q(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? "?" + parts.join("&") : "";
}

export interface CastraLaunchInput {
  readonly profile: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly title: string;
  readonly group?: string;
  readonly model?: string;
  readonly sliceId?: string;
  /** False attaches to an existing worktree/branch (steward relaunch). Default true. */
  readonly createBranch?: boolean;
}

/** GET /v1/sessions — agent-deck list, mapped to loop sessions. */
export function castraListSessions(
  profile: string,
  group?: string,
  env: NodeJS.ProcessEnv = process.env,
): LoopSession[] {
  const res = castraRequest({ method: "GET", path: "/v1/sessions" + q({ profile, group }) }, env);
  const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
  return sessions.map(toLoopSession);
}

/** POST /v1/sessions — launch a steward/worker session. */
export function castraLaunch(
  input: CastraLaunchInput,
  env: NodeJS.ProcessEnv = process.env,
): LoopSession {
  const res = castraRequest(
    {
      method: "POST",
      path: "/v1/sessions",
      sliceId: input.sliceId,
      body: {
        profile: input.profile,
        repoPath: input.repoPath,
        branch: input.branch,
        title: input.title,
        ...(input.group ? { group: input.group } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.createBranch === false ? { createBranch: false } : {}),
      },
    },
    env,
  );
  return toLoopSession(res.session);
}

/** GET /v1/sessions/:id/output — recent session output. */
export function castraSessionOutput(
  profile: string,
  sessionId: string,
  lines: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const res = castraRequest(
    {
      method: "GET",
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/output` + q({ profile, lines }),
    },
    env,
  );
  return typeof res?.output === "string" ? res.output : "";
}

/** POST /v1/sessions/:id/send — message a session. */
export function castraSend(
  profile: string,
  sessionId: string,
  prompt: string,
  sliceId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  castraRequest(
    {
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/send`,
      body: { profile, prompt },
      sliceId,
    },
    env,
  );
}

/** POST /v1/sessions/:id/set — set an allow-listed attribute (auto-mode/title/model). */
export function castraSet(
  profile: string,
  sessionId: string,
  key: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  castraRequest(
    {
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(sessionId)}/set`,
      body: { profile, key, value },
    },
    env,
  );
}

/** DELETE /v1/sessions/:id — remove a session (idempotent). */
export function castraRemove(
  profile: string,
  sessionId: string,
  pruneWorktree: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { removed: boolean } {
  const res = castraRequest(
    {
      method: "DELETE",
      path: `/v1/sessions/${encodeURIComponent(sessionId)}` + q({ profile, pruneWorktree }),
    },
    env,
  );
  return { removed: Boolean(res?.removed) };
}
