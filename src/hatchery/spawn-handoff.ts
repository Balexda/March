import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  missingCredentialMounts,
  missingRequiredEnvVars,
  PATCH_SENTINEL,
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
import { generateSpawnId, removeSpawnWorktree } from "../brood/worktree.js";
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
import { startDispatchSpan, type DispatchTrace } from "../observability/spawn-trace.js";
import { emitSpawnLog } from "../observability/logs.js";
import {
  recordSpawnRun,
  type SpawnFailureStage,
} from "../observability/spawn-metrics.js";
import {
  classifyBranchSafety,
  describeVerdict,
  findWorktreePathForBranch,
  verdictLabel,
  type BranchSafetyVerdict,
} from "./orphan-branch.js";
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
import { publishStewardAttachedToHerald } from "./service/herald-registration.js";

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

/**
 * The local branch ref agent-deck/castra actually creates for a manager
 * session: a `feature/` prefix on the bare dispatch branch. The dispatched
 * `branch` is the symbolic name (e.g. `smithy/cut/01-spawn-f3-s3`); the real
 * local ref is `feature/smithy/cut/01-spawn-f3-s3`. Idempotent when `branch`
 * is already prefixed. Used by the failed-spawn rollback to delete the orphan
 * branch Castra's worktree-prune leaves behind (issue #211).
 */
