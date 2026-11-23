import path from "node:path";
import {
  CastraAgentDeckError,
  CastraComposerRefusedError,
  CastraConflictError,
  CastraNotFoundError,
  CastraTmuxError,
  type CastraSession,
} from "./types.js";
import { CASTRA_DEFAULT_MODEL } from "./config.js";
import {
  recordStewardSession,
  stewardLaunchWrapper,
  stewardSettingsPath,
  stewardPluginDir,
} from "./steward-skills.js";
import { execCommand, KeyedSerializer, type ExecError, type ExecFn } from "./exec.js";
import { SendTracker, type RefusalEntry } from "./send-health.js";
import {
  parseTrustDialog,
  resolveTrustDialog,
  type ResolveTrustDialogOptions,
  type TrustDialogIo,
  type TrustDialogResolution,
} from "./trust-dialog.js";
import { recordTrustDialog } from "./metrics.js";

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

// Every child process Castra runs is async and bounded (see exec.ts): a wedged
// agent-deck/tmux/git is SIGKILLed at its timeout instead of hanging a request.
/** Default timeout for an agent-deck call (list/show/set/output/restart). */
export const AGENT_DECK_TIMEOUT_MS = 60_000;
/** `agent-deck launch` creates a worktree and a tmux session; give it longer. */
export const AGENT_DECK_LAUNCH_TIMEOUT_MS = 180_000;
/** `agent-deck session send`. Under the legate client's 60s request timeout, so
 *  the caller gets Castra's error instead of its own timeout. */
export const AGENT_DECK_SEND_TIMEOUT_MS = 45_000;
/** `agent-deck session remove --prune-worktree` removes a git worktree. */
export const AGENT_DECK_REMOVE_TIMEOUT_MS = 120_000;
/** The `/status` reachability probe (`agent-deck --version`). */
export const AGENT_DECK_PROBE_TIMEOUT_MS = 10_000;
/** git branch derivation and tmux pane capture/keys are local and fast. */
export const GIT_TIMEOUT_MS = 10_000;
export const TMUX_TIMEOUT_MS = 10_000;

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
    "--wrapper",
    stewardLaunchWrapper(),
    "--extra-arg",
    "--permission-mode",
    "--extra-arg",
    "auto",
    "--extra-arg",
    "--model",
    "--extra-arg",
    input.model?.trim() || CASTRA_DEFAULT_MODEL,
    // Load the shared steward skills (e.g. steward-pr) as a session-only
    // plugin without relocating the host ~/.claude config, so the operator's
    // credentials stay. Not --add-dir: since Claude Code 2.1.326 that raises a
    // directory-trust dialog in the idle steward's composer, and agent-deck
    // then refuses the manager-prompt send (#608). Provisioned at Castra serve
    // start (see steward-skills.ts).
    "--extra-arg",
    "--plugin-dir",
    "--extra-arg",
    stewardPluginDir(),
    // Load the steward self-report settings (#371): the Notification/Stop hook
    // that POSTs the steward's state to Herald. Provisioned alongside the skills.
    "--extra-arg",
    "--settings",
    "--extra-arg",
    stewardSettingsPath(),
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

/**
 * Restart a session's tmux process (#castra-recover). `--force` bypasses
 * agent-deck's issue-#30 freshness guard so a session that errored on a host
 * reboot is restarted even if its `LastStartedAt` looks recent. For a Claude
 * session with a stored `claude_session_id` this re-spawns as `claude --resume
 * <uuid>`, which is what surfaces the "Resume from summary" startup picker the
 * recovery sweep resolves.
 */
