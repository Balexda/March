import { execFileSync } from "node:child_process";

/**
 * Steward-session removal seam.
 *
 * Brood owns worktree/branch/container teardown, but the steward is an
 * agent-deck session whose lifecycle belongs to **castra** (the interactive-
 * sessions host, #153). When castra is configured (`MARCH_CASTRA_URL`), brood
 * asks castra to remove the session and lets castra decide whether it also
 * reclaims the worktree — brood re-checks afterward. When castra is absent,
 * brood falls back to invoking `agent-deck` directly.
 *
 * The fallback deliberately omits `--prune-worktree`: brood owns the worktree
 * and removes it by exact path itself (issue #155). agent-deck must never run
 * the blanket prune.
 */

import { CASTRA_TOKEN_ENV } from "../../castra/config.js";

const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

export interface StewardRemoveResult {
  /** Whether a session was actually removed (false = already gone). */
  readonly removed: boolean;
  /** Which backend performed the removal. */
  readonly via: "castra" | "agent-deck";
  readonly detail?: string;
}

export class CastraClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastraClientError";
  }
}

/** Resolve castra's base URL (no trailing slash), or undefined if unconfigured. */
export function resolveCastraBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env.MARCH_CASTRA_URL?.trim();
  return explicit && explicit.length > 0
    ? explicit.replace(/\/+$/, "")
    : undefined;
}

/** True when a castra endpoint is configured. */
export function castraConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCastraBaseUrl(env) !== undefined;
}

type FetchImpl = typeof fetch;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function removeViaCastra(
  baseUrl: string,
  sessionId: string,
  profile: string | undefined,
  token: string | undefined,
  fetchImpl: FetchImpl,
): Promise<StewardRemoveResult> {
  // Castra's DELETE /v1/sessions/:id requires the agent-deck `profile` and lets
  // the caller opt out of pruning the worktree. Brood owns the worktree and
  // removes it by exact path afterward, so pruneWorktree=false (#155).
  const query = new URLSearchParams({ pruneWorktree: "false" });
  if (profile) query.set("profile", profile);
  let res: Response;
  try {
    res = await fetchImpl(
      `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`,
      {
        method: "DELETE",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    );
  } catch (err) {
    throw new CastraClientError(
      `Could not reach castra at ${baseUrl}: ${errMessage(err)}`,
    );
  }
  if (res.status === 404) {
    return { removed: false, via: "castra", detail: "session not found" };
  }
  if (res.status >= 200 && res.status < 300) {
    const body = (await res.json().catch(() => ({}))) as { removed?: boolean };
    return { removed: body.removed ?? true, via: "castra" };
  }
  const body = await res.text().catch(() => "");
  throw new CastraClientError(
    `castra DELETE /v1/sessions/${sessionId} failed (${res.status})${
      body ? `: ${body}` : ""
    }`,
  );
}

/** Direct agent-deck removal (no `--prune-worktree`). Tolerates "not found". */
export function removeStewardSessionViaAgentDeck(
  sessionId: string,
  profile?: string,
): StewardRemoveResult {
  const args = [
    ...(profile ? ["-p", profile] : []),
    "session",
    "remove",
    sessionId,
    "--force",
  ];
  try {
    execFileSync("agent-deck", args, {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return { removed: true, via: "agent-deck" };
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const output = [e.stdout, e.stderr, e.message]
      .map((part) => (part == null ? "" : String(part)))
      .join("\n");
    if (/not found|no such session|does not exist/i.test(output)) {
      return { removed: false, via: "agent-deck", detail: "session not found" };
    }
    throw new CastraClientError(
      `agent-deck session remove failed: ${output.trim() || "unknown error"}`,
    );
  }
}

export interface RemoveStewardSessionInput {
  readonly sessionId: string;
  readonly profile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchImpl;
  /** Override the agent-deck fallback (tests). */
  readonly agentDeckImpl?: (
    sessionId: string,
    profile?: string,
  ) => StewardRemoveResult;
}

/**
 * Remove a steward session — via castra when configured, else via agent-deck.
 * Either path omits any worktree prune; the caller owns the worktree.
 */
export async function removeStewardSession(
  input: RemoveStewardSessionInput,
): Promise<StewardRemoveResult> {
  const env = input.env ?? process.env;
  const baseUrl = resolveCastraBaseUrl(env);
  if (baseUrl) {
    return removeViaCastra(
      baseUrl,
      input.sessionId,
      input.profile,
      env[CASTRA_TOKEN_ENV]?.trim() || undefined,
      input.fetchImpl ?? fetch,
    );
  }
  const agentDeck = input.agentDeckImpl ?? removeStewardSessionViaAgentDeck;
  return agentDeck(input.sessionId, input.profile);
}
