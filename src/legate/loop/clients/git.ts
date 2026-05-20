import { execText } from "./exec.js";

/**
 * Git client: default-branch sync + worktree inspection. Side-effecting
 * (fetch/switch/pull); the caller passes the repo path and the known default
 * branch (from state) to avoid re-discovering it.
 */

export interface SyncResult {
  readonly default_branch: string;
  readonly synced: true;
  readonly head: string;
}

/** Resolve, fetch, switch, and fast-forward the repo's default branch. */
export function syncDefaultBranch(repoPath: string, knownDefaultBranch?: string): SyncResult {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("repo path is missing");
  }
  let defaultBranch = knownDefaultBranch;
  if (!defaultBranch) {
    try {
      defaultBranch = execText("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        cwd: repoPath,
      })
        .trim()
        .replace(/^origin\//, "");
    } catch {
      defaultBranch = execText(
        "gh",
        ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
        { cwd: repoPath },
      ).trim();
    }
  }
  if (!defaultBranch) throw new Error("could not determine default branch");
  execText("git", ["fetch", "origin", defaultBranch], { cwd: repoPath });
  execText("git", ["switch", defaultBranch], { cwd: repoPath });
  execText("git", ["pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
  return {
    default_branch: defaultBranch,
    synced: true,
    head: execText("git", ["rev-parse", "HEAD"], { cwd: repoPath }).trim(),
  };
}

/** Find the worktree path checked out to a branch, or null. */
export function findWorktreeForBranch(repoPath: string, branchName: string): string | null {
  let out: string;
  try {
    out = execText("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
  } catch {
    return null;
  }
  for (const block of out.split("\n\n")) {
    const wt = block.match(/^worktree (.+)$/m);
    const br = block.match(/^branch refs\/heads\/(.+)$/m);
    if (wt && br && br[1]!.trim() === branchName) return wt[1]!.trim();
  }
  return null;
}

/** True when a worktree has no uncommitted/untracked changes (conservative). */
export function worktreeIsClean(worktreePath: string): boolean {
  try {
    return execText("git", ["status", "--porcelain"], { cwd: worktreePath }).trim().length === 0;
  } catch {
    return false;
  }
}

/** Best-effort current branch of a worktree (for PR-discovery branch variants). */
export function worktreeCurrentBranch(worktreePath: string): string {
  try {
    return execText("git", ["-C", worktreePath, "branch", "--show-current"]).trim();
  } catch {
    return "";
  }
}