export function orphanManagerBranch(branch: string): string {
  return "feature/" + branch.replace(/^feature\//, "");
}

/**
 * Does this error look like agent-deck/git refusing because the dispatch branch
 * already exists? The `manager.launch` failure surfaces as
 * `Castra session launch failed: agent-deck launch failed: Error: branch
 * '<ref>' already exists (remove -b flag ...)`. Combined with the
 * `manager_launch` stage guard at the call site, matching `already exists` is a
 * precise signal for the orphan-branch collision (#243).
 */
export function isBranchAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

export interface SelfHealResult {
  readonly orphanBranch: string;
  readonly verdict: BranchSafetyVerdict;
  /** True when the orphan was a safe ref and removal was performed. */
  readonly removed: boolean;
}

/**
 * Self-heal a `manager.launch` "branch already exists" collision (#243). When
 * the launch throws, `manager` is undefined, so the standard rollback's
 * `mgr && !handedOff` branch — the only place that removes a leaked branch —
 * never runs, and every retry re-collides (self-perpetuating wedge). Here we
 * resolve the real orphan ref, classify it with the SAME safety contract as
 * `legate.unwedge`, and:
 *   - safe orphan (ancestor of default / merged PR) -> remove by EXACT path
 *     (never a blanket `git worktree prune`, #155); the next dispatch re-creates
 *     it cleanly.
 *   - unsafe (open PR / diverged) -> leave it; the caller escalates with the
 *     verdict (open-PR adoption is #173, out of scope).
 * The worktree path is derived from git's own records (not `mgr`, which is
 * undefined here). Emits a `spawn.self_heal` span + trace-correlated log.
 */
function selfHealManagerLaunchCollision(input: {
  readonly repoPath: string;
  readonly spawnId: string;
  readonly branch: string;
  readonly sliceId: string;
  readonly dispatch: DispatchTrace;
}): SelfHealResult {
  const orphanBranch = orphanManagerBranch(input.branch);
  const verdict = classifyBranchSafety(input.repoPath, orphanBranch);
  const worktreePath = findWorktreePathForBranch(input.repoPath, orphanBranch);
  let removed = false;

  input.dispatch.span("spawn.self_heal", (span) => {
    span.setAttributes({
      "march.slice_id": input.sliceId,
      "march.spawn_id": input.spawnId,
      "march.orphan_branch": orphanBranch,
      "march.self_heal.verdict": verdictLabel(verdict),
      "march.worktree": worktreePath ?? "",
    });
    if (verdict.kind === "safe") {
      try {
        // Remove the worktree (if any) THEN the branch, both by exact path —
        // `git branch -D` refuses a branch checked out in a worktree.
        removeSpawnWorktree(input.repoPath, {
          spawnId: input.spawnId,
          branch: orphanBranch,
          worktreePath: worktreePath ?? "",
        });
        removed = true;
      } catch {
        // removeSpawnWorktree surfaces its own incomplete-rollback warning;
        // preserve the original launch failure for the caller.
      }
    }
    const sc = span.spanContext();
    emitSpawnLog({
      severity: verdict.kind === "safe" ? "WARN" : "ERROR",
      body:
        `spawn.self_heal: orphan branch ${orphanBranch} ${describeVerdict(verdict)}` +
        (removed
          ? " — removed; the next dispatch will re-create it cleanly."
          : verdict.kind === "safe"
            ? " — removal incomplete (see warning); manual cleanup may be required."
            : verdict.kind === "absent"
              ? " — already gone; the next dispatch will re-create it cleanly."
              : " — left in place; operator must reconcile (legate.unwedge / #173 adopt path)."),
      traceId: sc?.traceId,
      spanId: sc?.spanId,
      attributes: {
        event_kind: "spawn_self_heal",
        "march.slice_id": input.sliceId,
        "march.spawn_id": input.spawnId,
        "march.orphan_branch": orphanBranch,
        "march.self_heal.verdict": verdictLabel(verdict),
        "march.self_heal.removed": removed,
      },
    });
  });

  return { orphanBranch, verdict, removed };
}

export function buildSpawnCommitPrompt(operatorPrompt: string): string {
  return [
    "Operator request:",
    operatorPrompt.trimEnd(),
    "",
    "Hatchery instructions:",
    "- You are working inside a git repository at the current directory.",
    "- Complete only the operator request above by editing files in the working tree.",
    "- When the change is complete, COMMIT it:",
    '    git add -A && git commit -m "<short summary of the change>"',
    "- In that same commit, flip every `tasks.md` row this work completes from",
    "  `[ ]` to `[x]`.",
    "- Do NOT push, open a pull request, or run `gh` — a separate steward session",
    "  handles delivery. Do NOT hand-write, print, or paste a diff/patch; the",
    "  commit you make is the only deliverable.",
    "- If the request requires no change, make no commit and leave the tree clean.",
    "- Optionally end with a one-line summary of what you changed.",
  ].join("\n");
}

export function extractPatchFromSpawnOutput(output: string): string {
  // The deterministic in-container wrapper prints
  // `__MARCH_PATCH_B64__:<base64 of git diff base..HEAD>` as its final stdout
  // line, after the agent has committed its work. Decode that — we never scrape
  // the agent's free-text `agent_message`, which truncated on large patches and
  // produced the downstream "corrupt patch" failure (the bug this fix removes).
  const encoded = lastPatchSentinel(output);
  if (encoded === null) {
    throw new HatcherySpawnError(
      `Spawn produced no committed patch: the \`${PATCH_SENTINEL}\` sentinel line ` +
        "was absent from its output. The worker is expected to commit its change in " +
        "the container-local git repo; the wrapper then emits the patch.",
    );
  }

  const patch = Buffer.from(encoded, "base64").toString("utf-8");
  if (patch.trim().length === 0) {
    throw new HatcherySpawnError(
      "Spawn emitted an empty committed patch; the worker produced no diff.",
    );
  }
  if (!patch.includes("diff --git ")) {
    throw new HatcherySpawnError(
      "Spawn patch sentinel did not decode to a git diff (no `diff --git` header). " +
        "The wrapper output may be corrupted.",
    );
  }
  assertPatchPathsSafe(patch);
  return normalizeTrailingNewline(patch);
}

const PATCH_SENTINEL_RE = new RegExp(`^${PATCH_SENTINEL}:(.*)$`);

/** The base64 payload of the LAST patch-sentinel line, or null if none. */
function lastPatchSentinel(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(PATCH_SENTINEL_RE);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Reject a decoded patch that touches an absolute path or escapes the worktree
 * via `..` (the 2026-05-21-005 spec's untrusted-input contract). A patch from
 * `git diff` is always repo-relative, so this only fires on a tampered or
 * malformed sentinel — but it keeps the downstream `git apply` from writing
 * outside the manager worktree.
 */
function assertPatchPathsSafe(patch: string): void {
  const headerRe = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(patch)) !== null) {
    for (const candidate of [match[1], match[2]]) {
      if (candidate.startsWith("/") || candidate.split("/").includes("..")) {
        throw new HatcherySpawnError(
          `Spawn patch references an unsafe path "${candidate}" ` +
            "(absolute or parent-directory escape); refusing to apply.",
        );
      }
    }
  }
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
    /** Dispatch slice id, stamped into the session's queryable metadata (#214). */
    readonly sliceId?: string;
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
      // Self-describe the session so Herald's pull path can reconcile it to its
      // slice by exact id, not the brittle worktree/title heuristic (#214).
      metadata: {
        spawnId: input.spawnId,
        ...(input.sliceId ? { sliceId: input.sliceId } : {}),
      },
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

/** Diff-stat summary of a patch file, for `steward.apply` span attributes (#244). */
export interface PatchSummary {
  /** Count of `diff --git` headers (one per file). */
  readonly files: number;
  /** Patch size in bytes. */
  readonly bytes: number;
  /** First target path (`b/<path>`) in the patch, or undefined when empty. */
  readonly firstPath: string | undefined;
}

/** Summarize a patch file without throwing — a missing/empty patch is `0/0`. */
export function summarizePatch(patchPath: string): PatchSummary {
  let content = "";
  try {
    content = fs.readFileSync(patchPath, "utf-8");
  } catch {
    return { files: 0, bytes: 0, firstPath: undefined };
  }
  const files = (content.match(/^diff --git /gm) ?? []).length;
  const first = content.match(/^diff --git a\/.+? b\/(.+)$/m);
  return {
    files,
    bytes: Buffer.byteLength(content, "utf-8"),
    firstPath: first?.[1],
  };
}

/**
 * The line of git's stderr that best explains the failure. Prefers the first
 * `error:` line (the canonical reject git emits for `--index`), and falls back to
 * the `--3way` conflict summary (`Applied patch to '<path>' with conflicts.` /
 * `U <path>`), which carries no `error:` prefix.
 */
export function firstGitRejectLine(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim());
  const errorLine = lines.find((l) => l.startsWith("error:"));
  if (errorLine) return errorLine;
  return lines.find(
    (l) => l.includes("with conflicts") || /^U[\t ]/.test(l),
  );
}

/**
 * The offending file path from a git-apply reject line. Handles the `--index`
 * forms (`error: patch failed: <path>:<line>` and `error: <path>: <reason>` such
 * as "already exists in index") and the `--3way` conflict forms (`Applied patch
 * to '<path>' with conflicts.` and `U <path>`).
 */
export function offendingPathFromReject(
  rejectLine: string | undefined,
): string | undefined {
  if (!rejectLine) return undefined;
  const conflict = rejectLine.match(/Applied patch to '(.+)' with conflicts/);
  if (conflict) return conflict[1];
  const unmerged = rejectLine.match(/^U[\t ]+(.+)$/);
  if (unmerged) return unmerged[1].trim();
  const stripped = rejectLine.replace(/^error:\s*/, "");
  const patchFailed = stripped.match(/^patch failed:\s*(.+):\d+$/);
  if (patchFailed) return patchFailed[1];
  const colon = stripped.match(/^(.+?):\s/);
  return colon?.[1];
}

/** Which apply strategy succeeded — recorded on the span so a `--3way` save is visible. */
export type PatchApplyStrategy = "index" | "index-3way";

/**
 * A `git apply` failure that survived the `--3way` fallback (#244). Carries the
 * parsed diagnostics so the `steward.apply` span/log can name the offending path
 * and reject without re-parsing. Subclasses {@link HatcherySpawnError} so the
 * dispatch catch still classifies it as a clean Hatchery failure.
 */
export class PatchApplyError extends HatcherySpawnError {
  readonly stderr: string;
  readonly firstRejectLine: string | undefined;
  readonly offendingPath: string | undefined;
  constructor(stderr: string, fallbackMessage?: string) {
    super(
      stderr
        ? `git apply failed in manager worktree:\n${stderr}`
        : `git apply failed in manager worktree: ${fallbackMessage ?? ""}`,
    );
    this.name = "PatchApplyError";
    this.stderr = stderr;
    this.firstRejectLine = firstGitRejectLine(stderr);
    this.offendingPath = offendingPathFromReject(this.firstRejectLine);
  }
}

/**
 * Apply the worker's patch into the manager worktree. Tries `git apply --index`,
 * then falls back to `git apply --index --3way` (#244): a new-file-on-existing or
 * context-drifted patch the base happens to already contain can still merge where
 * a 3-way merge resolves it. A genuine conflict still fails — now with a parsed
 * {@link PatchApplyError} so the failure is legible in telemetry rather than a
 * bare stderr string — and is routed through the dispatch rollback / self-heal.
 */
export function applyPatchToManagerWorktree(input: {
  readonly patchPath: string;
  readonly worktreePath: string;
}): PatchApplyStrategy {
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
    runGitApply(["apply", "--index", input.patchPath], input.worktreePath);
    return "index";
  } catch (errIndex) {
    const stderrIndex = stderrText((errIndex as { stderr?: unknown }).stderr);
    // Defensive fallback (#244): a 3-way merge can resolve a patch whose base
    // context drifted (e.g. a "new file" the worktree base already has). It
    // never silently masks a real conflict — that still throws below.
    try {
      runGitApply(["apply", "--index", "--3way", input.patchPath], input.worktreePath);
      return "index-3way";
    } catch (err3way) {
      const stderr3way = stderrText((err3way as { stderr?: unknown }).stderr);
      // Combine both rejects: the plain `--index` stderr names the path with an
      // `error:` line, while the `--3way` stderr explains why the merge couldn't
      // resolve it. Together they make the failure root-causable from telemetry.
      const combined = [
        stderrIndex ? `--index:\n${stderrIndex}` : "",
        stderr3way ? `--index --3way:\n${stderr3way}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      throw new PatchApplyError(combined, (err3way as Error).message);
    }
  }
}

function runGitApply(args: readonly string[], cwd: string): void {
  execFileSync("git", args as string[], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
  });
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
  // Lifecycle stage tracker: advanced as the handoff progresses so the finally
  // block (and the rollback span) can report WHICH step failed when a step
  // throws — the container can exit 0 yet a later step fail (issue #211), so
  // outcome must be derived from `handedOff`, not the exit code. `"none"` is
  // recorded on success.
  let stage: SpawnFailureStage = "manager_launch";
  try {
    manager = await dispatch.spanAsync("manager.launch", () =>
      launchAgentDeckManager(
        {
          repoPath: input.repoPath,
          spawnId,
          branch,
          title,
          group,
          profile: agentDeckProfile,
          traceKey,
          sliceId: sliceId || undefined,
        },
        castra,
      ),
    );

    const spawnPrompt = buildSpawnCommitPrompt(input.prompt);
    stage = "record_init";

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
    const stewardSessionId = manager.sessionId;
    const managerWorktree = manager.worktreePath;
    await dispatch.spanAsync("brood.register", () =>
      registerStewardLaunchWithBrood({
        spawnId,
        stewardSessionId,
        repoPath: input.repoPath,
        branch,
        worktreePath: managerWorktree,
        backend: input.backend.name,
        profile: agentDeckProfile,
        group,
      }),
    );

    // Publish the slice↔session↔spawn correlation to Herald NOW, at launch (#213),
    // the push half of the durable stranded-steward fix. Hatchery owns these facts
    // (it alone holds all three ids); Herald's projection then links the slice to
    // its steward within a tick, so gated PR-discovery runs without waiting on the
    // legate's job poll. Best-effort and MARCH_HERALD_URL-gated, mirroring the
    // Brood push; a no-op for ad-hoc spawns with no sliceId.
    await dispatch.spanAsync("herald.publish", () =>
      publishStewardAttachedToHerald({
        sliceId,
        sessionId: stewardSessionId,
        spawnId,
        branch,
        worktreePath: managerWorktree,
      }),
    );

    stage = "image_build";
    dispatch.span("image.build", () => {
      const handle = createBuildContext(managerWorktree);
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
    });

    stage = "container_run";
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

    // Patch extraction is pure in-process parsing — not a cross-system seam, so
    // it gets no span; the stage tracker still classifies a no-patch failure.
    stage = "patch_extract";
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
    stage = "patch_apply";
    const managerWorktreePath = manager.worktreePath;
    const patchSummary = summarizePatch(artifacts.patchPath);
    dispatch.span("steward.apply", (span) => {
      // Static diagnostics, known before the apply runs — so even a worktree-not-
      // found failure still carries the slice/spawn/patch context (#244 item 2).
      span.setAttributes({
        "march.slice_id": sliceId,
        "march.spawn_id": spawnId,
        "march.worktree": managerWorktreePath,
        "march.patch_path": artifacts.patchPath,
        "march.patch.files": patchSummary.files,
        "march.patch.bytes": patchSummary.bytes,
        "march.patch.first_path": patchSummary.firstPath ?? "",
      });
      try {
        const strategy = applyPatchToManagerWorktree({
          patchPath: artifacts.patchPath,
          worktreePath: managerWorktreePath,
        });
        span.setAttributes({ "march.patch.strategy": strategy });
      } catch (err) {
        if (err instanceof PatchApplyError) {
          span.setAttributes({
            "march.patch.reject": err.firstRejectLine ?? "",
            "march.patch.offending_path": err.offendingPath ?? "",
          });
          // Trace-correlated log so Grafana's "Logs for this span" is populated —
          // attached to THIS child span's ids explicitly (no ContextManager).
          const sc = span.spanContext();
          emitSpawnLog({
            severity: "ERROR",
            body:
              `steward.apply: git apply failed for spawn ${spawnId}` +
              (err.offendingPath ? ` at ${err.offendingPath}` : "") +
              `\npatch: ${artifacts.patchPath} (${patchSummary.files} files, ${patchSummary.bytes} bytes)` +
              `\n${err.stderr}`,
            traceId: sc?.traceId,
            spanId: sc?.spanId,
            attributes: {
              event_kind: "steward_apply_failed",
              "march.slice_id": sliceId,
              "march.spawn_id": spawnId,
              "march.worktree": managerWorktreePath,
              "march.patch_path": artifacts.patchPath,
              "march.patch.files": patchSummary.files,
              "march.patch.bytes": patchSummary.bytes,
              "march.patch.first_path": patchSummary.firstPath ?? "",
              "march.patch.offending_path": err.offendingPath ?? "",
              "march.patch.reject": err.firstRejectLine ?? "",
            },
          });
        }
        throw err;
      }
    });
    stage = "steward_send";
    await dispatch.spanAsync("steward.send", () =>
      sendPromptToAgentDeckManager(
        {
          sessionId: stewardSessionId,
          prompt: managerPrompt,
          profile: agentDeckProfile,
          traceKey,
        },
        castra,
      ),
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
    // Roll back the partial spawn as ONE conceptual action — it crosses several
    // seams (Docker rm, Castra removeSession, git branch -D), so it gets a
    // single span tagged with the stage that triggered it, not one span per
    // call. Best-effort throughout; never mask the original failure.
    const mgr = manager;
    // #243: `manager.launch` failed because the dispatch branch already exists.
    // `mgr` is undefined, so the `mgr && !handedOff` rollback below cannot clean
    // it — the gap that makes the wedge self-perpetuating. Detect it here so the
    // self-heal runs after the standard rollback.
    const launchCollision =
      !mgr && stage === "manager_launch" && isBranchAlreadyExistsError(err);
    await dispatch.spanAsync(
      "spawn.rollback",
      async () => {
        if (containerId) removeSpawnContainer(spawnId);
        removeSpawnImage(spawnId);
        if (mgr && !handedOff) {
          await removeAgentDeckManager(
            { sessionId: mgr.sessionId, profile: agentDeckProfile, traceKey },
            castra,
          );
          // Castra's removeSession prunes the worktree but LEAVES the local
          // branch behind. A later re-dispatch of the same slice would then
          // collide on "branch already exists" and strand the slice
          // operator-only (issue #211). Remove the orphan branch (and the
          // worktree, idempotently) by EXACT path via the rollback helper — it
          // never runs a blanket `git worktree prune` (#155).
          try {
            removeSpawnWorktree(input.repoPath, {
              spawnId,
              branch: orphanManagerBranch(branch),
              worktreePath: mgr.worktreePath,
            });
          } catch {
            // Swallowed — removeSpawnWorktree surfaces its own incomplete-
            // rollback warning; preserve the original failure below.
          }
        }
      },
      { "march.failure_stage": stage },
    );

    // #243: self-heal the orphan-branch collision that the rollback above could
    // not reach (mgr undefined). Removes a safe orphan so the next dispatch
    // succeeds; for an unsafe branch (open PR / diverged) it is left in place and
    // we escalate with the classification instead of the bare "already exists".
    let selfHeal: SelfHealResult | undefined;
    if (launchCollision) {
      selfHeal = selfHealManagerLaunchCollision({
        repoPath: input.repoPath,
        spawnId,
        branch,
        sliceId,
        dispatch,
      });
    }
    if (selfHeal && selfHeal.verdict.kind === "unsafe") {
      throw new HatcherySpawnError(
        `${(err as Error).message}\n\nOrphan branch ${selfHeal.orphanBranch} was NOT auto-removed: ` +
          `${describeVerdict(selfHeal.verdict)}. Operator must reconcile before this slice can re-dispatch.`,
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
    // Outcome is the real HANDOFF result, not the container exit code: a 0 exit
    // followed by a failed patch-apply / steward-send is a FAILED spawn (issue
    // #211). `handedOff` is set only after the final send succeeds, so it is the
    // single source of truth here.
    const failed = !handedOff;
    if (exitCode !== undefined) {
      dispatch.setAttributes({ "march.exit_code": exitCode });
    }
    if (failed) {
      dispatch.setAttributes({ "march.failure_stage": stage });
    }
    dispatch.end({ error: failed });
    recordSpawnRun({
      backend: input.backend.name,
      taskType,
      profile,
      outcome: failed ? "failure" : "success",
      failureStage: failed ? stage : undefined,
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
