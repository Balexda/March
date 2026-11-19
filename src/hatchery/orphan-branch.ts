import { execFileSync } from "node:child_process";
import {
  hatcheryGitEnv,
  HatcheryGitHubError,
  readHatcheryGitHubJson,
  resolveHatcheryOrigin,
  runHatcheryNetworkGit,
} from "./github-read.js";

/**
 * Safety classification for a branch that a Hatchery spawn collided with at
 * `manager.launch` ("branch already exists"). Mirrors the `legate.unwedge`
 * skill's validator (`clean-stale-branch.sh`) so the autonomous self-heal (#243)
 * applies the SAME refuse/allow contract an operator would: never delete a
 * branch with an open PR (that is #173's "adopt the PR" path), and never delete
 * diverged unmerged work. A branch is safe to remove only when it is an orphan
 * ref (its HEAD is an ancestor of the default branch — no unique commits) or a
 * post-merge-stale leftover (its PR already merged).
 */
export type BranchSafetyVerdict =
  | { readonly kind: "absent" }
  | {
      readonly kind: "safe";
      readonly reason: "orphan-ref" | "post-merge-stale";
      readonly detail?: string;
    }
  | {
      readonly kind: "unsafe";
      readonly reason: "open-pr" | "diverged" | "pr-lookup-unknown";
      readonly detail?: string;
    };

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Runs a child process and reports its exit code + stdout (never throws). The
 * classifier branches on exit codes (`git merge-base --is-ancestor`,
 * `gh pr list`), so a non-zero exit is data, not an error. Injectable so the
 * classification logic is unit-testable without a real git repo / `gh`.
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  cwd: string,
) => CommandResult;

const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

const defaultRunner: CommandRunner = (file, args, cwd) => {
  try {
    const stdout = execFileSync(file, args as string[], {
      cwd,
      env: hatcheryGitEnv(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    const stdout = Buffer.isBuffer(e.stdout)
      ? e.stdout.toString("utf-8")
      : typeof e.stdout === "string"
        ? e.stdout
        : "";
    return { code: typeof e.status === "number" ? e.status : 1, stdout };
  }
};

interface PrRecord {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged_at: string | null;
}

function isPrRecord(value: unknown): value is PrRecord {
  if (!value || typeof value !== "object") return false;
  const pr = value as Partial<PrRecord>;
  return Number.isInteger(pr.number) && (pr.state === "open" || pr.state === "closed") &&
    (pr.merged_at === null || typeof pr.merged_at === "string");
}

/** Classify a collision using local ancestry and authoritative remote evidence. */
export async function classifyBranchSafety(
  repoRoot: string,
  branch: string,
  run: CommandRunner = defaultRunner,
  sliceId?: string,
): Promise<BranchSafetyVerdict> {
  const branchRef = "refs/heads/" + branch;
  const exists = run("git", ["show-ref", "--verify", "--quiet", branchRef], repoRoot);
  if (exists.code === 1) return { kind: "absent" };
  if (exists.code !== 0) throw new HatcheryGitHubError("branch_lookup_failed");

  const origin = await resolveHatcheryOrigin(repoRoot);
  const remoteStatus = origin
    ? await runHatcheryNetworkGit(repoRoot, origin, ["ls-remote", "--exit-code", "--"], [branchRef], sliceId)
    : 2;
  if (remoteStatus !== 0 && remoteStatus !== 2) throw new HatcheryGitHubError("remote_check_failed");

  let defaultBranch = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot)
    .stdout.trim().replace(/^origin\//, "");
  let prs: PrRecord[] = [];
  if (remoteStatus === 0) {
    if (!origin?.repo) return { kind: "unsafe", reason: "pr-lookup-unknown" };
    const repo = origin.repo;
    const head = encodeURIComponent(repo.split("/")[0] + ":" + branch);
    const result = await readHatcheryGitHubJson(repo, "/pulls?state=all&per_page=100&head=" + head, sliceId);
    if (!Array.isArray(result) || !result.every(isPrRecord)) throw new HatcheryGitHubError("invalid_pr_lookup");
    prs = result;
    const open = prs.filter((pr) => pr.state === "open");
    if (open.length) {
      return { kind: "unsafe", reason: "open-pr", detail: open.map((pr) => "#" + pr.number).join(",") };
    }
  }

  // Resolve a missing origin/HEAD independently of whether the collision branch
  // was pushed: an unpushed orphan still needs the default branch for ancestry.
  if (!defaultBranch && origin?.repo) {
    const metadata = await readHatcheryGitHubJson(origin.repo, "", sliceId) as { default_branch?: unknown } | null;
    if (typeof metadata?.default_branch !== "string" || !metadata.default_branch) {
      throw new HatcheryGitHubError("invalid_repo_lookup");
    }
    defaultBranch = metadata.default_branch;
  }

  if (!defaultBranch && !origin) defaultBranch = "main";

  const isAncestor = defaultBranch &&
    run("git", ["merge-base", "--is-ancestor", branchRef, "refs/heads/" + defaultBranch], repoRoot).code === 0;
  if (isAncestor) return { kind: "safe", reason: "orphan-ref" };
  const merged = prs.filter((pr) => pr.merged_at);
  if (merged.length) {
    return { kind: "safe", reason: "post-merge-stale", detail: merged.map((pr) => "#" + pr.number).join(",") };
  }
  return { kind: "unsafe", reason: "diverged" };
}

/**
 * The exact checkout path git records for the worktree currently holding
 * `branch`, or `undefined` when no worktree has it checked out. Read from
 * `git worktree list --porcelain` (git's own records) so the path is EXACT —
 * the self-heal removes only this one path and never runs a blanket
 * `git worktree prune` (#155). The worktree must be removed before
 * `git branch -D`, which refuses a branch checked out in a worktree.
 */
export function findWorktreePathForBranch(
  repoRoot: string,
  branch: string,
  run: CommandRunner = defaultRunner,
): string | undefined {
  const res = run("git", ["worktree", "list", "--porcelain"], repoRoot);
  if (res.code !== 0) return undefined;
  let currentPath: string | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      if (ref === `refs/heads/${branch}` && currentPath) return currentPath;
    } else if (line.trim() === "") {
      currentPath = undefined;
    }
  }
  return undefined;
}

/** Bounded label for the `march.self_heal.verdict` span attribute (no PR ids). */
export function verdictLabel(verdict: BranchSafetyVerdict): string {
  return verdict.kind === "absent"
    ? "absent"
    : `${verdict.kind}:${verdict.reason}`;
}

/** Human-readable verdict (with PR ids) for log bodies + escalation messages. */
export function describeVerdict(verdict: BranchSafetyVerdict): string {
  switch (verdict.kind) {
    case "absent":
      return "branch no longer exists";
    case "safe":
      return verdict.detail
        ? `safe to remove (${verdict.reason}: ${verdict.detail})`
        : `safe to remove (${verdict.reason})`;
    case "unsafe":
      return verdict.detail
        ? `unsafe to remove (${verdict.reason}: ${verdict.detail})`
        : `unsafe to remove (${verdict.reason})`;
  }
}
