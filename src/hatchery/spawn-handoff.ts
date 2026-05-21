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
  copyOtelEmitterToContainer,
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
  updateSpawnRecordStewardSession,
  writeInitialSpawnRecord,
} from "../brood/spawn-record.js";
import { startDispatchSpan } from "../observability/spawn-trace.js";
import { recordSpawnRun } from "../observability/spawn-metrics.js";
import { buildSpawnOtelContext } from "../observability/in-spawn-emitter.js";
import {
  CastraClient,
  CastraClientError,
  createCastraClientFromEnv,
} from "../castra/client.js";
import {
  DEFAULT_AGENT_DECK_PROFILE,
  DEFAULT_MANAGER_GROUP,
  DEFAULT_MANAGER_MODEL,
} from "./defaults.js";
import { registerStewardLaunchWithBrood } from "./service/brood-registration.js";

export {
  DEFAULT_AGENT_DECK_PROFILE,
  DEFAULT_MANAGER_GROUP,
  DEFAULT_MANAGER_MODEL,
} from "./defaults.js";

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
  /**
   * Deployment profile for telemetry tagging — the Legate deployment's profile,
   * passed down from the loop (set at `march legate init`). Owned by the
   * deployment, not derived from the agent-deck profile. `"unknown"` for ad-hoc
   * spawns. Lets test/integ telemetry be filtered out of real metrics.
   */
  readonly profile?: string;
  /** Smithy verb (forge/cut/render/mark) for telemetry tagging. */
  readonly taskType?: string;
  /** Work-item slug for telemetry tagging. */
  readonly taskName?: string;
  /** Dispatch slice id; hashed into the trace id so all spans share one trace. */
  readonly sliceId?: string;
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
    "Required workflow — execute every step in this turn; do NOT end your turn",
    "between steps. The deterministic loop has no way to nudge you mid-task,",
    "so a session that stops after the commit or push but before the PR is a",
    "stranded steward that requires manual recovery.",
    "1. Inspect `git status --short` and the staged diff.",
    "2. Review the resulting diff for correctness and security.",
    "3. Run the smallest meaningful verification for the touched code.",
    "4. Confirm the work is actually complete: every acceptance criterion the",
    "   slice was scoped to must be satisfied by the staged diff. If any item is",
    "   missing, partial, or untested, FIX IT in this turn (extend the diff) or",
    "   escalate via `NEED:` — do not proceed to commit on partial work. This",
    "   prevents the downstream `dedup-blocks-re-dispatch` failure where the loop",
    "   archives a merged-but-incomplete slice and then refuses to re-queue it.",
    "5. Verify the work is marked complete: every tasks.md row this slice",
    "   addresses must be flipped from `[ ]` to `[x]` in the staged diff. If the",
    "   matching tasks.md path or row id is ambiguous, name your assumption in the",
    "   PR body; if you cannot find them at all, escalate via `NEED:` rather than",
    "   committing with the boxes still unchecked.",
    "6. Commit the applied change. (`git commit`)",
    "7. Push the branch to origin. (`git push -u origin <branch>`)",
    "8. Open the PR with `gh pr create`. Use the artifact path and original request",
    "   to compose the title and body — keep it under ~70 chars; details belong in",
    "   the body. Mention any verification gaps directly in the PR body.",
    "9. Report the PR URL on the final line of your reply as `PR: <url>`. If any",
    "   step fails, escalate via `NEED: <one-line summary> — <one-line next action>`",
    "   instead of stopping silently. NEVER end your turn after a successful commit",
    "   or push if the PR has not yet been opened — that leaves the workflow stranded.",
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
 * Launch the steward (manager) session through Castra's HTTP API. Castra owns
 * the one tmux server / agent-deck install; it performs the launch, the
 * concurrent-launch worktree-race guard, the worktree-path resolution, and the
 * session-level auto-mode set server-side (see `src/castra/adapter.ts`). The
 * Hatchery only needs the resulting session — its worktree is created on the
 * shared host HOME, which the Hatchery container mounts at the identical path so
 * the patch-apply and build-context steps can still operate on it locally.
 *
 * A Castra `conflict` (409) — a launch that raced onto the wrong worktree —
 * surfaces here as a HatcherySpawnError so the loop re-dispatches on the next
 * tick rather than corrupting the colliding spawn's worktree.
 */
