import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatMissingBackendAuthError,
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
import {
  hatcheryGitEnv,
  HatcheryGitHubError,
  readHatcheryGitHubDefaultBranch,
  resolveHatcheryOrigin,
  runHatcheryNetworkGit,
} from "./github-read.js";
import {
  createIntegrationCommit,
  findIntegrationCommit,
  IntegrationPublicationError,
  publicationError,
  pushIntegrationCommit,
  type IntegrationCommit,
} from "./integration-publisher.js";
import { createBuildContext, SnapshotError } from "../spawn/snapshot.js";
import { resolveToolchain, resolveToolchainImage } from "../spawn/toolchain.js";
import {
  buildSpawnImage,
  BuildError,
  removeSpawnImage,
  writeSpawnDockerfile,
} from "../spawn/snapshot-build.js";
import { generateSpawnId, parkSpawnWorktree, removeSpawnWorktree } from "../brood/worktree.js";
import {
  readSpawnRecordExtractionResult,
  loadSpawnRecord,
  markSpawnRecordFailed,
  markSpawnRecordRunning,
  markSpawnRecordStopped,
  SpawnRecordError,
  type ExtractionResult,
  updateSpawnRecordImageId,
  updateSpawnRecordExtractionResult,
  updateSpawnRecordPrompt,
  updateSpawnRecordAdmittedWork,
  updateSpawnRecordStewardSession,
  writeInitialSpawnRecord,
  type AdmittedWork,
} from "../brood/spawn-record.js";
import {
  type DispatchSpanHandle,
  startDispatchSpan,
  type DispatchTrace,
} from "../observability/spawn-trace.js";
import { emitSpawnLog } from "../observability/logs.js";
import {
  recordAgentFailure,
  recordSpawnRun,
  recordSpawnTokens,
  type SpawnFailureStage,
} from "../observability/spawn-metrics.js";
import { classifyAgentFailure, parseTokenUsage } from "../observability/agent-output.js";
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
import { BroodWorkspaceReclaimingError } from "../brood/service/client.js";
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
  /**
   * Per-profile worker toolchain override (issue #287). `auto`/undefined →
   * auto-detect the stack from the snapshot's marker files; an explicit value
   * (`jvm`, `node`) forces the toolchain layer image. Resolves the spawn's base
   * image to `f(agent, toolchain)` so non-node repos can build in-container.
   */
  readonly toolchain?: string;
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

export interface StewardHandoffInput {
  readonly spawnId: string;
  readonly backend: string;
  readonly patchText: string;
  readonly patchSha256: string;
  readonly touchedPaths: readonly string[];
  readonly extractedAt: string;
}

export type StewardHandoffEligibility =
  | {
      readonly eligible: true;
      readonly handoff: StewardHandoffInput;
    }
  | {
      readonly eligible: false;
      readonly reason: HandoffRefusalReason;
      readonly diagnostic: string;
      readonly failureReason?: string;
      readonly backend?: string;
      readonly extractedAt?: string;
    };

export type HandoffRefusalReason = "missing" | "failed" | "noop";

export interface PatchApplicationResult {
  readonly spawnId: string;
  readonly status: "applied" | "failed";
  readonly touchedPaths: string[];
  readonly diagnostic?: string;
  readonly appliedAt?: string;
}

export class StewardApplyError extends HatcherySpawnError {
  constructor(
    readonly application: PatchApplicationResult,
    readonly targetAuthorized: boolean,
  ) {
    super(application.diagnostic === "timeout"
      ? "Steward patch application timed out"
      : "git apply failed in manager worktree (" + application.diagnostic + ")");
    this.name = "StewardApplyError";
  }
}

export interface HatcherySpawnResult {
  readonly spawnId: string;
  readonly backend: string;
  readonly branch: string;
  readonly managerSession: AgentDeckManagerSession;
  readonly artifacts: HatcherySpawnArtifacts;
  readonly exitCode: number;
  readonly summary: string;
  readonly application: PatchApplicationResult;
  readonly commit: IntegrationCommit;
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
 * Whether a FAILED spawn should be PARKED (state preserved for forensics) rather
 * than destructively rolled back. Off by default; flipped on per deployment via
 * `MARCH_HATCHERY_PARK_FAILED` (any non-empty value). When on, the failed spawn's
 * worker container + image are kept and its manager worktree/branch are renamed
 * aside (see {@link parkSpawnWorktree}) so #460-class failures can be inspected,
 * while the canonical path/branch are freed so the loop's self-healing
 * re-dispatch starts clean. Each failure leaves one `parked/<spawnId>.json`.
 */
export function parkFailedSpawnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARCH_HATCHERY_PARK_FAILED || "").trim().length > 0;
}

/** Directory holding the forensic manifests for parked failed spawns (#460). */
export function parkedManifestDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".march", "hatchery", "parked");
}

/**
 * Write the forensic manifest for a parked failed spawn — the pointer record an
 * operator (or the follow-up investigation) reads to find everything the park
 * preserved: the kept worker container/image (by spawn id), the parked-aside
 * worktree + branch, the persisted patch/log artifacts, and the failure stage.
 * Best-effort; never throws (parking must not fail the rollback).
 */
