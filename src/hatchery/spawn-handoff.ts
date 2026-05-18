import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  missingCredentialMounts,
  missingRequiredEnvVars,
  type SpawnBackend,
} from "../spawn/backends.js";
import {
  copyPromptToContainer,
  createSpawnContainer,
  LaunchError,
  readSpawnContainerLogs,
  removeSpawnContainer,
  startSpawnContainer,
  waitForSpawnContainer,
} from "../spawn/container-launch.js";
import { createBuildContext, SnapshotError } from "../spawn/snapshot.js";
import {
  buildSpawnImage,
  BuildError,
  removeSpawnImage,
  writeSpawnDockerfile,
} from "../spawn/snapshot-build.js";
import { generateSpawnId } from "../brood/worktree.js";
import {
  markSpawnRecordFailed,
  markSpawnRecordRunning,
  markSpawnRecordStopped,
  SpawnRecordError,
  updateSpawnRecordImageId,
  updateSpawnRecordPrompt,
  writeInitialSpawnRecord,
} from "../brood/spawn-record.js";

export class HatcherySpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatcherySpawnError";
  }
}

export interface HatcherySpawnOptions {
  readonly repoPath: string;
  readonly prompt: string;
  readonly backend: SpawnBackend;
  readonly agentDeckProfile?: string;
  readonly managerGroup?: string;
  readonly title?: string;
  readonly branch?: string;
  readonly homeDir?: string;
}

export interface AgentDeckManagerSession {
  readonly sessionId: string;
  readonly title: string;
  readonly group: string;
  readonly branch: string;
  readonly worktreePath: string;
}

export interface HatcherySpawnArtifacts {
  readonly dir: string;
  readonly spawnOutputPath: string;
  readonly patchPath: string;
  readonly managerPromptPath: string;
  readonly metadataPath: string;
}

export interface HatcherySpawnResult {
  readonly spawnId: string;
  readonly backend: string;
  readonly branch: string;
  readonly managerSession: AgentDeckManagerSession;
  readonly artifacts: HatcherySpawnArtifacts;
  readonly exitCode: number;
  readonly summary: string;
}

export const DEFAULT_MANAGER_GROUP = "march-spawn-managers";
export const DEFAULT_MANAGER_MODEL = "sonnet";

const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

export function hatcherySpawnLogDir(
  spawnId: string,
  homeDir: string = os.homedir(),
): string {
  return path.join(homeDir, ".march", "logs", "hatchery-spawns", spawnId);
}

export function managerBranchName(spawnId: string): string {
  return `march/spawn/${spawnId}`;
}

export function buildSpawnPatchPrompt(operatorPrompt: string): string {
  return [
    "Operator request:",
    operatorPrompt.trimEnd(),
    "",
    "Hatchery instructions:",
    "- Complete only the operator request above.",
    "- When the change is complete, emit the full result as a git patch.",
    "- The patch must be applicable from the repository root with `git apply --index`.",
    "- Prefer a standard unified git diff beginning with `diff --git`.",
  ].join("\n");
}

export function extractPatchFromSpawnOutput(output: string): string {
  const jsonPatch = extractPatchFromJsonOutput(output);
  if (jsonPatch) return jsonPatch;

  const markerIndex = output.indexOf("diff --git ");
  if (markerIndex >= 0) {
    return normalizeTrailingNewline(output.slice(markerIndex));
  }

  throw new HatcherySpawnError(
    "Spawn completed but no git patch was found in its output. Expected a JSON/JSONL `patch` field or raw output beginning with `diff --git`.",
  );
}

// Strip only trailing newlines, then add exactly one. Unlike trimEnd(), this
// preserves trailing whitespace-only context lines (e.g., " \n") that are part
// of the hunk content — stripping them changes the hunk's line count and makes
// `git apply` reject the patch as corrupt.
function normalizeTrailingNewline(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x0a) end--;
  return text.slice(0, end) + "\n";
}

function extractPatchFromJsonOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const whole = parseJsonMaybe(trimmed);
  const wholePatch = patchFromJsonValue(whole, { scanStrings: false });
  if (wholePatch) return wholePatch;

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const parsed = parseJsonMaybe(line.trim());
    const patch = patchFromJsonValue(parsed, { scanStrings: true });
    if (patch) return patch;
  }

  return null;
}

function parseJsonMaybe(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function patchFromJsonValue(
  value: unknown,
  options: { readonly scanStrings: boolean },
): string | null {
  if (typeof value === "string") {
    return options.scanStrings ? patchFromText(value) : null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value.slice().reverse()) {
      const patch = patchFromJsonValue(item, options);
      if (patch) return patch;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["patch", "diff", "git_patch", "gitPatch"]) {
    const raw = record[key];
    if (typeof raw === "string") {
      const patch = patchFromText(raw);
      if (patch) return patch;
    }
  }

  for (const key of [
    "result",
    "output",
    "message",
    "data",
    "item",
    "text",
    "aggregated_output",
    "content",
  ]) {
    const patch = patchFromJsonValue(record[key], options);
    if (patch) return patch;
  }

  return null;
}

function patchFromText(text: string): string | null {
  // Require the closing fence to be at line start, optionally indented with
  // spaces or tabs (CommonMark allows up to 3 spaces of indentation on the
  // closing fence). Inner ```ts / ```diff fences embedded as added patch
  // lines are prefixed by `+` (or `-`/space-then-content for context), so
  // they fail this anchor and don't terminate the match. Only the outer
  // closing fence on its own line matches.
  const fenced = text.match(
    /```(?:diff|patch)?[^\n]*\n([\s\S]*?diff --git [\s\S]*?)\n[ \t]*```[ \t]*(?:\r?\n|\r|$)/,
  );
  if (fenced?.[1]) return normalizeTrailingNewline(fenced[1]);

  const markerIndex = text.indexOf("diff --git ");
  if (markerIndex >= 0) return normalizeTrailingNewline(text.slice(markerIndex));

  return null;
}

export function buildManagerPrompt(input: {
  readonly operatorPrompt: string;
  readonly patchPath?: string;
  readonly spawnOutputPath?: string;
  readonly metadataPath?: string;
}): string {
  return [
    "You are the March Hatchery management session for a completed spawn.",
    "",
    "Review the already-applied staged change, then open a PR.",
    "",
    `Original request:\n${input.operatorPrompt.trimEnd()}`,
    "",
    "Required workflow:",
    "1. Inspect `git status --short` and the staged diff.",
    "2. Review the resulting diff for correctness and security.",
    "3. Run the smallest meaningful verification for the touched code.",
    "4. Commit the applied change, push the branch, and open a GitHub PR.",
    "5. Report the PR URL and any verification gaps.",
  ].join("\n");
}

export function createHatcherySpawnArtifacts(input: {
  readonly spawnId: string;
  readonly homeDir?: string;
  readonly spawnOutput: string;
  readonly patch: string;
  readonly managerPrompt: string;
  readonly metadata: Record<string, unknown>;
}): HatcherySpawnArtifacts {
  const dir = hatcherySpawnLogDir(input.spawnId, input.homeDir);
  fs.mkdirSync(dir, { recursive: true });

  const spawnOutputPath = path.join(dir, "spawn-output.log");
  const patchPath = path.join(dir, "patch.diff");
  const managerPromptPath = path.join(dir, "manager-prompt.md");
  const metadataPath = path.join(dir, "metadata.json");

  fs.writeFileSync(spawnOutputPath, input.spawnOutput, "utf-8");
  fs.writeFileSync(patchPath, input.patch, "utf-8");
  fs.writeFileSync(managerPromptPath, input.managerPrompt, "utf-8");
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        ...input.metadata,
        artifacts: {
          dir,
          spawnOutputPath,
          patchPath,
          managerPromptPath,
          metadataPath,
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  return { dir, spawnOutputPath, patchPath, managerPromptPath, metadataPath };
}

/**
 * Pick the session created by a single `agent-deck launch` call out of
 * the post-launch session list. Diff-since-snapshot alone is unsafe when
 * multiple launches race in the same tick — each runner sees the same
 * `beforeIds` snapshot and the same post-launch list, and a naive
 * "newest not in snapshot" pick converges on whichever session sorted
 * latest by createdAt. Every concurrent spawn would then attach to the
 * same session, and the losers would fail downstream when the wrong
 * (or nonexistent) worktree gets used as a cwd.
 *
 * Filter by the launched session's `worktreePath` — the only per-launch
 * identifier agent-deck reliably surfaces in `list --json`. Each launch
 * passes a unique `--worktree <branch>`, and agent-deck derives the
 * worktree directory deterministically from the branch
 * (`feature-<branch with "/" → "-">`). Branch field on the session record
 * is empty in current agent-deck versions, so a naive branch filter
 * collapses to nothing and the race resurfaces. Match by the trailing
 * directory name of `path` to stay robust against differences in the
 * repo's worktree-parent location.
 *
 * Fall back to the diff-since-snapshot pick only when no session
 * surfaces a matching worktree directory (e.g. older agent-deck
 * versions, edge cases) — explicit so a future agent-deck upgrade that
 * starts surfacing branch can still benefit from both paths.
 *
 * Exported for direct unit testing.
 */
export function pickLaunchedSession(
  sessions: readonly AgentDeckSessionSnapshot[],
  beforeIds: ReadonlySet<string>,
  branch: string,
): AgentDeckSessionSnapshot | undefined {
  const expectedDirName = expectedWorktreeDirName(branch);
  const dirMatch = sessions
    .filter((session) => {
      if (beforeIds.has(session.sessionId)) return false;
      if (!session.worktreePath) return false;
      const last = path.basename(session.worktreePath);
      return last === expectedDirName;
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

/**
 * Derive the worktree directory name agent-deck creates for a given
 * branch. agent-deck's --worktree flag produces `feature-<branch>` with
 * "/" rewritten to "-". Exported for unit testing.
 */
export function expectedWorktreeDirName(branch: string): string {
  return "feature-" + branch.replace(/\//g, "-");
}

export function launchAgentDeckManager(input: {
  readonly repoPath: string;
  readonly spawnId: string;
  readonly branch: string;
  readonly title: string;
  readonly group: string;
  readonly profile?: string;
}): AgentDeckManagerSession {
  const beforeIds = new Set(
    listAgentDeckSessions(input.profile, input.group).map((session) => session.sessionId),
  );
  const args = [
    ...(input.profile ? ["-p", input.profile] : []),
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
    "-b",
    "--title-lock",
    "--extra-arg",
    "--permission-mode",
    "--extra-arg",
    "auto",
    "--extra-arg",
    "--model",
    "--extra-arg",
    DEFAULT_MANAGER_MODEL,
  ];

  try {
    execFileSync("agent-deck", args, {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (err) {
    const stderr = stderrText((err as { stderr?: unknown }).stderr);
    throw new HatcherySpawnError(
      stderr
        ? `agent-deck manager launch failed:\n${stderr}`
        : `agent-deck manager launch failed: ${(err as Error).message}`,
    );
  }

  const allSessions = listAgentDeckSessions(input.profile, input.group);
  const launched = pickLaunchedSession(allSessions, beforeIds, input.branch);
  if (!launched) {
    throw new HatcherySpawnError(
      `agent-deck manager launch completed but the new session could not be identified from agent-deck list.`,
    );
  }

  let worktreePath: string | undefined = launched.worktreePath;
  if (!worktreePath) {
    worktreePath = readAgentDeckWorktreePath(launched.sessionId, input.profile);
  }
  if (!worktreePath) {
    throw new HatcherySpawnError(
      `agent-deck manager session "${launched.sessionId}" did not report a worktree path.`,
    );
  }

  // Hard correctness check: the session's worktree directory MUST match the
  // one agent-deck would create for our --worktree <branch> flag. Without
  // this guard, when pickLaunchedSession's worktree-dir match fails (a
  // launched session sometimes isn't persisted by the time we query under
  // load), the diff-since-snapshot fallback can pick a sibling launch's
  // session and we silently apply our patch to the wrong worktree. Failing
  // here surfaces the race as an escalation rather than as data corruption.
  // Run after the worktreePath fallback so older agent-deck versions whose
  // `list --json` omits `worktreePath` (resolved via `session show --json`)
  // still hit the validation with a populated path.
  const expectedDirName = expectedWorktreeDirName(input.branch);
  const actualDirName = path.basename(worktreePath);
  if (actualDirName !== expectedDirName) {
    throw new HatcherySpawnError(
      `agent-deck manager session "${launched.sessionId}" attached to worktree ` +
        `"${worktreePath}" but this launch requested branch "${input.branch}" ` +
        `which should produce worktree dir "${expectedDirName}". Refusing to apply patch to ` +
        `the wrong worktree. This usually means a concurrent launch consumed our session ` +
        `before we could identify it; the loop's next tick should re-dispatch cleanly once ` +
        `the colliding spawn finishes.`,
    );
  }

  return {
    sessionId: launched.sessionId,
    title: launched.title || input.title,
    group: launched.group || input.group,
    branch: launched.branch || input.branch,
    worktreePath,
  };
}

interface AgentDeckSessionSnapshot {
  readonly sessionId: string;
  readonly title: string;
  readonly group: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly createdAt: string;
}

function parseAgentDeckSession(record: Record<string, unknown>): AgentDeckSessionSnapshot | null {
  const sessionId = firstString(record, ["id", "session_id", "sessionId"]);
  if (!sessionId) return null;
  return {
    sessionId,
    title: firstString(record, ["title", "name"]) ?? "",
    group: firstString(record, ["group"]) ?? "",
    branch: firstString(record, ["worktree_branch", "branch", "worktreeBranch"]) ?? "",
    worktreePath: firstString(record, ["worktree_path", "path", "worktreePath"]) ?? "",
    createdAt: firstString(record, ["created_at", "createdAt"]) ?? "",
  };
}

function listAgentDeckSessions(
  profile: string | undefined,
  group: string,
): AgentDeckSessionSnapshot[] {
  const args = [...(profile ? ["-p", profile] : []), "list", "--json"];
  let stdout: string;
  try {
    stdout = execFileSync("agent-deck", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (err) {
    const stderr = stderrText((err as { stderr?: unknown }).stderr);
    throw new HatcherySpawnError(
      stderr
        ? `agent-deck session list failed:\n${stderr}`
        : `agent-deck session list failed: ${(err as Error).message}`,
    );
  }

  const parsed = parseJsonMaybe(stdout.trim());
  if (!Array.isArray(parsed)) {
    throw new HatcherySpawnError("agent-deck list --json returned unexpected output.");
  }

  return parsed
    .filter((value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value),
    )
    .map((record) => parseAgentDeckSession(record))
    .filter((session): session is AgentDeckSessionSnapshot =>
      !!session && session.group === group,
    );
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

function readAgentDeckWorktreePath(
  sessionId: string,
  profile?: string,
): string | undefined {
  const args = [
    ...(profile ? ["-p", profile] : []),
    "session",
    "show",
    sessionId,
    "--json",
  ];
  try {
    const stdout = execFileSync("agent-deck", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const parsed = parseJsonMaybe(stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parseAgentDeckSession(parsed as Record<string, unknown>)?.worktreePath;
  } catch {
    return undefined;
  }
}

export function removeAgentDeckManager(input: {
  readonly sessionId: string;
  readonly profile?: string;
}): void {
  const args = [
    ...(input.profile ? ["-p", input.profile] : []),
    "session",
    "remove",
    input.sessionId,
    "--prune-worktree",
    "--force",
  ];
  try {
    execFileSync("agent-deck", args, {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch {
    // Best-effort cleanup for failed handoffs. Surface the original error.
  }
}

export function sendPromptToAgentDeckManager(input: {
  readonly sessionId: string;
  readonly prompt: string;
  readonly profile?: string;
}): void {
  const args = [
    ...(input.profile ? ["-p", input.profile] : []),
    "session",
    "send",
    input.sessionId,
    input.prompt,
  ];
  try {
    execFileSync("agent-deck", args, {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (err) {
    const stderr = stderrText((err as { stderr?: unknown }).stderr);
    throw new HatcherySpawnError(
      stderr
        ? `agent-deck manager prompt send failed:\n${stderr}`
        : `agent-deck manager prompt send failed: ${(err as Error).message}`,
    );
  }
}

export function applyPatchToManagerWorktree(input: {
  readonly patchPath: string;
  readonly worktreePath: string;
}): void {
  // Pre-check cwd existence so we don't surface Node's misleading
  // "spawnSync git ENOENT" — which happens when execFileSync can't chdir
  // to the manager worktree, and looks identical to "git is not
  // installed." The race in launchAgentDeckManager used to produce this
  // error every time a concurrent dispatch attached to the wrong session;
  // even after the race fix, surfacing a clear message keeps future
  // failures debuggable.
  if (!fs.existsSync(input.worktreePath)) {
    throw new HatcherySpawnError(
      `git apply --index aborted: manager worktree not found at ${input.worktreePath}. ` +
        `This usually means launchAgentDeckManager attached to the wrong session (race) ` +
        `or the worktree was removed between launch and patch-apply.`,
    );
  }
  try {
    execFileSync("git", ["apply", "--index", input.patchPath], {
      cwd: input.worktreePath,
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    });
  } catch (err) {
    const stderr = stderrText((err as { stderr?: unknown }).stderr);
    throw new HatcherySpawnError(
      stderr
        ? `git apply --index failed in manager worktree:\n${stderr}`
        : `git apply --index failed in manager worktree: ${(err as Error).message}`,
    );
  }
}

export function validateHatcherySpawnBackend(backend: SpawnBackend): void {
  const missingEnvVars = missingRequiredEnvVars(backend);
  if (missingEnvVars.length > 0) {
    throw new HatcherySpawnError(
      `Backend "${backend.name}" requires ${backend.requiredEnvVars.join(", ")}: missing ${missingEnvVars.join(", ")}. Set the variable(s) and re-run.`,
    );
  }

  const missingMounts = missingCredentialMounts(backend);
  if (missingMounts.length > 0) {
    throw new HatcherySpawnError(
      `Backend "${backend.name}" requires readable credential directories: ${missingMounts.map((mount) => mount.hostPath).join(", ")}. Configure the credential path(s) and re-run.`,
    );
  }
}

export function runHatcherySpawn(
  input: HatcherySpawnOptions,
): HatcherySpawnResult {
  validateHatcherySpawnBackend(input.backend);

  const spawnId = generateSpawnId();
  const branch = input.branch?.trim() || managerBranchName(spawnId);
  const title = input.title?.trim() || `spawn manager ${spawnId}`;
  const group = input.managerGroup?.trim() || DEFAULT_MANAGER_GROUP;
  const startedAt = new Date().toISOString();

  let manager: AgentDeckManagerSession | undefined;
  manager = launchAgentDeckManager({
    repoPath: input.repoPath,
    spawnId,
    branch,
    title,
    group,
    profile: input.agentDeckProfile,
  });

  const spawnPrompt = buildSpawnPatchPrompt(input.prompt);

  let containerId: string | undefined;
  let logs = "";
  let handedOff = false;
  try {
    writeInitialSpawnRecord({
      id: spawnId,
      repoPath: input.repoPath,
      branch,
      worktreePath: manager.worktreePath,
      backend: input.backend.name,
    }, input.homeDir);
    updateSpawnRecordPrompt(spawnId, spawnPrompt, input.homeDir);

    const handle = createBuildContext(manager.worktreePath);
    try {
      const dockerfilePath = writeSpawnDockerfile(
        handle.contextPath,
        input.backend.baseImage,
      );
      const imageTag = buildSpawnImage({
        spawnId,
        contextPath: handle.contextPath,
        dockerfilePath,
      });
      updateSpawnRecordImageId(spawnId, imageTag, input.homeDir);
    } finally {
      handle.cleanup();
    }

    containerId = createSpawnContainer({ spawnId, backend: input.backend });
    copyPromptToContainer(containerId, spawnPrompt);
    startSpawnContainer(containerId);
    markSpawnRecordRunning(spawnId, containerId, input.homeDir);

    const waitResult = waitForSpawnContainer(containerId);
    logs = readSpawnContainerLogs(containerId);
    markSpawnRecordStopped(spawnId, waitResult.exitCode, input.homeDir);
    const managerPrompt = buildManagerPrompt({
      operatorPrompt: input.prompt,
    });
    if (waitResult.exitCode !== 0) {
      const artifacts = createHatcherySpawnArtifacts({
        spawnId,
        homeDir: input.homeDir,
        spawnOutput: logs,
        patch: "",
        managerPrompt,
        metadata: metadataFor(input, manager, spawnId, branch, waitResult.exitCode, startedAt),
      });
      throw new HatcherySpawnError(
        `Spawn ${spawnId} exited ${waitResult.exitCode}; manager prompt was not sent. Logs: ${artifacts.spawnOutputPath}`,
      );
    }

    let patch: string;
    try {
      patch = extractPatchFromSpawnOutput(logs);
    } catch (err) {
      const artifacts = createHatcherySpawnArtifacts({
        spawnId,
        homeDir: input.homeDir,
        spawnOutput: logs,
        patch: "",
        managerPrompt,
        metadata: metadataFor(input, manager, spawnId, branch, waitResult.exitCode, startedAt),
      });
      throw new HatcherySpawnError(
        `${(err as Error).message} Logs: ${artifacts.spawnOutputPath}`,
      );
    }

    const artifacts = createHatcherySpawnArtifacts({
      spawnId,
      homeDir: input.homeDir,
      spawnOutput: logs,
      patch,
      managerPrompt,
      metadata: metadataFor(input, manager, spawnId, branch, waitResult.exitCode, startedAt),
    });
    applyPatchToManagerWorktree({
      patchPath: artifacts.patchPath,
      worktreePath: manager.worktreePath,
    });
    sendPromptToAgentDeckManager({
      sessionId: manager.sessionId,
      prompt: managerPrompt,
      profile: input.agentDeckProfile,
    });
    handedOff = true;

    return {
      spawnId,
      backend: input.backend.name,
      branch,
      managerSession: manager,
      artifacts,
      exitCode: waitResult.exitCode,
      summary: [
        `Hatchery spawn ${spawnId} handed off to manager session ${manager.sessionId}.`,
        `Branch: ${branch}`,
        `Worktree: ${manager.worktreePath}`,
        `Patch: ${artifacts.patchPath}`,
        `Logs: ${artifacts.spawnOutputPath}`,
      ].join("\n"),
    };
  } catch (err) {
    if (!(err instanceof HatcherySpawnError)) {
      try {
        markSpawnRecordFailed(spawnId, { error: (err as Error).message }, input.homeDir);
      } catch {
        // Preserve the original error.
      }
    }
    if (containerId) removeSpawnContainer(spawnId);
    removeSpawnImage(spawnId);
    if (manager && !handedOff) {
      removeAgentDeckManager({
        sessionId: manager.sessionId,
        profile: input.agentDeckProfile,
      });
    }
    if (
      err instanceof SnapshotError ||
      err instanceof BuildError ||
      err instanceof LaunchError ||
      err instanceof SpawnRecordError ||
      err instanceof HatcherySpawnError
    ) {
      throw err;
    }
    throw new HatcherySpawnError((err as Error).message);
  }
}

function metadataFor(
  input: HatcherySpawnOptions,
  manager: AgentDeckManagerSession,
  spawnId: string,
  branch: string,
  exitCode: number,
  startedAt: string,
): Record<string, unknown> {
  return {
    version: 1,
    spawnId,
    backend: input.backend.name,
    repoPath: input.repoPath,
    branch,
    managerSession: manager,
    exitCode,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function stderrText(stderr: unknown): string {
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf-8").trimEnd();
  if (typeof stderr === "string") return stderr.trimEnd();
  return "";
}
