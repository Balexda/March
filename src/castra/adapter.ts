import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  CastraAgentDeckError,
  CastraConflictError,
  CastraNotFoundError,
  type CastraSession,
} from "./types.js";
import { CASTRA_DEFAULT_MODEL } from "./config.js";

/**
 * The agent-deck adapter: the single place that turns Castra operations into
 * `agent-deck` CLI invocations. The argv shapes, the worktree-race guard, and
 * the JSON parsers are lifted from the Hatchery handoff path
 * (`src/hatchery/spawn-handoff.ts`) so Castra and that path stay byte-compatible
 * in how they drive agent-deck. (Unifying the two into one import is a tracked
 * follow-up; this module is the intended single source of truth.)
 *
 * The argv builders and parsers are exported pure functions so they can be
 * unit-tested directly and reused by the eventual `spawn-handoff.ts` refactor.
 */

const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// argv builders (pure)
// ---------------------------------------------------------------------------

export function buildListArgs(profile: string): string[] {
  return ["-p", profile, "list", "--json"];
}

export function buildLaunchArgs(input: {
  readonly profile: string;
  readonly repoPath: string;
  readonly title: string;
  readonly group: string;
  readonly branch: string;
  readonly model?: string;
  /** Create a new branch (-b). False attaches to an existing worktree/branch
   * (the legate loop's steward-relaunch path). Defaults to true. */
  readonly createBranch?: boolean;
}): string[] {
  return [
    "-p",
    input.profile,
    "launch",
    input.repoPath,
    "-t",
    input.title,
    "-c",
    "claude",
    "-g",
    input.group,
    "--worktree",
    input.branch,
    // -b creates the branch; omit it to attach to an existing worktree.
    ...(input.createBranch === false ? [] : ["-b"]),
    "--title-lock",
    "--extra-arg",
    "--permission-mode",
    "--extra-arg",
    "auto",
    "--extra-arg",
    "--model",
    "--extra-arg",
    input.model?.trim() || CASTRA_DEFAULT_MODEL,
  ];
}

export function buildSessionShowArgs(profile: string, sessionId: string): string[] {
  return ["-p", profile, "session", "show", sessionId, "--json"];
}

export function buildSessionSendArgs(
  profile: string,
  sessionId: string,
  prompt: string,
): string[] {
  return ["-p", profile, "session", "send", sessionId, prompt];
}

export function buildSessionSetArgs(
  profile: string,
  sessionId: string,
  key: string,
  value: string,
): string[] {
  return ["-p", profile, "session", "set", sessionId, key, value];
}

export function buildSessionRemoveArgs(
  profile: string,
  sessionId: string,
  pruneWorktree: boolean,
): string[] {
  return [
    "-p",
    profile,
    "session",
    "remove",
    sessionId,
    ...(pruneWorktree ? ["--prune-worktree"] : []),
    "--force",
  ];
}

export function buildSessionOutputArgs(profile: string, sessionId: string): string[] {
  return ["-p", profile, "session", "output", sessionId];
}

// ---------------------------------------------------------------------------
// parsers (pure) — copied from spawn-handoff.ts
// ---------------------------------------------------------------------------

