import { execFileSync } from "node:child_process";
import { hatcheryGitEnv } from "./github-read.js";
import {
  boundAgentMessage,
  lastAgentMessage,
  lsTreeArgs,
  MAX_EVIDENCE_COMMITS,
  parseLsTreeBlobs,
  type DeclinedArtifact,
  type LaunchFailure,
  type LaunchFailureEvidence,
} from "./launch-failure.js";
import { verdictLabel, type BranchSafetyVerdict, type CommandRunner } from "./orphan-branch.js";

/**
 * Git-derived evidence for a {@link LaunchFailure} (step 2 of the launch-failure
 * recovery plan). Everything here is a bounded read: SHAs, counts, and blob ids.
 * Each helper is best-effort: a failing git read drops that field instead of
 * failing the classification.
 */

const defaultRunner: CommandRunner = (file, args, cwd) => {
  try {
    const stdout = execFileSync(file, args as string[], {
      cwd,
      env: hatcheryGitEnv(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf-8") : typeof e.stdout === "string" ? e.stdout : "";
    return { code: typeof e.status === "number" ? e.status : -1, stdout };
  }
};

/** The local default branch (`origin/HEAD` target), or undefined. */
function defaultBranch(repoPath: string, run: CommandRunner): string | undefined {
  const head = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
  const name = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
  return name || undefined;
}

/**
 * The commits on `branch` that exist nowhere else: not on any remote ref and not
 * on the local default branch. These are what a deletion would discard. Returns
 * the first {@link MAX_EVIDENCE_COMMITS} SHAs, the total, and the distinct files
 * they touch.
 */
export function unpushedCommitEvidence(
  repoPath: string,
  branch: string,
  run: CommandRunner = defaultRunner,
): Pick<LaunchFailureEvidence, "commits" | "commitCount" | "touchedFileCount"> {
  const exclude = ["--not", "--remotes"];
  const base = defaultBranch(repoPath, run) ?? "main";
  if (run("git", ["show-ref", "--verify", "--quiet", "refs/heads/" + base], repoPath).code === 0) {
    exclude.push("refs/heads/" + base);
  }
  const range = ["refs/heads/" + branch, ...exclude];
  const out: { commits?: string[]; commitCount?: number; touchedFileCount?: number } = {};
  const total = run("git", ["rev-list", "--count", ...range], repoPath);
  if (total.code === 0 && /^\d+$/.test(total.stdout.trim())) out.commitCount = Number(total.stdout.trim());
  const list = run("git", ["rev-list", "--max-count=" + MAX_EVIDENCE_COMMITS, ...range], repoPath);
  if (list.code === 0) {
    const commits = list.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/i.test(s));
    out.commits = commits;
  }
  const files = run("git", ["log", "--format=", "--name-only", ...range], repoPath);
  if (files.code === 0) {
    out.touchedFileCount = new Set(files.stdout.split("\n").map((s) => s.trim()).filter(Boolean)).size;
  }
  return out;
}

/**
 * The structured failure for a `manager.launch` "branch already exists"
 * collision, from the self-heal's safety verdict (carried, never re-derived):
 *  - unsafe `open-pr`  → `adopt`, with the PR numbers;
 *  - unsafe `diverged` → `operator`, with the unpushed commits it would discard;
 *  - everything else (safe orphan removed, absent, PR lookup unknown) → `auto`.
 */
export function collisionFailure(input: {
  readonly repoPath: string;
  readonly branch: string;
  readonly verdict: BranchSafetyVerdict;
  readonly worktreePath?: string;
  readonly run?: CommandRunner;
}): LaunchFailure {
  const { verdict } = input;
  const evidence: Record<string, unknown> = { branch: input.branch, verdict: verdictLabel(verdict) };
  if (input.worktreePath) evidence.worktreePath = input.worktreePath;
  if (verdict.kind === "unsafe" && verdict.reason === "open-pr") {
    const prNumbers = (verdict.detail ?? "").split(",").map((s) => Number(s.replace(/^#/, "")))
      .filter((n) => Number.isInteger(n) && n > 0);
    return { class: "branch_collision", retry: "adopt", reason: "branch_collision", evidence: { ...evidence, prNumbers } };
  }
  if (verdict.kind === "unsafe" && verdict.reason === "diverged") {
    let commits = {};
    try {
      commits = unpushedCommitEvidence(input.repoPath, input.branch, input.run);
    } catch {
      // Best-effort: hold for the operator even without the commit list.
    }
    return { class: "branch_collision", retry: "operator", reason: "branch_collision", evidence: { ...evidence, ...commits } };
  }
  return { class: "branch_collision", retry: "auto", reason: "branch_collision", evidence };
}

/**
 * Blob ids of `paths` at `rev` in `cwd`, in ONE git call. A path absent at
 * `rev` reports `blob: null`. Paths are repo-relative. Returns undefined when
 * git itself cannot be read (so the caller can tell "unknown" from "absent").
 */
export function artifactBlobs(
  cwd: string,
  rev: string,
  paths: readonly string[],
  run: CommandRunner = defaultRunner,
): DeclinedArtifact[] | undefined {
  if (!paths.some((p) => typeof p === "string" && p.length > 0)) return [];
  const res = run("git", lsTreeArgs(rev, paths), cwd);
  if (res.code !== 0) return undefined;
  return parseLsTreeBlobs(res.stdout, paths);
}

/** The commit `HEAD` names in `cwd`, or undefined. */
export function headCommit(cwd: string, run: CommandRunner = defaultRunner): string | undefined {
  const res = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  const sha = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

/**
 * The structured failure for a worker that exited 3 with a clean tree: the
 * agent read its task and deliberately made no change. Evidence is the agent's
 * own last message, the snapshot's base commit, and the blob id of each plan
 * artifact at that commit (the content it declined).
 */
export function agentDeclinedFailure(input: {
  readonly logs: string;
  readonly worktreePath?: string;
  readonly artifactPaths?: readonly string[];
  readonly run?: CommandRunner;
}): LaunchFailure {
  const evidence: Record<string, unknown> = {};
  const message = lastAgentMessage(input.logs);
  if (message) evidence.agentMessage = boundAgentMessage(message);
  if (input.worktreePath) {
    try {
      const base = headCommit(input.worktreePath, input.run);
      if (base) {
        evidence.baseCommit = base;
        if (input.artifactPaths?.length) {
          const artifacts = artifactBlobs(input.worktreePath, base, input.artifactPaths, input.run);
          if (artifacts?.length) evidence.artifacts = artifacts;
        }
      }
    } catch {
      // Best-effort: the legate records the hashes itself when these are absent.
    }
  }
  return {
    class: "agent_declined",
    retry: "until_input_changes",
    reason: "agent_declined",
    ...(Object.keys(evidence).length > 0 && { evidence }),
  };
}
