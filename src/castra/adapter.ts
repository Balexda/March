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
 * Derive the current branch of a session's working directory by reading its git
 * head (#264). Castra owns the agent-deck session enumeration and already knows
 * each session's `path`, so it is the right place to make the session record
 * self-describing: every downstream consumer (Herald observer, legate cleanup /
 * babysit / relaunch) reads `session.branch` without re-deriving it.
 *
 * Contract:
 *   - non-existent / non-git directory → `""`
 *   - detached HEAD (`branch --show-current` is empty) → `""` (never a bare SHA)
 *   - otherwise the trimmed branch name
 *
 * Any git failure (missing path, not a work tree, git absent) collapses to `""`
 * — an empty branch is always a valid, additive answer, never an error.
 */
export function deriveWorktreeBranch(worktreePath: string): string {
  if (!worktreePath) return "";
  let insideWorkTree: string;
  try {
    insideWorkTree = runGit([
      "-C",
      worktreePath,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
  } catch {
    return "";
  }
  if (insideWorkTree.trim() !== "true") return "";
  try {
    return runGit(["-C", worktreePath, "branch", "--show-current"]).trim();
  } catch {
    return "";
  }
}

/** Run `git <args>` capturing stdout. Throws on non-zero exit / spawn failure. */
function runGit(args: readonly string[]): string {
  const out = execFileSync("git", args as string[], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return typeof out === "string" ? out : "";
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

/**
 * Resolve the environment for spawned `agent-deck` processes.
 *
 * agent-deck derives a session's `status` by reaching the tmux server and
 * inspecting the live pane; it locates that server from `$TMUX`, whose first
 * comma-separated field is the socket path (see agent-deck's
 * `tmuxSocketFromEnv`). When the Castra service runs *inside* the tmux server
 * it manages, `$TMUX` is already set and inherited — we pass the environment
 * through untouched and the happy path is unchanged.
 *
 * But when Castra is started *outside* tmux — the #152 container-stack scenario,
 * or any plain/systemd service — `$TMUX` is absent. agent-deck then can't reach
 * the server (the status path keys off `$TMUX`, not `$TMUX_TMPDIR`), its
 * liveness derivation fails, and every live session is reported as
 * `status="error"` (issue #174). The legate loop's babysit treats that as a
 * worker error and escalates a healthy steward.
 *
 * To make Castra robust to its own launch context, when `$TMUX` is missing we
 * point agent-deck at the host's default tmux server socket
 * (`${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`) by synthesizing a `$TMUX` value.
 * That's the same socket agent-deck's own `launch` uses, so launches and status
 * queries consistently target the one shared server the host already runs its
 * sessions on. Only the socket field is read; the server-pid/session fields are
 * unused by socket resolution, so `0,0` is fine.
 */
export function resolveAgentDeckEnv(
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): NodeJS.ProcessEnv {
  if (env.TMUX && env.TMUX.trim()) return env;
  // No tmux server we can address (e.g. a platform without getuid) — leave the
  // environment alone rather than synthesize a socket we can't justify.
  if (uid === undefined) return env;
  const tmpdir = env.TMUX_TMPDIR?.trim() || "/tmp";
  const socket = `${tmpdir}/tmux-${uid}/default`;
  return { ...env, TMUX: `${socket},0,0` };
}

/** Run `agent-deck <args>` capturing stdout. Throws AgentDeckExecError on failure. */
function runAgentDeck(args: readonly string[], capture: boolean): string {
  try {
    const out = execFileSync("agent-deck", args as string[], {
      encoding: "utf-8",
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
      env: resolveAgentDeckEnv(process.env, process.getuid?.()),
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
  /** Queryable session metadata (e.g. `{ sliceId, spawnId }`) Castra stores and
   *  re-attaches on list/show (#214). agent-deck has no arbitrary-metadata store,
   *  so Castra keeps its own `sessionId → payload` map. */
  readonly metadata?: Record<string, string>;
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
  // Castra-owned session metadata + last-known branch, keyed by session id (#214).
  // agent-deck cannot store arbitrary metadata, so Castra populates this at launch
  // and re-attaches it on list/show. The branch is captured so a session whose
  // agent-deck snapshot reports an empty `branch` still surfaces the one it was
  // launched on (the stale-empty-branch symptom). In-memory: rebuilt on the next
  // launch after a Castra restart; the durable correlation lives in Herald's fold
  // via the #213 push, this is the self-healing pull-path backstop.
  const sessionMeta = new Map<string, { metadata?: Record<string, string>; branch?: string }>();

  // Per-session derived-branch cache (#264), keyed by session id. The working
  // directory's branch rarely changes mid-session, so we derive it once via git
  // and reuse the result for the session's lifetime. The cached `path` is part of
  // the validity check: a session restart yields a fresh id (cache miss), and a
  // path mutation under a reused id re-derives — so the cache never serves a hard
  // miss across a restart, only an at-most-one-tick-stale read mid-session.
  const branchCache = new Map<string, { path: string; branch: string }>();

  /**
   * Resolve a session's branch, deriving it from the working directory when
   * neither the agent-deck snapshot nor the launch-time record carries one (the
   * legacy-session case the #264 link gap depends on). Git is consulted at most
   * once per (session id, path) pair.
   */
  function resolveBranch(session: CastraSession, storedBranch?: string): string {
    const known = session.branch || storedBranch || "";
    if (known) return known;
    const path = session.worktreePath;
    if (!path) return "";
    const cached = branchCache.get(session.sessionId);
    if (cached && cached.path === path) return cached.branch;
    const branch = deriveWorktreeBranch(path);
    branchCache.set(session.sessionId, { path, branch });
    return branch;
  }

  /**
   * Re-attach stored metadata, backfill an empty branch from the launch record
   * (#214), and — for sessions with no recorded branch at all — derive it from
   * the working directory's git head (#264).
   */
  function enrich(session: CastraSession): CastraSession {
    const stored = sessionMeta.get(session.sessionId);
    const metadata = session.metadata ?? stored?.metadata;
    const branch = resolveBranch(session, stored?.branch);
    if (metadata === session.metadata && branch === session.branch) return session;
    return { ...session, branch, ...(metadata ? { metadata } : {}) };
  }

  return {
    list({ profile, group }) {
      const sessions = listSnapshot(profile).map(enrich);
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

      const branch = launched.branch || input.branch;
      // Record the correlation metadata + launch branch so subsequent list/show
      // can self-describe this session (#214).
      sessionMeta.set(launched.sessionId, {
        ...(input.metadata ? { metadata: input.metadata } : {}),
        branch,
      });
      return {
        sessionId: launched.sessionId,
        title: launched.title || input.title,
        group: launched.group || input.group,
        branch,
        worktreePath,
        createdAt: launched.createdAt,
        status: launched.status,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
    },

    show({ profile, sessionId }) {
      const session = readSession(profile, sessionId);
      if (!session) {
        throw new CastraNotFoundError(`session "${sessionId}" not found.`);
      }
      return enrich(session);
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
        sessionMeta.delete(sessionId);
        branchCache.delete(sessionId);
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
