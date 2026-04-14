import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Error thrown by worktree operations. Carries a human-readable message
 * suitable for writing to stderr.
 */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/**
 * The git artifacts produced for a single spawn: its ID, the dedicated
 * branch, and the absolute path of the linked worktree.
 */
export interface SpawnWorktree {
  readonly spawnId: string;
  readonly branch: string;
  readonly worktreePath: string;
}

/**
 * Upper bound on spawn-ID collision retries. The 6-hex-char suffix gives
 * ~16M combinations per day, so any retry indicates either a real clash or
 * a bug; bailing after a small number of attempts keeps dispatch responsive.
 */
const MAX_COLLISION_RETRIES = 5;

/**
 * Generates a SpawnId of the form `YYYYMMDD-<6-char-hex>` using the current
 * UTC date and `crypto.randomBytes(3)`. Exposed for testing; callers should
 * normally go through {@link createSpawnWorktree}.
 */
export function generateSpawnId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hex = crypto.randomBytes(3).toString("hex");
  return `${yyyy}${mm}${dd}-${hex}`;
}

/**
 * Returns the branch name for a given spawn ID, following the
 * contract's `march/spawn/<spawn-id>` naming convention.
 */
export function spawnBranchName(spawnId: string): string {
  return `march/spawn/${spawnId}`;
}

/**
 * Returns the absolute worktree path for a spawn, placed at
 * `<repoRoot>/../worktrees/march/<spawn-id>/` per FR-006. The parent
 * directory is created on demand by {@link createSpawnWorktree}.
 */
export function spawnWorktreePath(repoRoot: string, spawnId: string): string {
  return path.join(path.dirname(repoRoot), "worktrees", "march", spawnId);
}

/** Returns true if a local branch with the given name already exists. */
function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repoRoot, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/** Best-effort branch deletion, swallowing errors (used during rollback). */
function deleteBranch(repoRoot: string, branch: string): void {
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Creates a dedicated branch and linked worktree for a new spawn.
 *
 * Steps (in order):
 *   1. Generate a SpawnId and branch name, retrying on branch-name
 *      collisions up to {@link MAX_COLLISION_RETRIES} times.
 *   2. Ensure the worktree parent directory (`<repo>/../worktrees/march/`)
 *      exists, creating it on demand per FR-007.
 *   3. Create `march/spawn/<spawn-id>` from the current HEAD of `repoRoot`.
 *   4. Run `git worktree add` to materialize the linked worktree.
 *   5. On any post-step-3 failure, delete the branch before surfacing the
 *      error so no residual state is left behind.
 *
 * @param repoRoot - Absolute path to the source git repository root.
 * @returns The spawn ID, branch, and absolute worktree path.
 * @throws {WorktreeError} On collision-retry exhaustion or any git failure.
 */
export function createSpawnWorktree(repoRoot: string): SpawnWorktree {
  // 1. Generate a unique spawn ID with bounded collision retry.
  let spawnId: string | undefined;
  let branch: string | undefined;
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const candidateId = generateSpawnId();
    const candidateBranch = spawnBranchName(candidateId);
    if (!branchExists(repoRoot, candidateBranch)) {
      spawnId = candidateId;
      branch = candidateBranch;
      break;
    }
  }
  if (!spawnId || !branch) {
    throw new WorktreeError(
      `Failed to generate a unique spawn ID after ${MAX_COLLISION_RETRIES} attempts (branch-name collisions)`,
    );
  }

  const worktreePath = spawnWorktreePath(repoRoot, spawnId);

  // 2. Ensure the worktree parent directory exists.
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (err) {
    throw new WorktreeError(
      `Failed to create worktree parent directory: ${(err as Error).message}`,
    );
  }

  // 3. Create the spawn branch from HEAD.
  try {
    execFileSync("git", ["branch", branch, "HEAD"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch (err) {
    throw new WorktreeError(
      `Failed to create branch "${branch}": ${(err as Error).message}`,
    );
  }

  // 4. Create the linked worktree. On failure, roll back the branch and
  // any partially-materialized worktree state (e.g., if a hook failure
  // left the worktree directory on disk after git populated it).
  try {
    execFileSync("git", ["worktree", "add", worktreePath, branch], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch (err) {
    removeSpawnWorktree(repoRoot, { spawnId, branch, worktreePath });
    throw new WorktreeError(
      `Failed to create worktree at "${worktreePath}": ${(err as Error).message}`,
    );
  }

  return { spawnId, branch, worktreePath };
}

/**
 * Removes a spawn's worktree and branch. Used by the dispatch action to
 * roll back when a later pipeline stage fails. Best-effort: individual
 * cleanup failures are swallowed so callers can continue with a usable
 * error path, but the function does not throw.
 */
export function removeSpawnWorktree(
  repoRoot: string,
  worktree: SpawnWorktree,
): void {
  // Try `git worktree remove --force` first; fall back to a filesystem
  // rm + `git worktree prune` if git refuses (e.g., because the worktree
  // directory no longer exists on disk).
  try {
    execFileSync(
      "git",
      ["worktree", "remove", "--force", worktree.worktreePath],
      { cwd: repoRoot, stdio: "ignore" },
    );
  } catch {
    try {
      fs.rmSync(worktree.worktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
    } catch {
      // ignore
    }
  }

  deleteBranch(repoRoot, worktree.branch);
}
