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
  // Require the closing fence to be preceded by a newline at the START of its
  // line. Inner ```ts / ```diff fences embedded as added patch lines are
  // prefixed by `+` (or `-`/` ` for context), so they fail this anchor and
  // don't terminate the match. Only the outer closing fence — which sits on
  // its own line — matches.
  const fenced = text.match(
    /```(?:diff|patch)?[^\n]*\n([\s\S]*?diff --git [\s\S]*?)\n```(?:\r?\n|\r|$)/,
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

  const launched = listAgentDeckSessions(input.profile, input.group)
    .filter((session) => !beforeIds.has(session.sessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
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