export function writeParkedSpawnManifest(homeDir: string = os.homedir(), manifest: Record<string, unknown> = {}): string | null {
  try {
    const dir = parkedManifestDir(homeDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${manifest.spawnId}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    return file;
  } catch {
    return null;
  }
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
async function selfHealManagerLaunchCollision(input: {
  readonly repoPath: string;
  readonly spawnId: string;
  readonly branch: string;
  readonly sliceId: string;
  readonly dispatch: DispatchTrace;
}): Promise<SelfHealResult> {
  const orphanBranch = orphanManagerBranch(input.branch);
  return input.dispatch.spanAsync("spawn.self_heal", async (span) => {
    span.setAttributes({
      "march.slice_id": input.sliceId,
      "march.spawn_id": input.spawnId,
      "march.orphan_branch": orphanBranch,
    });
    const verdict = await classifyBranchSafety(input.repoPath, orphanBranch, undefined, input.sliceId);
    const worktreePath = findWorktreePathForBranch(input.repoPath, orphanBranch);
    let removed = false;
    span.setAttributes({
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
    return { orphanBranch, verdict, removed };
  });
}

/**
 * Resume a publication that failed after its focused commit was created. That
 * failure keeps the manager session, worktree, and branch, so a retry of the
 * same slice collides at `manager.launch`, and self-heal refuses to remove
 * the unmerged commit. Resumption needs the recorded checkout for the prior
 * spawn, still on its recorded branch, with an equivalent commit for that
 * spawn's persisted extraction at the tip, and the prior spawn must have been
 * admitted for the same slice, request, and backend as this dispatch, so a
 * different request that names the same branch never inherits another spawn's
 * publication. It then pushes that commit and hands
 * the prior Steward the review prompt without launching a replacement. Returns
 * undefined when the colliding branch is not a preserved publication.
 */
async function resumePreservedPublication(input: {
  readonly repoPath: string;
  readonly branch: string;
  readonly homeDir?: string;
  readonly prompt: string;
  readonly backend: string;
  readonly profile: string;
  readonly traceKey: string;
  readonly sliceId: string;
  readonly dispatch: DispatchTrace;
  readonly castra: CastraClient;
}): Promise<HatcherySpawnResult | undefined> {
  type Preserved = {
    readonly spawnId: string;
    readonly sessionId: string;
    readonly worktreePath: string;
    readonly target: AuthorizedStewardTarget;
    readonly handoff: StewardHandoffInput;
    readonly commit: IntegrationCommit;
  };
  if (!input.sliceId) return undefined;
  const expected = admittedWork(input.sliceId, input.prompt, input.backend);
  const sameWork = (recorded: AdmittedWork | undefined) =>
    !!recorded && recorded.sliceId === expected.sliceId &&
    recorded.promptSha256 === expected.promptSha256 && recorded.backend === expected.backend;
  const locate = (candidate: string): Preserved | undefined => {
    const worktreePath = findWorktreePathForBranch(input.repoPath, candidate);
    if (!worktreePath) return undefined;
    const body = stewardGit(input.repoPath, "show", "-s", "--format=%B", "refs/heads/" + candidate);
    const spawnId = /^March-Spawn-Id: (\d{8}-[0-9a-f]{6})$/m.exec(body)?.[1];
    if (!spawnId) return undefined;
    const record = loadSpawnRecord(spawnId, input.homeDir);
    if (!record || record.integrationBranch !== candidate || !record.stewardSessionId) return undefined;
    if (!sameWork(record.admittedWork)) return undefined;
    const eligibility = evaluateStewardHandoffEligibility({ spawnId, homeDir: input.homeDir });
    if (!eligibility.eligible) return undefined;
    const target = resolveStewardTarget({
      spawnId, repoPath: input.repoPath, managerWorktreePath: worktreePath, homeDir: input.homeDir,
    });
    const commit = findIntegrationCommit(target, eligibility.handoff);
    if (!commit) return undefined;
    return { spawnId, sessionId: record.stewardSessionId, worktreePath, target, handoff: eligibility.handoff, commit };
  };
  const candidates = [...new Set([orphanManagerBranch(input.branch), input.branch])];
  let preserved: Preserved | undefined;
  for (const candidate of candidates) {
    try {
      preserved = locate(candidate);
    } catch {
      preserved = undefined;
    }
    if (preserved) break;
  }
  if (!preserved) return undefined;
  const { spawnId, sessionId, worktreePath, target, handoff } = preserved;
  input.dispatch.setAttributes({ "march.resumed_spawn_id": spawnId });

  const commit = await input.dispatch.spanAsync("steward.push", async (span) => {
    span.setAttributes({
      "march.spawn_id": spawnId,
      "march.branch": preserved.commit.branch,
      "march.commit_sha": preserved.commit.commitSha,
      "march.resumed": true,
    });
    return pushIntegrationCommit(target, handoff, preserved.commit, { homeDir: input.homeDir, sliceId: input.sliceId });
  });

  const dir = hatcherySpawnLogDir(spawnId, input.homeDir);
  const artifacts: HatcherySpawnArtifacts = {
    dir,
    spawnOutputPath: path.join(dir, "spawn-output.log"),
    patchPath: path.join(dir, "patch.diff"),
    managerPromptPath: path.join(dir, "manager-prompt.md"),
    metadataPath: path.join(dir, "metadata.json"),
  };
  const managerPrompt = buildManagerPrompt({
    commit,
    operatorPrompt: input.prompt,
    patchPath: artifacts.patchPath,
    spawnOutputPath: artifacts.spawnOutputPath,
    metadataPath: artifacts.metadataPath,
  });
  // The push is done; a prompt-write failure belongs to the handoff, so it
  // errors the steward.send span rather than steward.push.
  await input.dispatch.spanAsync("steward.send", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(artifacts.managerPromptPath, managerPrompt, "utf8");
    return sendPromptToAgentDeckManager(
      { sessionId, prompt: managerPrompt, profile: input.profile, traceKey: input.traceKey },
      input.castra,
    );
  });
  let metadata: { managerSession?: Partial<AgentDeckManagerSession>; exitCode?: unknown } = {};
  try {
    metadata = JSON.parse(fs.readFileSync(artifacts.metadataPath, "utf8"));
  } catch {
    // The recorded session and checkout below are authoritative.
  }
  const managerSession: AgentDeckManagerSession = {
    sessionId,
    title: metadata.managerSession?.title ?? "",
    group: metadata.managerSession?.group ?? "",
    branch: metadata.managerSession?.branch ?? input.branch,
    worktreePath,
  };
  return {
    spawnId,
    backend: input.backend,
    branch: input.branch,
    managerSession,
    artifacts,
    application: {
      spawnId,
      status: "applied",
      touchedPaths: [...new Set(handoff.touchedPaths)].sort(),
      appliedAt: preserved.commit.committedAt,
    },
    commit,
    exitCode: typeof metadata.exitCode === "number" ? metadata.exitCode : 0,
    summary: [
      `Hatchery resumed publication for spawn ${spawnId} and handed off to manager session ${sessionId}.`,
      `Branch: ${input.branch}`,
      `Worktree: ${worktreePath}`,
      `Patch: ${artifacts.patchPath}`,
      `Logs: ${artifacts.spawnOutputPath}`,
    ].join("\n"),
  };
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

const GIT_QUOTE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
};

/**
 * Decode a Git C-style quoted path (`"caf\303\251.txt"`, the default
 * `core.quotePath` form for non-ASCII or special characters). Octal escapes
 * are raw bytes, so the result is decoded as UTF-8. Returns null when the
 * token is not a well-formed quoted string.
 */
function decodeGitQuotedPath(token: string): string | null {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return null;
  const bytes: number[] = [];
  const body = token.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    // Read whole code points: with core.quotePath=false a literal supplementary
    // character (e.g. an emoji) sits beside escapes, and encoding its UTF-16
    // surrogates separately would corrupt it (#735 review).
    const ch = String.fromCodePoint(body.codePointAt(i)!);
    if (ch === '"') return null;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf-8"));
      i += ch.length - 1;
      continue;
    }
    const next = body[++i];
    if (next === undefined) return null;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else if (next in GIT_QUOTE_ESCAPES) {
      bytes.push(GIT_QUOTE_ESCAPES[next]);
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

/** Strip a required `a/` or `b/` prefix from a (decoded) header path. */
function stripDiffPrefix(path: string, prefix: "a/" | "b/"): string | null {
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Length of a leading quoted token in `s` (including both quotes), or -1. */
function quotedTokenLength(s: string): number {
  if (!s.startsWith('"')) return -1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  return -1;
}

interface PatchFileOp {
  readonly oldPath: string;
  readonly newPath: string;
  /** The block carries `copy from`/`copy to`: the old path is left unchanged. */
  readonly copy: boolean;
}

/**
 * Old/new paths from every `diff --git` header, decoding Git's quoted form so
 * filenames such as `café.txt` match the names `git diff --cached -z` stages.
 * Handles either side being quoted independently (#735 review).
 */
function patchFileOps(patch: string): PatchFileOp[] {
  const ops: PatchFileOp[] = [];
  const headerRe = /^diff --git (.+)$/gm;
  const headers = [...patch.matchAll(headerRe)];
  for (const [index, match] of headers.entries()) {
    const blockEnd = headers[index + 1]?.index ?? patch.length;
    const block = patch.slice(match.index, blockEnd);
    const rest = match[1];
    let oldRaw: string | null = null;
    let newRaw: string | null = null;
    const qa = quotedTokenLength(rest);
    if (qa > 0) {
      oldRaw = decodeGitQuotedPath(rest.slice(0, qa));
      const tail = rest.slice(qa);
      if (tail.startsWith(" ")) {
        const b = tail.slice(1);
        newRaw = b.startsWith('"') ? decodeGitQuotedPath(b) : b;
      }
    } else if (rest.endsWith('"')) {
      const split = rest.lastIndexOf(' "b/');
      if (split > 0) {
        oldRaw = rest.slice(0, split);
        newRaw = decodeGitQuotedPath(rest.slice(split + 1));
      }
    } else {
      const plain = /^(a\/.+?) (b\/.+)$/.exec(rest);
      if (plain) {
        oldRaw = plain[1];
        newRaw = plain[2];
      }
    }
    const oldPath = oldRaw === null ? null : stripDiffPrefix(oldRaw, "a/");
    const newPath = newRaw === null ? null : stripDiffPrefix(newRaw, "b/");
    if (oldPath === null || newPath === null) {
      throw new HatcherySpawnError(
        "Spawn patch has an unparseable `diff --git` header; refusing to apply.",
      );
    }
    ops.push({ oldPath, newPath, copy: /^copy from /m.test(block) });
  }
  return ops;
}

function patchHeaderPaths(patch: string): string[] {
  return patchFileOps(patch).flatMap((op) => [op.oldPath, op.newPath]);
}

function patchTouchedPaths(patch: string): string[] {
  return [...new Set(patchHeaderPaths(patch))].sort();
}

/**
 * Copy sources that `git apply --index` leaves unstaged: a copy stages only its
 * destination, while a rename (with `--no-renames`) stages both sides. A path
 * that is also modified by another block still counts as staged (#735 review).
 */
function patchUnstagedCopySources(patch: string): Set<string> {
  const ops = patchFileOps(patch);
  const changed = new Set(ops.flatMap((op) => (op.copy ? [op.newPath] : [op.oldPath, op.newPath])));
  return new Set(ops.filter((op) => op.copy && !changed.has(op.oldPath)).map((op) => op.oldPath));
}

/**
 * A `git diff` that carries only a `diff --git` header — no hunk and no
 * file-operation metadata — touches a path in name only: there is no content,
 * mode, rename, or create/delete change to apply. `patchTouchedPaths` still
 * reports such a header, so the no-op guard cannot rely on `touchedPaths`
 * alone (#350 review). Require at least one real change marker.
 */
function patchHasRealChange(patch: string): boolean {
  return (
    /^@@ /m.test(patch) ||
    /^(new file mode|deleted file mode|rename (from|to)|copy (from|to)|old mode|new mode) /m.test(
      patch,
    )
  );
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
  for (const candidate of patchHeaderPaths(patch)) {
    if (candidate.startsWith("/") || candidate.split("/").includes("..")) {
      throw new HatcherySpawnError(
        `Spawn patch references an unsafe path "${candidate}" ` +
          "(absolute or parent-directory escape); refusing to apply.",
      );
    }
  }
}

function extractionFailureResult(input: {
  readonly spawnId: string;
  readonly backend: string;
  readonly failureReason: string;
  readonly diagnostic: string;
}): ExtractionResult {
  return {
    spawnId: input.spawnId,
    backend: input.backend,
    status: "failed",
    failureReason: input.failureReason,
    diagnostic: input.diagnostic.slice(0, 2048),
    extractedAt: new Date().toISOString(),
  };
}

function extractionSuccessResult(input: {
  readonly spawnId: string;
  readonly backend: string;
  readonly patchText: string;
}): ExtractionResult {
  return {
    spawnId: input.spawnId,
    backend: input.backend,
    status: "succeeded",
    patch: {
      spawnId: input.spawnId,
      backend: input.backend,
      patchText: input.patchText,
      touchedPaths: patchTouchedPaths(input.patchText),
      sha256: cryptoHash(input.patchText),
    },
    extractedAt: new Date().toISOString(),
  };
}

/** The identity a dispatch must share with a spawn to resume its publication. */
function admittedWork(sliceId: string, prompt: string, backend: string): AdmittedWork {
  return { sliceId, promptSha256: cryptoHash(prompt), backend };
}

function cryptoHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function refusal(
  reason: HandoffRefusalReason,
  diagnostic: string,
  extras?: Omit<Extract<StewardHandoffEligibility, { eligible: false }>, "eligible" | "reason" | "diagnostic">,
): StewardHandoffEligibility {
  return { eligible: false, reason, diagnostic, ...extras };
}

function setEligibilitySpanAttributes(
  span: DispatchSpanHandle,
  input: {
    readonly spawnId: string;
    readonly result?: ExtractionResult;
    readonly eligible: boolean;
    readonly reason: "ready" | "missing" | "failed" | "noop";
  },
): void {
  span.setAttributes({
    "march.spawn_id": input.spawnId,
    "march.handoff.eligible": input.eligible,
    "march.handoff.reason": input.reason,
    "march.extraction.status": input.result?.status ?? "missing",
    "march.backend": input.result?.backend ?? "",
  });
}

export function evaluateStewardHandoffEligibility(input: {
  readonly spawnId: string;
  readonly homeDir?: string;
  readonly dispatch?: DispatchTrace;
  readonly readExtractionResult?: (
    spawnId: string,
    homeDir?: string,
  ) => ExtractionResult | undefined;
}): StewardHandoffEligibility {
  const readResult =
    input.readExtractionResult ?? readSpawnRecordExtractionResult;
  const safeReadResult = () => {
    try {
      return readResult(input.spawnId, input.homeDir);
    } catch {
      return undefined;
    }
  };
  try {
    return (input.dispatch ?? NOOP_DISPATCH_TRACE).span(
      "steward.handoff_eligibility",
      (span) => {
        const result = safeReadResult();
        if (!result) {
          setEligibilitySpanAttributes(span, {
            spawnId: input.spawnId,
            result,
            eligible: false,
            reason: "missing",
          });
          throw new HatcherySpawnError(
            `Spawn ${input.spawnId} is not eligible for Steward handoff: extraction result is missing.`,
          );
        }
        if (result.status === "failed") {
          setEligibilitySpanAttributes(span, {
            spawnId: input.spawnId,
            result,
            eligible: false,
            reason: "failed",
          });
          throw new HatcherySpawnError(
            `Spawn ${input.spawnId} is not eligible for Steward handoff: extraction failed (${result.failureReason}).`,
          );
        }
        if (
          result.patch.patchText.trim().length === 0 ||
          result.patch.touchedPaths.length === 0 ||
          !result.patch.patchText.includes("diff --git ") ||
          !patchHasRealChange(result.patch.patchText)
        ) {
          setEligibilitySpanAttributes(span, {
            spawnId: input.spawnId,
            result,
            eligible: false,
            reason: "noop",
          });
          throw new HatcherySpawnError(
            `Spawn ${input.spawnId} is not eligible for Steward handoff: validated patch is empty or no-op.`,
          );
        }

        setEligibilitySpanAttributes(span, {
          spawnId: input.spawnId,
          result,
          eligible: true,
          reason: "ready",
        });
        return {
          eligible: true,
          handoff: {
            spawnId: result.spawnId,
            backend: result.backend,
            patchText: result.patch.patchText,
            patchSha256: result.patch.sha256,
            touchedPaths: result.patch.touchedPaths,
            extractedAt: result.extractedAt,
          },
        };
      },
    );
  } catch {
    const result = safeReadResult();
    if (!result) {
      return refusal(
        "missing",
        `Spawn ${input.spawnId} is not eligible for Steward handoff: extraction result is missing.`,
      );
    }
    if (result.status === "failed") {
      const diagnostic = result.diagnostic
        ? `Spawn ${input.spawnId} is not eligible for Steward handoff: extraction failed (${result.failureReason}). ${result.diagnostic}`
        : `Spawn ${input.spawnId} is not eligible for Steward handoff: extraction failed (${result.failureReason}).`;
      return refusal(
        "failed",
        diagnostic,
        {
          failureReason: result.failureReason,
          backend: result.backend,
          extractedAt: result.extractedAt,
        },
      );
    }
    return refusal(
      "noop",
      `Spawn ${input.spawnId} is not eligible for Steward handoff: validated patch is empty or no-op.`,
      {
        backend: result.backend,
        extractedAt: result.extractedAt,
      },
    );
  }
}

const NOOP_DISPATCH_TRACE: DispatchTrace = {
  enabled: false,
  spanContext: () => undefined,
  span: (_name, fn) => fn({ setAttributes: () => {}, setError: () => {}, spanContext: () => undefined }),
  spanAsync: (_name, fn) => fn({ setAttributes: () => {}, setError: () => {}, spanContext: () => undefined }),
  setAttributes: () => {},
  recordException: () => {},
  traceparent: () => undefined,
  end: () => {},
};

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
  readonly commit?: IntegrationCommit;
}): string {
  const artifactGuidance =
    input.patchPath || input.metadataPath || input.spawnOutputPath
      ? [
          "Validated handoff artifacts:",
          input.patchPath
            ? `- Patch input: ${input.patchPath} (validated ExtractionResult.patch.patchText; already published).`
            : "- Patch input: published from validated ExtractionResult.patch.patchText.",
          input.metadataPath
            ? `- Handoff metadata: ${input.metadataPath} (spawn id, backend, touched paths, digest, extraction timestamp).`
            : "- Handoff metadata: recorded with spawn artifacts.",
          input.spawnOutputPath
            ? `- Diagnostic log: ${input.spawnOutputPath} (bounded review context only; do not use it as patch input).`
            : "- Diagnostic log: bounded review context only; do not use raw backend output as patch input.",
          "",
        ]
      : [];
  return [
    "You are the March Hatchery management session for a completed spawn.",
    "",
    "Review the published commit, then open a PR.",
    ...(input.commit ? [`Published commit: ${input.commit.commitSha} on ${input.commit.branch}.`] : []),
    "",
    `Original request:\n${input.operatorPrompt.trimEnd()}`,
    "",
    ...artifactGuidance,
    "Complete all review and PR steps in this turn.",
    ...(input.commit
      ? [`1. Review the published commit (\`git show ${input.commit.commitSha}\`), which Hatchery`,
        "   verified against the published branch. Inspect its diff for correctness and security."]
      : ["1. Review the local HEAD commit, which Hatchery verified against the published branch.",
        "   Inspect its diff for correctness and security."]),
    "2. Run the smallest meaningful verification for the touched code.",
    "3. Confirm every acceptance criterion is satisfied and every matching tasks.md row",
    "   changed from `[ ]` to `[x]` in the published commit.",
    "4. If corrections are needed, report NEED: <problem> — <next action> and stop.",
    "   Leave the published commit and branch intact. Do not edit, commit, or push.",
    "5. Open the PR for the exact published branch (pass it to `gh pr create --head`)",
    "   using the `march-steward:steward-pr` skill.",
    "6. Report the PR URL on the final line as `PR: <url>`. Escalate failures via NEED:.",
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
  readonly repoPath?: string;
}): PatchApplyStrategy {
  // Pre-check cwd existence so we don't surface Node's misleading
  // "spawnSync git ENOENT" — which happens when execFileSync can't chdir
  // to the manager worktree, and looks identical to "git is not
  // installed." The race in launchAgentDeckManager used to produce this
  // error every time a concurrent dispatch attached to the wrong session;
  // even after the race fix, surfacing a clear message keeps future
  // failures debuggable.
  const worktreePath = input.worktreePath.trim();
  if (worktreePath.length === 0) {
    throw new HatcherySpawnError(
      "git apply --index aborted: manager worktree path is empty.",
    );
  }
  if (!fs.existsSync(worktreePath)) {
    throw new HatcherySpawnError(
      `git apply --index aborted: manager worktree not found at ${worktreePath}. ` +
        `This usually means launchAgentDeckManager attached to the wrong session (race) ` +
        `or the worktree was removed between launch and patch-apply.`,
    );
  }
  const repoPath = input.repoPath?.trim();
  if (repoPath) {
    // Refuse to apply into the operator checkout. An exact `path.resolve`
    // comparison is too weak (#389 review): a symlinked operator checkout
    // (common with mounted volumes) or a path *inside* the checkout (a
    // subdirectory) both compare unequal and slip past. Collapse the worktree
    // to its git top-level so a subdirectory maps back to the checkout root,
    // and realpath both sides so symlinks can't disguise the same directory.
    const worktreeTop = worktreeGitToplevel(worktreePath) ?? worktreePath;
    if (realPath(worktreeTop) === realPath(repoPath)) {
      throw new HatcherySpawnError(
        `git apply --index aborted: refusing to apply Steward handoff patch in the operator checkout at ${worktreePath}. ` +
          `Expected a manager or spawn worktree branch.`,
      );
    }
  }
  assertBranchOwnedWorktree(worktreePath);
  return applyWithFallback(worktreePath, input.patchPath);
}

function applyWithFallback(worktreePath: string, patchPath: string, patchText?: string): PatchApplyStrategy {
  try {
    runGitApply(["apply", "--index", patchPath], worktreePath, patchText);
    return "index";
  } catch (errIndex) {
    if (gitTimedOut(errIndex)) throw errIndex;
    const stderrIndex = stderrText((errIndex as { stderr?: unknown }).stderr);
    // Defensive fallback (#244): a 3-way merge can resolve a patch whose base
    // context drifted (e.g. a "new file" the worktree base already has). It
    // never silently masks a real conflict — that still throws below.
    try {
      runGitApply(["apply", "--index", "--3way", patchPath], worktreePath, patchText);
      return "index-3way";
    } catch (err3way) {
      if (gitTimedOut(err3way)) throw err3way;
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

/**
 * Canonicalize a path, resolving symlinks. Falls back to `path.resolve` when the
 * target can't be stat'd (e.g. it was removed between checks) so the caller still
 * gets a comparable absolute path rather than a throw.
 */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The git checkout root (`git rev-parse --show-toplevel`) for `cwd`, or undefined
 * when `cwd` isn't inside a git worktree. A subdirectory of a checkout collapses
 * to the checkout root, so it can be compared against the operator repo path.
 */
function worktreeGitToplevel(cwd: string): string | undefined {
  try {
    return runGitCapture(["rev-parse", "--show-toplevel"], cwd) || undefined;
  } catch {
    return undefined;
  }
}

function assertBranchOwnedWorktree(worktreePath: string): void {
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
      env: hatcheryGitEnv(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    }).trim();
  } catch (err) {
    throw new HatcherySpawnError(
      `git apply --index aborted: manager worktree at ${worktreePath} is not a readable git worktree. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!branch || branch === "HEAD") {
    throw new HatcherySpawnError(
      `git apply --index aborted: manager worktree at ${worktreePath} is not on a branch-owned checkout.`,
    );
  }
}

function gitTimedOut(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ETIMEDOUT";
}

function runGitApply(args: string[], cwd: string, input?: string): void {
  execFileSync("git", args, {
    cwd,
    env: { ...hatcheryGitEnv(), LC_ALL: "C" },
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
}

function stewardGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: hatcheryGitEnv(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
}

function integrationBranchForManager(worktreePath: string, dispatchBranch: string): string {
  const agentDeckBranch = orphanManagerBranch(dispatchBranch);
  try {
    // Castra can report a symbolic launch name even when agent-deck used its
    // feature/ prefix. Record the exact ref from the requested branch family.
    const ref = stewardGit(worktreePath, "symbolic-ref", "--quiet", "HEAD").trimEnd();
    if (ref === "refs/heads/" + dispatchBranch) return dispatchBranch;
  } catch {
    // Authorization reports an unavailable or detached checkout if it persists.
  }
  return agentDeckBranch;
}

interface StewardTarget {
  readonly spawnId: string;
  readonly repoPath: string;
  readonly managerWorktreePath: string;
  readonly homeDir?: string;
}

function targetFailureReason(error: unknown): string {
  if (error instanceof SpawnRecordError) return "missing_lifecycle_state";
  if (gitTimedOut(error)) return "timeout";
  return "integration_target_unavailable";
}

interface AuthorizedStewardTarget {
  readonly target: string;
  readonly branchRef: string;
}

function stewardHeadRef(target: string): string {
  return stewardGit(target, "symbolic-ref", "--quiet", "HEAD").trimEnd();
}

function resolveStewardTarget(input: StewardTarget): AuthorizedStewardTarget {
  const record = loadSpawnRecord(input.spawnId, input.homeDir);
  if (!record || record.id !== input.spawnId) throw new SpawnRecordError("missing_lifecycle_state");
  if (!record.repoPath || !record.worktreePath || !record.integrationBranch) {
    throw new Error("integration_target_unavailable");
  }
  return authorizeLinkedCheckout(input, {
    repoPath: record.repoPath,
    worktreePath: record.worktreePath,
    integrationBranch: record.integrationBranch,
  });
}

/**
 * The checkout must be a linked worktree (never the operator checkout) of the
 * requested repository, at the manager path, with the exact branch checked out.
 */
function authorizeLinkedCheckout(
  input: StewardTarget,
  record: { readonly repoPath: string; readonly worktreePath: string; readonly integrationBranch: string },
): AuthorizedStewardTarget {
  const gitPath = (cwd: string, flag: string) =>
    fs.realpathSync(stewardGit(cwd, "rev-parse", "--path-format=absolute", flag).replace(/\n$/, ""));
  const repo = gitPath(record.repoPath, "--show-toplevel");
  const target = fs.realpathSync(record.worktreePath);
  const commonDir = gitPath(repo, "--git-common-dir");
  if (
    repo !== gitPath(input.repoPath, "--show-toplevel") ||
    target === repo ||
    target !== gitPath(target, "--show-toplevel") ||
    target !== fs.realpathSync(input.managerWorktreePath) ||
    gitPath(target, "--git-common-dir") !== commonDir ||
    gitPath(target, "--git-dir") === commonDir ||
    stewardHeadRef(target) !== "refs/heads/" + record.integrationBranch
  ) {
    throw new Error("integration_target_unavailable");
  }
  stewardGit(target, "rev-parse", "--verify", "HEAD^{commit}");
  return { target, branchRef: "refs/heads/" + record.integrationBranch };
}

function canAuthorizeRollback(
  target: StewardTarget | undefined,
  integrationBranch: string,
): boolean {
  if (!target) return false;
  try {
    if (loadSpawnRecord(target.spawnId, target.homeDir)) {
      resolveStewardTarget(target);
    } else {
      // No lifecycle record was written (e.g. record_init failed): authorize the
      // values that would have been recorded, with the same checkout checks.
      authorizeLinkedCheckout(target, {
        repoPath: target.repoPath,
        worktreePath: target.managerWorktreePath,
        integrationBranch,
      });
    }
    return true;
  } catch {
    return false;
  }
}

function applyStewardHandoff(input: StewardTarget & {
  readonly handoff: StewardHandoffInput;
  readonly span: DispatchSpanHandle;
}): PatchApplicationResult {
  const { spawnId, handoff, span } = input;
  const touchedPaths = [...new Set(handoff.touchedPaths)].sort();
  let targetAuthorized = false;
  const fail = (diagnostic: string) =>
    new StewardApplyError({ spawnId, status: "failed", touchedPaths, diagnostic }, targetAuthorized);

  try {
    const { target, branchRef } = resolveStewardTarget(input);
    if (handoff.spawnId !== spawnId) throw fail("patch_apply_failed");
    const expectedStaged = touchedPaths.filter((name) => !patchUnstagedCopySources(handoff.patchText).has(name));
    const assertOnBranch = () => {
      // Another process could switch this clean worktree between authorization,
      // application, and the Steward handoff (#735 review). A switched checkout
      // is no longer the authorized target, so rollback must not touch it.
      if (stewardHeadRef(target) !== branchRef) {
        targetAuthorized = false;
        throw fail("integration_target_unavailable");
      }
    };

    targetAuthorized = true;
    const staged = () => stewardGit(target, "diff", "--cached", "--name-only", "--no-renames", "--ignore-submodules=none", "-z")
      .split("\0").filter(Boolean).sort();
    if (staged().length) throw fail("staged_paths_mismatch");

    let strategy: PatchApplyStrategy;
    assertOnBranch();
    try {
      strategy = applyWithFallback(target, "-", handoff.patchText);
    } catch (error) {
      // Git diagnostics can include private paths and content. Expose a fixed reason.
      if (error instanceof PatchApplyError &&
          /patch does not apply|patch failed|already exists|with conflicts|does not match index/i.test(error.stderr)) {
        throw fail("patch_conflict");
      }
      throw error;
    }
    span.setAttributes({ "march.patch.strategy": strategy });
    const paths = staged();
    if (!paths.length) throw fail("empty_staged_diff");
    if (paths.length !== expectedStaged.length || paths.some((name, i) => name !== expectedStaged[i])) {
      throw fail("staged_paths_mismatch");
    }
    assertOnBranch();

    return { spawnId, status: "applied", touchedPaths, appliedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof StewardApplyError) throw error;
    throw fail(targetAuthorized && !gitTimedOut(error) ? "patch_apply_failed" : targetFailureReason(error));
  }
}

/** Run a git command for its side effect, discarding stdout. */
function runGitQuiet(args: readonly string[], cwd: string): void {
  execFileSync("git", args as string[], {
    cwd,
    env: hatcheryGitEnv(),
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
}

/** Run a git command and return its trimmed stdout. */
function runGitCapture(args: readonly string[], cwd: string): string {
  return execFileSync("git", args as string[], {
    cwd,
    env: hatcheryGitEnv(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
    timeout: 5_000,
    killSignal: "SIGKILL",
  }).trim();
}

/**
 * True iff `ancestor` is an ancestor of (or identical to) `descendant`.
 * `git merge-base --is-ancestor` exits 0 when true, 1 when false, and non-0/1
 * on error (e.g. either ref is missing) — all non-zero exits surface as a throw,
 * which we treat as "not a safe fast-forward".
 */
function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      env: hatcheryGitEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a repo's default branch (e.g. `main` / `master`) from
 * `refs/remotes/origin/HEAD`, falling back to `main` when `origin/HEAD` is not
 * set locally. Exposed for tests.
 */
export function resolveDefaultBranch(worktreePath: string): string {
  // origin/HEAD unset (e.g. a worktree whose remote HEAD was never fetched) —
  // fall through to the conventional default.
  return readOriginHead(worktreePath) ?? "main";
}

function readOriginHead(worktreePath: string): string | undefined {
  try {
    const ref = runGitCapture(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      worktreePath,
    );
    return ref.replace(/^origin\//, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pin a freshly-created manager worktree to the up-to-date default branch so the
 * worker's snapshot base — and the apply target, which is this same worktree —
 * contain already-merged files (#460).
 *
 * Without this, agent-deck cuts the worktree from whatever stale local base it
 * chose and never fetches; when that base predates a merge that *created* a
 * file, the worker can't see it, authors it from scratch, and the resulting
 * `new file` patch is rejected at apply time ("already exists in index") — a
 * conflict `--3way` cannot resolve — stranding the slice after the recovery
 * budget is spent.
 *
 * Safe to hard-reset because the manager branch has no commits yet (the worker
 * runs against a container snapshot, not this worktree). GitHub origins use
 * a repository-scoped Tessera entitlement over HTTPS.
 *
 * The reset is **fast-forward-only**: it pins to `origin/<default>` ONLY when
 * that ref is at least as new as the worktree's current HEAD (HEAD is an
 * ancestor of it). A divergent or locally-ahead base — or a failed fetch that
 * left a stale tracking ref behind HEAD — is left untouched and reported
 * `pinned: false`, so the pin never *regresses* the base below agent-deck's
 * original (review on #460). Returns the resolved default branch for telemetry.
 * Exposed for tests.
 */
export interface PinBaseResult {
  /** The resolved default branch (`main` / `master`). */
  readonly defaultBranch: string;
  /** Whether the origin fetch succeeded this run. */
  readonly fetched: boolean;
  /** Whether the worktree was hard-reset onto `origin/<default>`. */
  readonly pinned: boolean;
}

export async function pinManagerWorktreeToDefaultBranch(
  worktreePath: string,
  sliceId?: string,
  authorizeWrite?: () => void,
): Promise<PinBaseResult> {
  if (!fs.existsSync(worktreePath)) {
    return { defaultBranch: resolveDefaultBranch(worktreePath), fetched: false, pinned: false };
  }
  const origin = await resolveHatcheryOrigin(worktreePath);
  if (origin) authorizeWrite?.();
  // For a GitHub origin, ask GitHub through the same scope: a local origin/HEAD
  // is not refreshed by `git fetch` and can still name a renamed/deleted branch,
  // and guessing `main` without one would fail the fetch the same way.
  const defaultBranch = origin?.repo
    ? await readHatcheryGitHubDefaultBranch(origin.repo, sliceId)
    : readOriginHead(worktreePath) ?? "main";
  let fetched = false;
  if (origin) {
    const result = await runHatcheryNetworkGit(
      worktreePath, origin, ["fetch", "--no-recurse-submodules", "--no-auto-maintenance", "--"],
      ["+refs/heads/" + defaultBranch + ":refs/remotes/origin/" + defaultBranch],
      sliceId,
    );
    fetched = result === 0;
    if (!fetched && origin.repo) throw new HatcheryGitHubError("fetch_failed");
  }
  let tip: string | undefined;
  try {
    // Resolve once so another job cannot move the tracking ref between the
    // ancestry check and reset.
    const candidate = runGitCapture(
      ["rev-parse", "--verify", "refs/remotes/origin/" + defaultBranch + "^{commit}"],
      worktreePath,
    );
    if (isAncestor("HEAD", candidate, worktreePath)) tip = candidate;
  } catch {
    // Preserve the original base if there is no tracking ref or reset fails.
  }
  let pinned = false;
  if (tip) {
    authorizeWrite?.();
    try {
      runGitQuiet(["reset", "--hard", tip], worktreePath);
      pinned = true;
    } catch {
      // Preserve the original base if the reset fails.
    }
  }
  return { defaultBranch, fetched, pinned };
}

export function validateHatcherySpawnBackend(backend: SpawnBackend): void {
  const missingEnvVars = missingRequiredEnvVars(backend);
  const missingMounts = missingCredentialMounts(backend);
  if (missingEnvVars.length > 0 || missingMounts.length > 0) {
    throw new HatcherySpawnError(
      formatMissingBackendAuthError(backend, missingEnvVars, missingMounts),
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
  let integrationBranch = orphanManagerBranch(branch);
  // Rollback writes Git state in the manager worktree, so it only runs once the
  // recorded target is authorized at rollback time (#735 review).
  let integrationCommit: IntegrationCommit | undefined;
  let stewardTarget: StewardTarget | undefined;
  let containerId: string | undefined;
  let logs = "";
  let handedOff = false;
  // Set once the image build starts; before that there is no image to remove.
  let imageBuildStarted = false;
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

    integrationBranch = integrationBranchForManager(manager.worktreePath, branch);
    // Set before the record write so a failed write can still authorize rollback.
    const recordedTarget: StewardTarget = {
      spawnId, repoPath: input.repoPath, managerWorktreePath: manager.worktreePath, homeDir: input.homeDir,
    };
    stewardTarget = recordedTarget;
    writeInitialSpawnRecord({
      id: spawnId,
      repoPath: input.repoPath,
      branch,
      integrationBranch,
      worktreePath: manager.worktreePath,
      backend: input.backend.name,
    }, input.homeDir);
    updateSpawnRecordPrompt(spawnId, spawnPrompt, input.homeDir);
    updateSpawnRecordAdmittedWork(spawnId, admittedWork(sliceId, input.prompt, input.backend.name), input.homeDir);
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
    // fails the dispatch. The onSucceeded hook later enriches this row. The
    // exception is Brood refusing the row because it is reclaiming this group's
    // workspace: that throws, and the rollback below removes the steward session
    // and worktree instead of leaving it running unregistered (#717 review).
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

    // Pin the worker's base to the up-to-date default branch (#460). agent-deck
    // cut this worktree from a stale local base and never fetched; pinning it to
    // origin/<default> NOW — before the snapshot the worker diffs against AND
    // before the apply that targets this same worktree — makes the worker edit
    // already-merged files instead of re-creating them and colliding at apply.
    // Runs after brood.register so a pin failure (e.g. Tessera outage) still
    // leaves a Brood row that can drive steward teardown.
    stage = "pin_base";
    await dispatch.spanAsync("manager.pin_base", async (pinSpan) => {
      pinSpan.setAttributes({ "march.worktree": managerWorktree });
      const pin = await pinManagerWorktreeToDefaultBranch(managerWorktree, sliceId, () => {
        try {
          resolveStewardTarget(recordedTarget);
        } catch (error) {
          throw new StewardApplyError({
            spawnId, status: "failed", touchedPaths: [],
            diagnostic: targetFailureReason(error),
          }, false);
        }
      });
      pinSpan.setAttributes({
        "march.default_branch": pin.defaultBranch,
        "march.pin_base.fetched": pin.fetched,
        "march.pin_base.pinned": pin.pinned,
      });
    });

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
    imageBuildStarted = true;
    dispatch.span("image.build", (buildSpan) => {
      const handle = createBuildContext(managerWorktree);
      try {
        // Pick the toolchain layer image for this (agent, repo): an explicit
        // profile override wins, else auto-detect from the snapshot's marker
        // files. Node repos resolve to the unchanged base image (no layer), so
        // this is a no-op for today's node-only flow. The snapshot already
        // mirrors the worktree's tracked files, so detect against it.
        const resolvedToolchain = resolveToolchain(
          input.toolchain,
          handle.contextPath,
        );
        const baseImage = resolveToolchainImage(
          input.backend.baseImage,
          resolvedToolchain.toolchain,
        );
        buildSpan.setAttributes({
          "march.toolchain": resolvedToolchain.toolchain,
          "march.toolchain.source": resolvedToolchain.source,
        });
        const dockerfilePath = writeSpawnDockerfile(
          handle.contextPath,
          baseImage,
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
    // Agent-level failure detection runs BEFORE the exit-code gate: the codex
    // CLI exits 0 even on `turn.failed` (an expired OAuth token makes the
    // *process* succeed while the turn failed with "refresh token already
    // used"). Keying off the exit code alone would miss that and let the spawn
    // fall through to a confusing patch-extraction failure. Scanning the logs
    // regardless of exit code makes the auth / rate-limit / timeout case a
    // first-class alarm (march_spawn_agent_failures_total{reason}) and stamps
    // the reason into the dispatch detail so the legate's circuit-breaker can
    // read it. A clean run classifies as "none" and falls through.
    const agentFailureReason = classifyAgentFailure(logs);
    if (agentFailureReason !== "none") {
      const managerPrompt = buildManagerPrompt({
        operatorPrompt: input.prompt,
      });
      const artifacts = createHatcherySpawnArtifacts({
        spawnId,
        homeDir: input.homeDir,
        spawnOutput: logs,
        patch: "",
        managerPrompt,
        metadata: metadataFor(input, manager, spawnId, branch, waitResult.exitCode, startedAt),
      });
      recordAgentFailure({ backend: input.backend.name, profile, reason: agentFailureReason });
      dispatch.setAttributes({ "march.agent_failure_reason": agentFailureReason });
      throw new HatcherySpawnError(
        `Spawn ${spawnId} agent failure (exit ${waitResult.exitCode}); manager prompt was not sent. ` +
          `[agent_failure_reason=${agentFailureReason}] Logs: ${artifacts.spawnOutputPath}`,
      );
    }

    if (waitResult.exitCode !== 0) {
      const managerPrompt = buildManagerPrompt({
        operatorPrompt: input.prompt,
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

    // Record token usage of the completed turn (codex emits it on the final
    // `turn.completed` line) before moving on to patch extraction.
    const tokenUsage = parseTokenUsage(logs);
    if (tokenUsage) {
      recordSpawnTokens({ backend: input.backend.name, profile, taskType, usage: tokenUsage });
    }

    // Patch extraction persists the backend-neutral result. Handoff eligibility
    // below consumes that persisted contract instead of scraping logs again.
    stage = "patch_extract";
    try {
      const patch = extractPatchFromSpawnOutput(logs);
      updateSpawnRecordExtractionResult(
        spawnId,
        extractionSuccessResult({
          spawnId,
          backend: input.backend.name,
          patchText: patch,
        }),
        input.homeDir,
      );
    } catch (err) {
      const managerPrompt = buildManagerPrompt({
        operatorPrompt: input.prompt,
      });
      const artifacts = createHatcherySpawnArtifacts({
        spawnId,
        homeDir: input.homeDir,
        spawnOutput: logs,
        patch: "",
        managerPrompt,
        metadata: metadataFor(input, manager, spawnId, branch, waitResult.exitCode, startedAt),
      });
      updateSpawnRecordExtractionResult(
        spawnId,
        extractionFailureResult({
          spawnId,
          backend: input.backend.name,
          failureReason: "patch_extraction_failed",
          diagnostic: (err as Error).message,
        }),
        input.homeDir,
      );
      // Emit the errored eligibility span so the refused handoff stays visible
      // in the trace, then fail at the patch_extract stage (don't let the
      // failure stage drift to handoff_eligibility) with the artifacts pointer
      // restored to the terminal diagnostic (#350 review).
      evaluateStewardHandoffEligibility({
        spawnId,
        homeDir: input.homeDir,
        dispatch,
      });
      throw new HatcherySpawnError(
        `${(err as Error).message} Logs: ${artifacts.spawnOutputPath}`,
      );
    }

    stage = "handoff_eligibility";
    const eligibility = evaluateStewardHandoffEligibility({
      spawnId,
      homeDir: input.homeDir,
      dispatch,
    });
    if (!eligibility.eligible) {
      throw new HatcherySpawnError(eligibility.diagnostic);
    }

    const artifactDir = hatcherySpawnLogDir(spawnId, input.homeDir);
    const artifacts = createHatcherySpawnArtifacts({
      spawnId,
      homeDir: input.homeDir,
      spawnOutput: logs,
      patch: eligibility.handoff.patchText,
      managerPrompt: "",
      metadata: metadataFor(
        input,
        manager,
        spawnId,
        branch,
        waitResult.exitCode,
        startedAt,
        eligibility.handoff,
      ),
    });
    stage = "integration_commit";
    const managerWorktreePath = manager.worktreePath;
    const { touchedPaths, patchText } = eligibility.handoff;
    const publishTarget = { target: managerWorktreePath, branchRef: "refs/heads/" + integrationBranch };
    const resolvePublishTarget = () => resolveStewardTarget(recordedTarget);
    const handoff = eligibility.handoff;
    function commitPhase<T>(name: string, action: (target: AuthorizedStewardTarget) => T): T {
      return dispatch.span(name, (span) => {
        span.setAttributes({ "march.spawn_id": spawnId, "march.branch": integrationBranch });
        try {
          return action(resolvePublishTarget());
        } catch (error) {
          throw publicationError(publishTarget, handoff, error);
        }
      });
    }
    // A prior commit can have survived an interrupted push. Inspect the
    // authorized ref before attempting to reapply the extraction.
    let recovered: IntegrationCommit | undefined;
    try {
      resolvePublishTarget();
      recovered = commitPhase("steward.commit_lookup", (target) => findIntegrationCommit(target, handoff));
    } catch (error) {
      // Let US2 report its established authorization failure when the target
      // cannot be resolved. Failures after authorization belong to commit.
      if (error instanceof IntegrationPublicationError) throw error;
    }
    stage = "patch_apply";
    const application: PatchApplicationResult = recovered
      ? { spawnId, status: "applied", touchedPaths: [...new Set(touchedPaths)].sort(), appliedAt: recovered.committedAt }
      : dispatch.span("steward.apply", (span) => {
      span.setAttributes({
        "march.slice_id": sliceId,
        "march.spawn_id": spawnId,
        "march.worktree": managerWorktreePath,
        "march.patch_path": artifacts.patchPath,
        "march.patch.files": touchedPaths.length,
        "march.patch.bytes": Buffer.byteLength(patchText),
        "march.patch.first_path": touchedPaths[0]?.slice(0, 256) ?? "",
      });
      try {
        return applyStewardHandoff({
          ...recordedTarget,
          handoff: eligibility.handoff,
          span,
        });
      } catch (error) {
        if (error instanceof StewardApplyError) {
          const diagnostic = error.application.diagnostic ?? "patch_apply_failed";
          span.setAttributes({ "march.patch.reject": diagnostic });
          const sc = span.spanContext();
          emitSpawnLog({
            severity: "ERROR",
            body: error.message,
            traceId: sc?.traceId,
            spanId: sc?.spanId,
            attributes: {
              event_kind: "steward_apply_failed",
              "march.slice_id": sliceId,
              "march.spawn_id": spawnId,
              "march.patch.reject": diagnostic,
            },
          });
        }
        throw error;
      }
    });
    stage = "integration_commit";
    integrationCommit = recovered ?? commitPhase("steward.commit", (target) => createIntegrationCommit(target, handoff));
    const localCommit = integrationCommit;
    stage = "integration_push";
    const commit = await dispatch.spanAsync("steward.push", async (span) => {
      span.setAttributes({ "march.spawn_id": spawnId, "march.branch": integrationBranch,
        "march.commit_sha": localCommit.commitSha });
      let target: AuthorizedStewardTarget;
      try {
        target = resolvePublishTarget();
      } catch (error) {
        throw publicationError(publishTarget, handoff, error, localCommit);
      }
      return pushIntegrationCommit(target, handoff, localCommit, { homeDir: input.homeDir, sliceId });
    });
    const managerPrompt = buildManagerPrompt({
      commit,
      operatorPrompt: input.prompt,
      patchPath: path.join(artifactDir, "patch.diff"),
      spawnOutputPath: path.join(artifactDir, "spawn-output.log"),
      metadataPath: path.join(artifactDir, "metadata.json"),
    });
    // The push is done: a prompt-write failure is a handoff failure.
    stage = "steward_send";
    await dispatch.spanAsync("steward.send", () => {
      fs.writeFileSync(artifacts.managerPromptPath, managerPrompt, "utf8");
      return sendPromptToAgentDeckManager(
        {
          sessionId: stewardSessionId,
          prompt: managerPrompt,
          profile: agentDeckProfile,
          traceKey,
        },
        castra,
      );
    });
    handedOff = true;

    return {
      spawnId,
      backend: input.backend.name,
      branch,
      managerSession: manager,
      artifacts,
      application,
      commit,
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
    // A launch collision can be a preserved publication from an earlier spawn
    // of this slice whose push failed. Resume it on the recorded checkout
    // instead of escalating the collision (#739 review).
    if (!manager && stage === "manager_launch" && isBranchAlreadyExistsError(err)) {
      stage = "integration_push";
      const resumed = await resumePreservedPublication({
        repoPath: input.repoPath,
        branch,
        homeDir: input.homeDir,
        prompt: input.prompt,
        backend: input.backend.name,
        profile: agentDeckProfile,
        traceKey,
        sliceId,
        dispatch,
        castra,
      }).catch((resumeError: unknown) => {
        dispatch.recordException(resumeError);
        if (resumeError instanceof IntegrationPublicationError) throw resumeError;
        stage = "steward_send";
        throw new HatcherySpawnError((resumeError as Error).message);
      });
      if (resumed) {
        handedOff = true;
        return resumed;
      }
      stage = "manager_launch";
    }
    dispatch.recordException(err);
    if (!(err instanceof HatcherySpawnError) || err instanceof StewardApplyError) {
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
    // Every Git-writing rollback below needs an authorized target, whatever
    // failed, and it is re-checked now: the checkout may have changed since it
    // was authorized, and a rejected target stays outside the rollback path.
    const rollbackAuthorized = !integrationCommit && (err instanceof StewardApplyError ? err.targetAuthorized : true) &&
      canAuthorizeRollback(stewardTarget, integrationBranch);
    const mgr = rollbackAuthorized ? manager : undefined;
    // #243: `manager.launch` failed because the dispatch branch already exists.
    // `mgr` is undefined, so the `mgr && !handedOff` rollback below cannot clean
    // it — the gap that makes the wedge self-perpetuating. Detect it here so the
    // self-heal runs after the standard rollback.
    const launchCollision =
      !mgr && stage === "manager_launch" && isBranchAlreadyExistsError(err);
    // #460: PARK this failure instead of destroying it, when enabled and there is
    // a manager worktree to preserve. Parking keeps the worker container/image and
    // renames the worktree/branch aside (the canonical names are freed for the
    // self-healing re-dispatch); the destructive rollback runs otherwise.
    // Never park a launch Brood refused mid-reclaim: renaming the worktree aside
    // would race Brood's exact-path Git cleanup of the same checkout.
    const park = parkFailedSpawnsEnabled() && !!mgr && !handedOff &&
      !(err instanceof BroodWorkspaceReclaimingError);
    await dispatch.spanAsync(
      "spawn.rollback",
      async () => {
        // When parking we deliberately KEEP the worker container + image so the
        // failed snapshot/base can be inspected (`docker exec`/`cp` by spawn id).
        if (!park) {
          if (containerId) removeSpawnContainer(spawnId);
          if (imageBuildStarted) removeSpawnImage(spawnId);
        }
        if (mgr && !handedOff) {
          if (park) {
            // Preserve the manager worktree + branch by renaming them ASIDE (never
            // deleted/pruned, #155); free the canonical names for re-dispatch and
            // drop a forensic manifest. This MUST run BEFORE removeAgentDeckManager
            // below: Castra's removeSession prunes the worktree, which would destroy
            // the forensic apply-target before we could move it. Moving first means
            // that later prune no-ops on the freed canonical path, and the parked
            // worktree survives the session removal.
            await dispatch.spanAsync("manager.park", async (parkSpan) => {
              const parked = parkSpawnWorktree(input.repoPath, {
                spawnId,
                branch: integrationBranch,
                worktreePath: mgr.worktreePath,
              });
              const manifestPath = writeParkedSpawnManifest(input.homeDir, {
                spawnId,
                sliceId,
                profile,
                stage,
                error: (err as Error).message,
                containerId: containerId ?? null,
                originalBranch: orphanManagerBranch(branch),
                originalWorktreePath: mgr.worktreePath,
                parkedBranch: parked.parkedBranch,
                parkedWorktreePath: parked.parkedWorktreePath,
                worktreeMoved: parked.worktreeMoved,
                branchRenamed: parked.branchRenamed,
                artifactsDir: hatcherySpawnLogDir(spawnId, input.homeDir),
              });
              parkSpan.setAttributes({
                "march.spawn_id": spawnId,
                "march.park.worktree_moved": parked.worktreeMoved,
                "march.park.branch_renamed": parked.branchRenamed,
                "march.park.parked_worktree": parked.parkedWorktreePath,
                "march.park.manifest": manifestPath ?? "",
              });
            });
          }
          await removeAgentDeckManager(
            { sessionId: mgr.sessionId, profile: agentDeckProfile, traceKey },
            castra,
          );
          if (!park) {
            // Castra's removeSession prunes the worktree but LEAVES the local
            // branch behind. A later re-dispatch of the same slice would then
            // collide on "branch already exists" and strand the slice
            // operator-only (issue #211). Remove the orphan branch (and the
            // worktree, idempotently) by EXACT path via the rollback helper — it
            // never runs a blanket `git worktree prune` (#155).
            try {
              removeSpawnWorktree(input.repoPath, {
                spawnId,
                branch: integrationBranch,
                worktreePath: mgr.worktreePath,
              });
            } catch {
              // Swallowed — removeSpawnWorktree surfaces its own incomplete-
              // rollback warning; preserve the original failure below.
            }
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
      selfHeal = await selfHealManagerLaunchCollision({
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
      err instanceof HatcherySpawnError ||
      err instanceof IntegrationPublicationError ||
      err instanceof HatcheryGitHubError
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
  handoff?: StewardHandoffInput,
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
    ...(handoff
      ? {
          handoff: {
            source: "extraction-result",
            patchInput: "validated-patch",
            spawnId: handoff.spawnId,
            backend: handoff.backend,
            touchedPaths: handoff.touchedPaths,
            patchSha256: handoff.patchSha256,
            extractedAt: handoff.extractedAt,
            diagnostic: "Patch artifact is validated ExtractionResult.patch.patchText; raw backend output is diagnostic-only.",
          },
        }
      : {}),
  };
}

function stderrText(stderr: unknown): string {
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf-8").trimEnd();
  if (typeof stderr === "string") return stderr.trimEnd();
  return "";
}