function parseJsonMaybe(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function parseAgentDeckSession(
  record: Record<string, unknown>,
): CastraSession | null {
  const sessionId = firstString(record, ["id", "session_id", "sessionId"]);
  if (!sessionId) return null;
  return {
    sessionId,
    title: firstString(record, ["title", "name"]) ?? "",
    group: firstString(record, ["group"]) ?? "",
    branch: firstString(record, ["worktree_branch", "branch", "worktreeBranch"]) ?? "",
    worktreePath: firstString(record, ["worktree_path", "path", "worktreePath"]) ?? "",
    createdAt: firstString(record, ["created_at", "createdAt"]) ?? "",
    status: firstString(record, ["status"]) ?? "",
  };
}

/**
 * Derive the worktree directory name agent-deck creates for a branch: its
 * `--worktree` flag produces `feature-<branch>` with "/" rewritten to "-".
 * Copied from spawn-handoff.ts.
 */
export function expectedWorktreeDirName(branch: string): string {
  return "feature-" + branch.replace(/\//g, "-");
}

/**
 * Pick the session created by a single `agent-deck launch` out of the
 * post-launch list, robust to concurrent launches racing in the same tick.
 * Matches by the launched worktree directory (the only per-launch identifier
 * agent-deck reliably surfaces), then by branch, then falls back to the newest
 * not-in-snapshot session. Copied from spawn-handoff.ts — see that file for the
 * full rationale on why diff-since-snapshot alone is unsafe.
 */
export function pickLaunchedSession(
  sessions: readonly CastraSession[],
  beforeIds: ReadonlySet<string>,
  branch: string,
): CastraSession | undefined {
  const expectedDirName = expectedWorktreeDirName(branch);
  const dirMatch = sessions
    .filter((session) => {
      if (beforeIds.has(session.sessionId)) return false;
      if (!session.worktreePath) return false;
      return path.basename(session.worktreePath) === expectedDirName;
    })
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (dirMatch) return dirMatch;
  const branchMatch = sessions
    .filter((session) => session.branch === branch && !beforeIds.has(session.sessionId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (branchMatch) return branchMatch;
  return sessions
    .filter((session) => !beforeIds.has(session.sessionId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

// ---------------------------------------------------------------------------
// exec wrapper
// ---------------------------------------------------------------------------

class AgentDeckExecError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "AgentDeckExecError";
    this.stderr = stderr;
  }
}

function stderrText(stderr: unknown): string {
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf-8").trimEnd();
  if (typeof stderr === "string") return stderr.trimEnd();
  return "";
}

/** Run `agent-deck <args>` capturing stdout. Throws AgentDeckExecError on failure. */
function runAgentDeck(args: readonly string[], capture: boolean): string {
  try {
    const out = execFileSync("agent-deck", args as string[], {
      encoding: "utf-8",
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return typeof out === "string" ? out : "";
  } catch (err) {
    const stderr = stderrText((err as { stderr?: unknown }).stderr);
    throw new AgentDeckExecError(
      stderr || (err as Error).message || "agent-deck command failed",
      stderr,
    );
  }
}

/** Heuristic: does this stderr indicate the session simply doesn't exist? */
function looksLikeNotFound(stderr: string): boolean {
  return /not found|no such|does not exist|no session|unknown session/i.test(stderr);
}

function listSnapshot(profile: string): CastraSession[] {
  const stdout = runAgentDeck(buildListArgs(profile), true);
  const parsed = parseJsonMaybe(stdout.trim());
  if (!Array.isArray(parsed)) {
    throw new CastraAgentDeckError("agent-deck list --json returned unexpected output.");
  }
  return parsed
    .filter(
      (value): value is Record<string, unknown> =>
        !!value && typeof value === "object" && !Array.isArray(value),
    )
    .map((record) => parseAgentDeckSession(record))
    .filter((session): session is CastraSession => session !== null);
}

// ---------------------------------------------------------------------------
// adapter interface + real implementation
// ---------------------------------------------------------------------------

export interface LaunchSessionInput {
  readonly profile: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly title: string;
  readonly group: string;
  readonly model?: string;
  /** False attaches to an existing worktree/branch (steward relaunch). Default true. */
  readonly createBranch?: boolean;
}

/**
 * The operations Castra exposes over HTTP, decoupled from the transport. The
 * server takes an `AgentDeckAdapter` so tests can inject a fake; production uses
 * {@link createAgentDeckAdapter}.
 */
export interface AgentDeckAdapter {
  list(input: { profile: string; group?: string }): CastraSession[];
  launch(input: LaunchSessionInput): CastraSession;
  show(input: { profile: string; sessionId: string }): CastraSession;
  send(input: { profile: string; sessionId: string; prompt: string }): void;
  set(input: { profile: string; sessionId: string; key: string; value: string }): void;
  remove(input: {
    profile: string;
    sessionId: string;
    pruneWorktree: boolean;
  }): { removed: boolean };
  output(input: {
    profile: string;
    sessionId: string;
    lines?: number;
  }): { output: string; truncated: boolean };
  reachable(): boolean;
}

export function createAgentDeckAdapter(): AgentDeckAdapter {
  return {
    list({ profile, group }) {
      const sessions = listSnapshot(profile);
      return group ? sessions.filter((s) => s.group === group) : sessions;
    },

    launch(input) {
      const groupSessions = () =>
        listSnapshot(input.profile).filter((s) => s.group === input.group);
      const beforeIds = new Set(groupSessions().map((s) => s.sessionId));

      try {
        runAgentDeck(
          buildLaunchArgs({
            profile: input.profile,
            repoPath: input.repoPath,
            title: input.title,
            group: input.group,
            branch: input.branch,
            model: input.model,
            createBranch: input.createBranch,
          }),
          false,
        );
      } catch (err) {
        throw new CastraAgentDeckError(
          `agent-deck launch failed: ${(err as Error).message}`,
        );
      }

      const launched = pickLaunchedSession(groupSessions(), beforeIds, input.branch);
      if (!launched) {
        throw new CastraAgentDeckError(
          "agent-deck launch completed but the new session could not be identified from agent-deck list.",
        );
      }

      let worktreePath = launched.worktreePath;
      if (!worktreePath) {
        worktreePath = readWorktreePath(input.profile, launched.sessionId) ?? "";
      }
      if (!worktreePath) {
        throw new CastraAgentDeckError(
          `agent-deck session "${launched.sessionId}" did not report a worktree path.`,
        );
      }

      // Hard correctness check: the attached worktree MUST match the one
      // agent-deck derives for our --worktree <branch>. A mismatch means a
      // concurrent launch consumed our session before we identified it; surface
      // it as a conflict (HTTP 409) so the caller re-dispatches rather than
      // applying work to the wrong worktree.
      const expectedDirName = expectedWorktreeDirName(input.branch);
      if (path.basename(worktreePath) !== expectedDirName) {
        throw new CastraConflictError(
          `agent-deck session "${launched.sessionId}" attached to worktree ` +
            `"${worktreePath}" but branch "${input.branch}" should produce ` +
            `worktree dir "${expectedDirName}". Refusing to use the wrong worktree; ` +
            "re-dispatch once the colliding launch settles.",
        );
      }

      // Stewards need session-level auto-mode or the agent-deck classifier
      // pauses tool calls mid-workflow. Best-effort — a functional session
      // shouldn't fail the whole launch over this.
      try {
        runAgentDeck(
          buildSessionSetArgs(input.profile, launched.sessionId, "auto-mode", "true"),
          false,
        );
      } catch {
        // Swallow — see comment above.
      }

      return {
        sessionId: launched.sessionId,
        title: launched.title || input.title,
        group: launched.group || input.group,
        branch: launched.branch || input.branch,
        worktreePath,
        createdAt: launched.createdAt,
        status: launched.status,
      };
    },

    show({ profile, sessionId }) {
      const session = readSession(profile, sessionId);
      if (!session) {
        throw new CastraNotFoundError(`session "${sessionId}" not found.`);
      }
      return session;
    },

    send({ profile, sessionId, prompt }) {
      try {
        runAgentDeck(buildSessionSendArgs(profile, sessionId, prompt), false);
      } catch (err) {
        const stderr = (err as AgentDeckExecError).stderr ?? "";
        if (looksLikeNotFound(stderr)) {
          throw new CastraNotFoundError(`session "${sessionId}" not found.`);
        }
        throw new CastraAgentDeckError(
          `agent-deck session send failed: ${(err as Error).message}`,
        );
      }
    },

    set({ profile, sessionId, key, value }) {
      try {
        runAgentDeck(buildSessionSetArgs(profile, sessionId, key, value), false);
      } catch (err) {
        const stderr = (err as AgentDeckExecError).stderr ?? "";
        if (looksLikeNotFound(stderr)) {
          throw new CastraNotFoundError(`session "${sessionId}" not found.`);
        }
        throw new CastraAgentDeckError(
          `agent-deck session set failed: ${(err as Error).message}`,
        );
      }
    },

    remove({ profile, sessionId, pruneWorktree }) {
      try {
        runAgentDeck(buildSessionRemoveArgs(profile, sessionId, pruneWorktree), false);
        return { removed: true };
      } catch (err) {
        const stderr = (err as AgentDeckExecError).stderr ?? "";
        // Tolerant cleanup: a missing session is the desired end state, so
        // report removed:false rather than 404 — matches the loop's idempotent
        // teardown semantics.
        if (looksLikeNotFound(stderr)) {
          return { removed: false };
        }
        throw new CastraAgentDeckError(
          `agent-deck session remove failed: ${(err as Error).message}`,
        );
      }
    },

    output({ profile, sessionId, lines }) {
      let stdout: string;
      try {
        stdout = runAgentDeck(buildSessionOutputArgs(profile, sessionId), true);
      } catch (err) {
        const stderr = (err as AgentDeckExecError).stderr ?? "";
        if (looksLikeNotFound(stderr)) {
          throw new CastraNotFoundError(`session "${sessionId}" not found.`);
        }
        throw new CastraAgentDeckError(
          `agent-deck session output failed: ${(err as Error).message}`,
        );
      }
      if (lines && lines > 0) {
        const all = stdout.split("\n");
        if (all.length > lines) {
          return { output: all.slice(-lines).join("\n"), truncated: true };
        }
      }
      return { output: stdout, truncated: false };
    },

    reachable() {
      try {
        runAgentDeck(["--version"], true);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function readSession(profile: string, sessionId: string): CastraSession | undefined {
  let stdout: string;
  try {
    stdout = runAgentDeck(buildSessionShowArgs(profile, sessionId), true);
  } catch (err) {
    const stderr = (err as AgentDeckExecError).stderr ?? "";
    if (looksLikeNotFound(stderr)) return undefined;
    throw new CastraAgentDeckError(
      `agent-deck session show failed: ${(err as Error).message}`,
    );
  }
  const parsed = parseJsonMaybe(stdout.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parseAgentDeckSession(parsed as Record<string, unknown>) ?? undefined;
}

function readWorktreePath(profile: string, sessionId: string): string | undefined {
  return readSession(profile, sessionId)?.worktreePath || undefined;
}
