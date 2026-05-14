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
  readonly homeDir?: string;
}

export interface AgentDeckManagerSession {
  readonly sessionId: string;
  readonly title: string;
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
    return output.slice(markerIndex).trimEnd() + "\n";
  }

  throw new HatcherySpawnError(
    "Spawn completed but no git patch was found in its output. Expected a JSON/JSONL `patch` field or raw output beginning with `diff --git`.",
  );
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
  const fenced = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?diff --git [\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trimEnd() + "\n";

  const markerIndex = text.indexOf("diff --git ");
  if (markerIndex >= 0) return text.slice(markerIndex).trimEnd() + "\n";

  return null;
}

export function buildManagerPrompt(input: {
  readonly operatorPrompt: string;
  readonly patchPath: string;
  readonly spawnOutputPath: string;
  readonly metadataPath: string;
}): string {
  return [
    "You are the March Hatchery management session for a completed spawn.",
    "",
    "Apply and review the staged spawn patch, then open a PR.",
    "",
    `Original request:\n${input.operatorPrompt.trimEnd()}`,
    "",
    "Artifacts:",
    `- Patch: ${input.patchPath}`,
    `- Spawn output log: ${input.spawnOutputPath}`,
    `- Metadata: ${input.metadataPath}`,
    "",
    "Required workflow:",
    "1. Read the metadata and spawn output log.",
    "2. Apply the patch from the repository root with `git apply --index`.",
    "3. Review the resulting diff for correctness and security.",
    "4. Run the smallest meaningful verification for the touched code.",
    "5. Commit the applied change, push the branch, and open a GitHub PR.",
    "6. Report the PR URL and any verification gaps.",
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
    "--json",
  ];

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
        ? `agent-deck manager launch failed:\n${stderr}`
        : `agent-deck manager launch failed: ${(err as Error).message}`,
    );
  }

  const parsed = parseAgentDeckSession(stdout);
  if (!parsed.sessionId) {
    throw new HatcherySpawnError(
      `agent-deck manager launch did not return a session id: ${stdout.trim()}`,
    );
  }

  let worktreePath = parsed.worktreePath;
  if (!worktreePath) {
    worktreePath = readAgentDeckWorktreePath(parsed.sessionId, input.profile);
  }
  if (!worktreePath) {
    throw new HatcherySpawnError(
      `agent-deck manager session "${parsed.sessionId}" did not report a worktree path.`,
    );
  }

  return {
    sessionId: parsed.sessionId,
    title: parsed.title ?? input.title,
    branch: parsed.branch ?? input.branch,
    worktreePath,
  };
}

function parseAgentDeckSession(stdout: string): {
  sessionId?: string;
  title?: string;
  branch?: string;
  worktreePath?: string;
} {
  const parsed = parseJsonMaybe(stdout.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  return {
    sessionId: firstString(record, ["id", "session_id", "sessionId"]),
    title: firstString(record, ["title", "name"]),
    branch: firstString(record, ["worktree_branch", "branch", "worktreeBranch"]),
    worktreePath: firstString(record, ["worktree_path", "path", "worktreePath"]),
  };
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
    return parseAgentDeckSession(stdout).worktreePath;
  } catch {
    return undefined;
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
  const branch = managerBranchName(spawnId);
  const title = input.title?.trim() || `spawn manager ${spawnId}`;
  const group = input.managerGroup?.trim() || DEFAULT_MANAGER_GROUP;
  const startedAt = new Date().toISOString();

  const manager = launchAgentDeckManager({
    repoPath: input.repoPath,
    spawnId,
    branch,
    title,
    group,
    profile: input.agentDeckProfile,
  });

  const spawnPrompt = buildSpawnPatchPrompt(input.prompt);

  writeInitialSpawnRecord({
    id: spawnId,
    repoPath: input.repoPath,
    branch,
    worktreePath: manager.worktreePath,
    backend: input.backend.name,
  }, input.homeDir);
  updateSpawnRecordPrompt(spawnId, spawnPrompt, input.homeDir);

  let containerId: string | undefined;
  let logs = "";
  try {
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
    if (waitResult.exitCode !== 0) {
      const managerPrompt = buildManagerPrompt({
        operatorPrompt: input.prompt,
        patchPath: "",
        spawnOutputPath: "",
        metadataPath: "",
      });
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

    const patch = extractPatchFromSpawnOutput(logs);
    const metadataPath = path.join(hatcherySpawnLogDir(spawnId, input.homeDir), "metadata.json");
    const spawnOutputPath = path.join(hatcherySpawnLogDir(spawnId, input.homeDir), "spawn-output.log");
    const patchPath = path.join(hatcherySpawnLogDir(spawnId, input.homeDir), "patch.diff");
    const managerPrompt = buildManagerPrompt({
      operatorPrompt: input.prompt,
      patchPath,
      spawnOutputPath,
      metadataPath,
    });
    const artifacts = createHatcherySpawnArtifacts({
      spawnId,
      homeDir: input.homeDir,
      spawnOutput: logs,
      patch,
      managerPrompt,
      metadata: metadataFor(input, manager, spawnId, branch, waitResult.exitCode, startedAt),
    });
    sendPromptToAgentDeckManager({
      sessionId: manager.sessionId,
      prompt: managerPrompt,
      profile: input.agentDeckProfile,
    });

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