export async function launchAgentDeckManager(
  input: {
    readonly repoPath: string;
    readonly spawnId: string;
    readonly branch: string;
    readonly title: string;
    readonly group: string;
    readonly profile: string;
    readonly traceKey?: string;
  },
  castra: CastraClient = createCastraClientFromEnv(),
): Promise<AgentDeckManagerSession> {
  let session;
  try {
    session = await castra.launchSession({
      profile: input.profile,
      repoPath: input.repoPath,
      branch: input.branch,
      title: input.title,
      group: input.group,
      model: DEFAULT_MANAGER_MODEL,
      traceKey: input.traceKey,
    });
  } catch (err) {
    throw new HatcherySpawnError(
      `Castra session launch failed: ${
        err instanceof CastraClientError || err instanceof Error
          ? err.message
          : String(err)
      }`,
    );
  }

  if (!session.worktreePath) {
    throw new HatcherySpawnError(
      `Castra session "${session.sessionId}" did not report a worktree path.`,
    );
  }

  return {
    sessionId: session.sessionId,
    title: session.title || input.title,
    group: session.group || input.group,
    branch: session.branch || input.branch,
    worktreePath: session.worktreePath,
  };
}

export async function removeAgentDeckManager(
  input: {
    readonly sessionId: string;
    readonly profile: string;
    readonly traceKey?: string;
  },
  castra: CastraClient = createCastraClientFromEnv(),
): Promise<void> {
  try {
    await castra.removeSession({
      profile: input.profile,
      sessionId: input.sessionId,
      pruneWorktree: true,
      traceKey: input.traceKey,
    });
  } catch {
    // Best-effort cleanup for failed handoffs. Surface the original error.
  }
}