export function buildSessionRestartArgs(
  profile: string,
  sessionId: string,
  force = true,
): string[] {
  return ["-p", profile, "session", "restart", sessionId, ...(force ? ["--force"] : [])];
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

/**
 * Does this `list --json` stdout signal an EMPTY profile rather than malformed
 * output? agent-deck does not print `[]` for a profile with no sessions — it
 * prints a human `No sessions found in profile 'X'.` line (and could print
 * nothing). An empty profile is a normal state (a reaped/idle repo), so the list
 * adapters treat this as `[]` instead of throwing — a hard error here 502s the
 * GET /v1/sessions the legate calls every tick per profile, which drove the
 * castra error-rate alarm the moment any profile went empty.
 */
function isEmptyProfileListing(trimmedStdout: string): boolean {
  return trimmedStdout === "" || /^no sessions found\b/i.test(trimmedStdout);
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
export async function deriveWorktreeBranch(
  worktreePath: string,
  exec: ExecFn = execCommand,
): Promise<string> {
  if (!worktreePath) return "";
  let insideWorkTree: string;
  try {
    insideWorkTree = await runGit(exec, [
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
    return (await runGit(exec, ["-C", worktreePath, "branch", "--show-current"])).trim();
  } catch {
    return "";
  }
}

/** Run `git <args>` capturing stdout. Rejects on non-zero exit / spawn failure / timeout. */
async function runGit(exec: ExecFn, args: readonly string[]): Promise<string> {
  const out = await exec("git", args, { capture: true, timeoutMs: GIT_TIMEOUT_MS });
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

/** Run `agent-deck <args>` capturing stdout. Rejects with AgentDeckExecError on failure. */
async function runAgentDeck(
  exec: ExecFn,
  args: readonly string[],
  capture: boolean,
  timeoutMs: number = AGENT_DECK_TIMEOUT_MS,
): Promise<string> {
  try {
    const out = await exec("agent-deck", args, {
      capture,
      timeoutMs,
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

/** Run `tmux <args>` against the same server socket agent-deck addresses. */
async function runTmux(exec: ExecFn, args: readonly string[]): Promise<string> {
  const out = await exec("tmux", args, {
    capture: true,
    timeoutMs: TMUX_TIMEOUT_MS,
    env: resolveAgentDeckEnv(process.env, process.getuid?.()),
  });
  return typeof out === "string" ? out : "";
}

/** agent-deck's safe refusal: it read the pane, judged the Claude composer not
 *  empty, and typed nothing. */
export function looksLikeComposerRefusal(stderr: string): boolean {
  return /composer is occupied or unreadable/i.test(stderr);
}

/** Lines of pane tail attached to a refused send. */
const REFUSED_SEND_PANE_LINES = 15;

/**
 * Keep the last `maxLines` non-blank lines of a pane capture, dropping
 * full-width rule lines (box-drawing only) that carry no information.
 */
export function paneTail(pane: string, maxLines: number): string {
  const lines = pane
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !/^[\s─-╿]+$/.test(l));
  return lines.slice(-maxLines).join("\n");
}

/** Heuristic: does this stderr indicate the session simply doesn't exist? */
function looksLikeNotFound(stderr: string): boolean {
  return /not found|no such|does not exist|no session|unknown session/i.test(stderr);
}

function parseSessionList(stdout: string): Record<string, unknown>[] {
  const parsed = parseJsonMaybe(stdout);
  if (!Array.isArray(parsed)) {
    if (isEmptyProfileListing(stdout)) return [];
    throw new CastraAgentDeckError("agent-deck list --json returned unexpected output.");
  }
  return parsed.filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value),
  );
}

async function listSnapshot(exec: ExecFn, profile: string): Promise<CastraSession[]> {
  const stdout = (await runAgentDeck(exec, buildListArgs(profile), true)).trim();
  return parseSessionList(stdout)
    .map((record) => parseAgentDeckSession(record))
    .filter((session): session is CastraSession => session !== null);
}

/** `agent-deck session show --json` as a record; undefined when the session is absent. */
async function showRecord(
  exec: ExecFn,
  profile: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  let stdout: string;
  try {
    stdout = await runAgentDeck(exec, buildSessionShowArgs(profile, sessionId), true);
  } catch (err) {
    const stderr = (err as AgentDeckExecError).stderr ?? "";
    if (looksLikeNotFound(stderr)) return undefined;
    throw new CastraAgentDeckError(
      `agent-deck session show failed: ${(err as Error).message}`,
    );
  }
  const parsed = parseJsonMaybe(stdout.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

async function readSession(
  exec: ExecFn,
  profile: string,
  sessionId: string,
): Promise<CastraSession | undefined> {
  const record = await showRecord(exec, profile, sessionId);
  return record ? (parseAgentDeckSession(record) ?? undefined) : undefined;
}

async function readWorktreePath(
  exec: ExecFn,
  profile: string,
  sessionId: string,
): Promise<string | undefined> {
  return (await readSession(exec, profile, sessionId))?.worktreePath || undefined;
}

/** A pino/Fastify-compatible logger: the adapter logs trust-dialog handling. */
export interface CastraLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Build the pane IO the trust-dialog resolver needs for one tmux session. */
function tmuxTrustIo(
  exec: ExecFn,
  tmuxSession: string,
  sleep: (ms: number) => Promise<void>,
): TrustDialogIo {
  return {
    async capture() {
      try {
        return await runTmux(exec, ["capture-pane", "-p", "-t", tmuxSession]);
      } catch {
        return "";
      }
    },
    async sendKey(key) {
      try {
        await runTmux(exec, ["send-keys", "-t", tmuxSession, key]);
      } catch {
        // Best-effort: the resolver re-reads the pane after every key.
      }
    },
    sleep,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export interface SendSessionInput {
  readonly profile: string;
  readonly sessionId: string;
  readonly prompt: string;
  /** Trace key for spans the send emits (the caller's slice id when it set one). */
  readonly traceKey?: string;
  readonly sliceId?: string;
}

/**
 * The operations Castra exposes over HTTP, decoupled from the transport. The
 * server takes an `AgentDeckAdapter` so tests can inject a fake; production uses
 * {@link createAgentDeckAdapter}. Every operation is async: Castra never runs a
 * child process synchronously on its request path.
 */
export interface AgentDeckAdapter {
  list(input: { profile: string; group?: string }): Promise<CastraSession[]>;
  launch(input: LaunchSessionInput): Promise<CastraSession>;
  show(input: { profile: string; sessionId: string }): Promise<CastraSession>;
  send(input: SendSessionInput): Promise<void>;
  set(input: { profile: string; sessionId: string; key: string; value: string }): Promise<void>;
  remove(input: {
    profile: string;
    sessionId: string;
    pruneWorktree: boolean;
  }): Promise<{ removed: boolean }>;
  output(input: {
    profile: string;
    sessionId: string;
    lines?: number;
  }): Promise<{ output: string; truncated: boolean }>;
  reachable(): Promise<boolean>;
}

export interface AgentDeckAdapterOptions {
  /** Child-process runner; defaults to the real async {@link execCommand}. */
  readonly exec?: ExecFn;
  /** Refusal cooldowns; share the server's tracker so `/readyz` sees them. */
  readonly sendTracker?: SendTracker;
  readonly logger?: CastraLog;
  /** Sleep between trust-dialog keys; tests inject an instant one. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly trustDialog?: ResolveTrustDialogOptions;
}

export function createAgentDeckAdapter(options: AgentDeckAdapterOptions = {}): AgentDeckAdapter {
  const exec = options.exec ?? execCommand;
  const tracker = options.sendTracker ?? new SendTracker();
  const logger = options.logger;
  const sleep = options.sleep ?? defaultSleep;
  // Sends to one session run one at a time so two prompts are never typed into
  // the same composer together; different sessions send concurrently.
  const sendQueue = new KeyedSerializer();

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
  // miss across a restart. A branch change *within* one (id, path) — rare, since
  // agent-deck pins a steward to its worktree — is deliberately not observed: the
  // cached value is held until the id or path changes (or `remove` clears it), not
  // re-checked each tick. Serving the first-seen branch for the session's lifetime
  // is the accepted tradeoff for not shelling git on every list.
  const branchCache = new Map<string, { path: string; branch: string }>();

  /**
   * Resolve a session's branch, deriving it from the working directory when
   * neither the agent-deck snapshot nor the launch-time record carries one (the
   * legacy-session case the #264 link gap depends on). Git is consulted at most
   * once per (session id, path) pair.
   */
  async function resolveBranch(session: CastraSession, storedBranch?: string): Promise<string> {
    const known = session.branch || storedBranch || "";
    if (known) return known;
    const path = session.worktreePath;
    if (!path) return "";
    const cached = branchCache.get(session.sessionId);
    if (cached && cached.path === path) return cached.branch;
    const branch = await deriveWorktreeBranch(path, exec);
    branchCache.set(session.sessionId, { path, branch });
    return branch;
  }

  /**
   * Re-attach stored metadata, backfill an empty branch from the launch record
   * (#214), and — for sessions with no recorded branch at all — derive it from
   * the working directory's git head (#264).
   */
  async function enrich(session: CastraSession): Promise<CastraSession> {
    const stored = sessionMeta.get(session.sessionId);
    const metadata = session.metadata ?? stored?.metadata;
    const branch = await resolveBranch(session, stored?.branch);
    if (metadata === session.metadata && branch === session.branch) return session;
    return { ...session, branch, ...(metadata ? { metadata } : {}) };
  }

  /** The session's tmux session name and visible pane. Best-effort: never throws. */
  async function paneSnapshot(
    profile: string,
    sessionId: string,
  ): Promise<{ tmuxSession?: string; pane: string }> {
    try {
      const shown = await showRecord(exec, profile, sessionId);
      const tmuxSession = shown ? firstString(shown, ["tmux_session", "tmuxSession"]) : undefined;
      if (!tmuxSession) return { pane: "" };
      return { tmuxSession, pane: await runTmux(exec, ["capture-pane", "-p", "-t", tmuxSession]) };
    } catch {
      return { pane: "" };
    }
  }

  /** Has the refused session's pane changed since its refusal? Unreadable = unchanged. */
  async function paneChanged(entry: RefusalEntry): Promise<boolean> {
    if (!entry.tmuxSession || !entry.paneTail) return false;
    let pane: string;
    try {
      pane = await runTmux(exec, ["capture-pane", "-p", "-t", entry.tmuxSession]);
    } catch {
      return false;
    }
    const tail = paneTail(pane, REFUSED_SEND_PANE_LINES);
    return tail !== "" && tail !== entry.paneTail;
  }

  /** Answer a Castra-owned trust dialog on `tmuxSession`; emit its span + log. */
  async function handleTrustDialog(
    input: SendSessionInput,
    tmuxSession: string,
  ): Promise<TrustDialogResolution> {
    const resolution = await resolveTrustDialog(
      tmuxTrustIo(exec, tmuxSession, sleep),
      options.trustDialog,
    );
    if (resolution.outcome === "not_shown") return resolution;
    const fields = {
      "castra.op": "trust_dialog",
      "march.profile": input.profile,
      "castra.session_id": input.sessionId,
      "castra.trust_trigger": "send_refusal",
      "castra.trust_outcome": resolution.outcome,
      "castra.trust_dir": resolution.dir ?? "",
      ...(resolution.detail ? { "castra.trust_detail": resolution.detail } : {}),
      ...(input.sliceId ? { "march.slice_id": input.sliceId } : {}),
    };
    const span = recordTrustDialog({
      traceKey: input.traceKey ?? `castra-trust-${input.sessionId}`,
      profile: input.profile,
      sessionId: input.sessionId,
      trigger: "send_refusal",
      outcome: resolution.outcome,
      dir: resolution.dir ?? "",
      ...(resolution.detail ? { detail: resolution.detail } : {}),
      ...(input.sliceId ? { sliceId: input.sliceId } : {}),
    });
    const traceFields = span ? { trace_id: span.traceId, span_id: span.spanId } : {};
    if (resolution.outcome === "resolved") {
      logger?.info({ ...fields, ...traceFields }, "castra answered the steward directory-trust dialog");
    } else {
      logger?.warn({ ...fields, ...traceFields }, "castra left a directory-trust dialog unanswered");
    }
    return resolution;
  }

  function trustNote(resolution: TrustDialogResolution | undefined, retried: boolean): string {
    if (!resolution || resolution.outcome === "not_shown") return "";
    if (resolution.outcome === "not_owned") {
      return (
        `\nCastra left the directory-trust dialog for ${resolution.dir} unanswered: ` +
        "it is not Castra's steward directory. Answer it in the session."
      );
    }
    if (resolution.outcome === "failed") {
      return (
        `\nCastra could not answer the directory-trust dialog for ${resolution.dir}: ` +
        `${resolution.detail ?? "unknown"}.`
      );
    }
    return retried
      ? `\nCastra answered the directory-trust dialog for ${resolution.dir}, but the retried send was refused too.`
      : "";
  }

  /** A non-refusal send failure, mapped exactly as before. */
  function sendFailure(sessionId: string, err: unknown): Error {
    const stderr = (err as AgentDeckExecError).stderr ?? "";
    if (looksLikeNotFound(stderr)) {
      return new CastraNotFoundError(`session "${sessionId}" not found.`);
    }
    return new CastraAgentDeckError(`agent-deck session send failed: ${(err as Error).message}`);
  }

  /**
   * agent-deck refused the send. Capture the pane tail for the error (#608: a
   * trust dialog sat in the composer and took days to find). If the pane shows
   * the directory-trust dialog for Castra's own steward directory, answer it and
   * retry the send once. Otherwise start the session's refusal cooldown and
   * throw `composer_refused`.
   */
  async function handleRefusal(
    input: SendSessionInput,
    message: string,
    allowRetry: boolean,
  ): Promise<void> {
    const { profile, sessionId } = input;
    const snap = await paneSnapshot(profile, sessionId);
    let resolution: TrustDialogResolution | undefined;
    if (snap.tmuxSession && parseTrustDialog(snap.pane)) {
      resolution = await handleTrustDialog(input, snap.tmuxSession);
      if (resolution.outcome === "resolved" && allowRetry) {
        try {
          await runAgentDeck(
            exec,
            buildSessionSendArgs(profile, sessionId, input.prompt),
            false,
            AGENT_DECK_SEND_TIMEOUT_MS,
          );
          tracker.clearRefusal(profile, sessionId);
          return;
        } catch (err) {
          const stderr = (err as AgentDeckExecError).stderr ?? "";
          if (!looksLikeComposerRefusal(stderr)) throw sendFailure(sessionId, err);
          return handleRefusal(input, (err as Error).message, false);
        }
      }
    }
    const tail = paneTail(snap.pane, REFUSED_SEND_PANE_LINES);
    const full =
      `agent-deck session send failed: ${message}` +
      (tail ? `\nSteward pane at refusal (last lines):\n${tail}` : "") +
      trustNote(resolution, !allowRetry);
    tracker.recordRefusal({
      profile,
      sessionId,
      message: full,
      ...(snap.tmuxSession ? { tmuxSession: snap.tmuxSession } : {}),
      ...(tail ? { paneTail: tail } : {}),
    });
    throw new CastraComposerRefusedError(full);
  }

  async function sendNow(input: SendSessionInput): Promise<void> {
    const { profile, sessionId, prompt } = input;
    // Fail fast on a session that refused recently, unless its pane has changed.
    const refusal = tracker.activeRefusal(profile, sessionId);
    if (refusal) {
      if (!(await paneChanged(refusal))) {
        const remainingMs = tracker.remainingMs(refusal);
        const agoS = Math.round((tracker.cooldownMs - remainingMs) / 1000);
        const leftS = Math.ceil(remainingMs / 1000);
        throw new CastraComposerRefusedError(
          `agent-deck session send refused without retrying (composer_refused cooldown): ` +
            `session "${sessionId}" refused a send ${agoS}s ago and its pane has not changed; ` +
            `Castra fails fast for ${leftS}s more.\nLast refusal: ${refusal.message}`,
          true,
        );
      }
      tracker.clearRefusal(profile, sessionId);
    }
    try {
      await runAgentDeck(
        exec,
        buildSessionSendArgs(profile, sessionId, prompt),
        false,
        AGENT_DECK_SEND_TIMEOUT_MS,
      );
    } catch (err) {
      const stderr = (err as AgentDeckExecError).stderr ?? "";
      if (!looksLikeComposerRefusal(stderr)) throw sendFailure(sessionId, err);
      return handleRefusal(input, (err as Error).message, true);
    }
  }

  return {
    async list({ profile, group }) {
      const sessions = await Promise.all((await listSnapshot(exec, profile)).map(enrich));
      return group ? sessions.filter((s) => s.group === group) : sessions;
    },

    async launch(input) {
      const groupSessions = async () =>
        (await listSnapshot(exec, input.profile)).filter((s) => s.group === input.group);
      const beforeIds = new Set((await groupSessions()).map((s) => s.sessionId));

      try {
        await runAgentDeck(
          exec,
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
          AGENT_DECK_LAUNCH_TIMEOUT_MS,
        );
      } catch (err) {
        throw new CastraAgentDeckError(
          `agent-deck launch failed: ${(err as Error).message}`,
        );
      }

      const launched = pickLaunchedSession(await groupSessions(), beforeIds, input.branch);
      if (!launched) {
        throw new CastraAgentDeckError(
          "agent-deck launch completed but the new session could not be identified from agent-deck list.",
        );
      }

      let worktreePath = launched.worktreePath;
      if (!worktreePath) {
        worktreePath = (await readWorktreePath(exec, input.profile, launched.sessionId)) ?? "";
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

      // Record the launch-time context the steward self-report hook echoes back
      // (#371): keyed by this worktree, it carries the slice id / profile /
      // Herald URL the hook needs to POST a report. Best-effort (no-op without a
      // sliceId) and must not fail the launch — see recordStewardSession.
      recordStewardSession({
        worktreePath,
        profile: input.profile,
        sliceId: input.metadata?.sliceId,
      });

      // Stewards need session-level auto-mode or the agent-deck classifier
      // pauses tool calls mid-workflow. Best-effort — a functional session
      // shouldn't fail the whole launch over this.
      try {
        await runAgentDeck(
          exec,
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

    async show({ profile, sessionId }) {
      const session = await readSession(exec, profile, sessionId);
      if (!session) {
        throw new CastraNotFoundError(`session "${sessionId}" not found.`);
      }
      return enrich(session);
    },

    send(input) {
      return sendQueue.run(`${input.profile}\u0000${input.sessionId}`, () => sendNow(input));
    },

    async set({ profile, sessionId, key, value }) {
      try {
        await runAgentDeck(exec, buildSessionSetArgs(profile, sessionId, key, value), false);
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

    async remove({ profile, sessionId, pruneWorktree }) {
      try {
        await runAgentDeck(
          exec,
          buildSessionRemoveArgs(profile, sessionId, pruneWorktree),
          false,
          AGENT_DECK_REMOVE_TIMEOUT_MS,
        );
        sessionMeta.delete(sessionId);
        branchCache.delete(sessionId);
        tracker.clearRefusal(profile, sessionId);
        return { removed: true };
      } catch (err) {
        const stderr = (err as AgentDeckExecError).stderr ?? "";
        // Tolerant cleanup: a missing session is the desired end state, so
        // report removed:false rather than 404 — matches the loop's idempotent
        // teardown semantics.
        if (looksLikeNotFound(stderr)) {
          tracker.clearRefusal(profile, sessionId);
          return { removed: false };
        }
        throw new CastraAgentDeckError(
          `agent-deck session remove failed: ${(err as Error).message}`,
        );
      }
    },

    async output({ profile, sessionId, lines }) {
      let stdout: string;
      try {
        stdout = await runAgentDeck(exec, buildSessionOutputArgs(profile, sessionId), true);
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

    async reachable() {
      try {
        await runAgentDeck(exec, ["--version"], true, AGENT_DECK_PROBE_TIMEOUT_MS);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// recovery runtime (#castra-recover)
// ---------------------------------------------------------------------------

/**
 * The narrowed session view the recovery sweep needs. Unlike {@link
 * CastraSession} this carries the live `tmuxSession` name — the recovery path
 * targets `tmux capture-pane`/`send-keys` at it to detect and resolve Claude's
 * "Resume from summary" startup picker, and the name is regenerated on every
 * restart so it must be re-read after restarting.
 */
export interface RecoverySessionView {
  readonly sessionId: string;
  readonly title: string;
  readonly group: string;
  readonly status: string;
  readonly tmuxSession: string;
}

function parseRecoveryView(record: Record<string, unknown>): RecoverySessionView | null {
  const sessionId = firstString(record, ["id", "session_id", "sessionId"]);
  if (!sessionId) return null;
  return {
    sessionId,
    title: firstString(record, ["title", "name"]) ?? "",
    group: firstString(record, ["group"]) ?? "",
    status: firstString(record, ["status"]) ?? "",
    tmuxSession: firstString(record, ["tmux_session", "tmuxSession"]) ?? "",
  };
}

/**
 * The agent-deck + tmux operations the recovery sweep ({@link
 * recoverErrorSessions}) drives, decoupled from the transport so tests inject a
 * fake. Production uses {@link createAgentDeckRecoveryRuntime}; the pane
 * capture/send-keys go through tmux directly (not agent-deck) because the CLI's
 * `session restart` skips agent-deck's own resume-picker auto-confirm on the
 * resume branch — Castra answers the picker itself.
 */
export interface RecoveryRuntime {
  listSessions(profile: string): Promise<RecoverySessionView[]>;
  restart(profile: string, sessionId: string): Promise<void>;
  readSession(profile: string, sessionId: string): Promise<RecoverySessionView | undefined>;
  /** Visible pane text, or `""` when the pane can't be read (gone/not ready). */
  capturePane(tmuxSession: string): Promise<string>;
  /** Best-effort single Enter keypress — confirms the preselected picker option. */
  sendEnter(tmuxSession: string): Promise<void>;
  /** Best-effort single tmux key (`Down`, `Up`, `Enter`) — drives the trust dialog. */
  sendKey(tmuxSession: string, key: string): Promise<void>;
}

/** Timeout for the live tmux inventory read (#705). */
const TMUX_INVENTORY_TIMEOUT_MS = 3_000;

/**
 * Live inventory on Castra's tmux server. Async like every other Castra child
 * process, so a slow tmux never blocks the event loop.
 */
export async function listInteractiveSessions(exec: ExecFn = execCommand): Promise<string[]> {
  const prefix = "march/";
  let stdout: string;
  try {
    stdout = await exec("tmux", ["list-sessions", "-F", "#{session_name}"], {
      capture: true,
      timeoutMs: TMUX_INVENTORY_TIMEOUT_MS,
      env: resolveAgentDeckEnv({ ...process.env, LC_ALL: "C" }, process.getuid?.()),
    });
  } catch (err) {
    const failure = err as ExecError;
    const detail = failure.stderr?.trim();
    // A refused connection or missing socket means no server. A spawn
    // ENOENT means the executable itself is missing.
    if (
      failure.exitCode === 1 &&
      detail &&
      (/^no server running on .+$/.test(detail) ||
        /^error connecting to .+ \(No such file or directory\)$/.test(detail) ||
        detail === "no sessions")
    ) {
      return [];
    }
    if (failure.code === "ENOENT") {
      throw new CastraTmuxError("tmux executable was not found on Castra's PATH.");
    }
    if (failure.timedOut) {
      throw new CastraTmuxError("tmux session inventory timed out.");
    }
    throw new CastraTmuxError("tmux session inventory failed: " + (detail || failure.message));
  }
  return (typeof stdout === "string" ? stdout : "")
    .split("\n")
    .filter((name) => name.startsWith(prefix) && name.length > prefix.length)
    .map((name) => name.slice(prefix.length));
}

export function createAgentDeckRecoveryRuntime(
  options: { readonly exec?: ExecFn } = {},
): RecoveryRuntime {
  const exec = options.exec ?? execCommand;
  const sendKey = async (tmuxSession: string, key: string): Promise<void> => {
    if (!tmuxSession) return;
    try {
      await runTmux(exec, ["send-keys", "-t", tmuxSession, key]);
    } catch {
      // Best-effort: a missing pane simply means there is nothing to confirm.
    }
  };
  return {
    async listSessions(profile) {
      const stdout = (await runAgentDeck(exec, buildListArgs(profile), true)).trim();
      return parseSessionList(stdout)
        .map((record) => parseRecoveryView(record))
        .filter((view): view is RecoverySessionView => view !== null);
    },

    async restart(profile, sessionId) {
      try {
        await runAgentDeck(exec, buildSessionRestartArgs(profile, sessionId, true), false);
      } catch (err) {
        const stderr = (err as AgentDeckExecError).stderr ?? "";
        if (looksLikeNotFound(stderr)) {
          throw new CastraNotFoundError(`session "${sessionId}" not found.`);
        }
        throw new CastraAgentDeckError(
          `agent-deck session restart failed: ${(err as Error).message}`,
        );
      }
    },

    async readSession(profile, sessionId) {
      const record = await showRecord(exec, profile, sessionId);
      return record ? (parseRecoveryView(record) ?? undefined) : undefined;
    },

    async capturePane(tmuxSession) {
      if (!tmuxSession) return "";
      try {
        return await runTmux(exec, ["capture-pane", "-p", "-t", tmuxSession]);
      } catch {
        // Pane gone or not yet ready — an empty read is a valid "no picker".
        return "";
      }
    },

    sendEnter(tmuxSession) {
      return sendKey(tmuxSession, "Enter");
    },

    sendKey,
  };
}