export async function sendPromptToAgentDeckManager(
  input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly profile: string;
    readonly traceKey?: string;
  },
  castra: CastraClient = createCastraClientFromEnv(),
): Promise<void> {
  try {
    await castra.sendPrompt({
      profile: input.profile,
      sessionId: input.sessionId,
      prompt: input.prompt,
      traceKey: input.traceKey,
    });
  } catch (err) {
    throw new HatcherySpawnError(
      `Castra session send failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
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

export async function runHatcherySpawn(
  input: HatcherySpawnOptions,
): Promise<HatcherySpawnResult> {
  validateHatcherySpawnBackend(input.backend);

  const spawnId = generateSpawnId();
  const branch = input.branch?.trim() || managerBranchName(spawnId);
  const title = input.title?.trim() || `spawn manager ${spawnId}`;
  const group = input.managerGroup?.trim() || DEFAULT_MANAGER_GROUP;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const taskType = input.taskType?.trim() || "unknown";
  const taskName = input.taskName?.trim() || "unknown";
  const profile = input.profile?.trim() || "unknown";
  const sliceId = input.sliceId?.trim() || "";
  // Castra needs a concrete profile on every request; the deterministic loop
  // always sets one, ad-hoc spawns fall back to agent-deck's default profile.
  const agentDeckProfile =
    input.agentDeckProfile?.trim() || DEFAULT_AGENT_DECK_PROFILE;
  // Shared trace key: passed to Castra as x-march-slice-id so its launch/send
  // spans hash into the same trace as this dispatch span.
  const traceKey = sliceId || spawnId;
  const castra = createCastraClientFromEnv();

  const dispatch = startDispatchSpan({
    traceKey,
    rootName: "hatchery.spawn",
    attributes: {
      "march.profile": profile,
      "march.task.name": taskName,
      "march.task.type": taskType,
      "march.backend": input.backend.name,
      "march.slice_id": sliceId,
      "march.spawn_id": spawnId,
    },
  });
  let exitCode: number | undefined;

  let manager: AgentDeckManagerSession | undefined;
  let containerId: string | undefined;
  let logs = "";
  let handedOff = false;
  try {
    manager = await launchAgentDeckManager(
      {
        repoPath: input.repoPath,
        spawnId,
        branch,
        title,
        group,
        profile: agentDeckProfile,
        traceKey,
      },
      castra,
    );

    const spawnPrompt = buildSpawnPatchPrompt(input.prompt);

    writeInitialSpawnRecord({
      id: spawnId,
      repoPath: input.repoPath,
      branch,
      worktreePath: manager.worktreePath,
      backend: input.backend.name,
    }, input.homeDir);
    updateSpawnRecordPrompt(spawnId, spawnPrompt, input.homeDir);
    // Record the steward<->spawn link so Brood (and a standalone
    // `march brood teardown`) can address the steward during teardown.
    updateSpawnRecordStewardSession(spawnId, manager.sessionId, input.homeDir);

    // Register the steward (and a minimal spawn row) with Brood NOW, at launch —
    // not just on success (#172). The Castra session already exists; if any step
    // below fails (image/container build, patch extraction, prompt send) the
    // in-process cleanup is best-effort and can be skipped (Castra unreachable,
    // worker killed, crash). The launch-time row makes the steward Brood-trackable
    // so ghost-cleanup can reclaim it instead of deferring on a "registration gap".
    // Best-effort and MARCH_BROOD_URL-gated: a missing/unreachable registry never
    // fails the dispatch. The onSucceeded hook later enriches this row.
    await registerStewardLaunchWithBrood({
      spawnId,
      stewardSessionId: manager.sessionId,
      repoPath: input.repoPath,
      branch,
      worktreePath: manager.worktreePath,
      backend: input.backend.name,
      profile: agentDeckProfile,
      group,
    });

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

    dispatch.span("spawn.start", () => {
      const otelCtx = buildSpawnOtelContext({
        traceparent: dispatch.traceparent(),
        attributes: {
          "service.name": "march-spawn",
          "march.profile": profile,
          "march.task.name": taskName,
          "march.task.type": taskType,
          "march.backend": input.backend.name,
          "march.spawn_id": spawnId,
          "march.slice_id": sliceId,
        },
      });
      containerId = createSpawnContainer({
        spawnId,
        backend: input.backend,
        otel: otelCtx,
      });
      copyPromptToContainer(containerId, spawnPrompt);
      if (otelCtx) copyOtelEmitterToContainer(containerId);
      startSpawnContainer(containerId);
      markSpawnRecordRunning(spawnId, containerId, input.homeDir);
    });

    const waitResult = dispatch.span("spawn.end", () => {
      const r = waitForSpawnContainer(containerId!);
      logs = readSpawnContainerLogs(containerId!);
      markSpawnRecordStopped(spawnId, r.exitCode, input.homeDir);
      return r;
    });
    exitCode = waitResult.exitCode;
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
    const managerWorktreePath = manager.worktreePath;
    dispatch.span("steward.apply", () => {
      applyPatchToManagerWorktree({
        patchPath: artifacts.patchPath,
        worktreePath: managerWorktreePath,
      });
    });
    await sendPromptToAgentDeckManager(
      {
        sessionId: manager.sessionId,
        prompt: managerPrompt,
        profile: agentDeckProfile,
        traceKey,
      },
      castra,
    );
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
    dispatch.recordException(err);
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
      await removeAgentDeckManager(
        {
          sessionId: manager.sessionId,
          profile: agentDeckProfile,
          traceKey,
        },
        castra,
      );
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
  } finally {
    const outcome: "success" | "failure" =
      exitCode === 0 ? "success" : "failure";
    if (exitCode !== undefined) {
      dispatch.setAttributes({ "march.exit_code": exitCode });
    }
    dispatch.end({ error: outcome !== "success" });
    recordSpawnRun({
      backend: input.backend.name,
      taskType,
      profile,
      outcome,
      durationSeconds: (Date.now() - startMs) / 1000,
    });
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
