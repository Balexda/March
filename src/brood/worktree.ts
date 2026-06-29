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
 * `<repoRoot>/../worktrees/march/<spawn-id>` per FR-006. The parent
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

/**
 * Best-effort branch deletion used during rollback. Returns `true` if
 * the branch is gone at the end of the call (either deleted or never
 * existed), `false` if `git branch -D` failed against an existing
 * branch. Callers surface a stderr warning when this returns `false`
 * so operators know manual cleanup may be required — FR-021 mandates
 * no residual artifacts on failure, so a silent swallow would hide a
 * contract violation.
 */
function deleteBranch(repoRoot: string, branch: string): boolean {
  // If the branch isn't there in the first place, treat it as a
  // successful (idempotent) removal. This avoids false-positive
  // warnings when the rollback helper is called twice or when the
  // branch was never created.
  if (!branchExists(repoRoot, branch)) return true;
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Emits a stderr warning when rollback cleanup left residual state.
 * Operators need this signal because FR-021 mandates no residual
 * artifacts after a failed dispatch, and silently swallowing cleanup
 * failures would leave them to discover stale `march/spawn/*` branches
 * and worktree directories later with no context.
 */
function warnIncompleteRollback(
  spawnId: string,
  branch: string | undefined,
  worktreePath: string | undefined,
): void {
  const parts: string[] = [];
  if (branch) {
    parts.push(`branch "${branch}" may still exist`);
  }
  if (worktreePath) {
    parts.push(`worktree "${worktreePath}" may still exist`);
  }
  if (parts.length === 0) return;
  process.stderr.write(
    `warning: incomplete rollback for spawn ${spawnId} — ${parts.join("; ")}; manual cleanup may be required.\n`,
  );
}

/**
 * Creates a dedicated branch and linked worktree for a new spawn.
 *
 * Steps (in order):
 *   1. Pick a SpawnId and create `march/spawn/<spawn-id>` from HEAD in
 *      a single retry loop. Branch creation itself is the authoritative
 *      collision check — a pre-check via `show-ref` plus a separate
 *      `git branch` step would race against concurrent dispatches that
 *      create the same ref between check and create. Any branch-creation
 *      failure (existing branch, refs-dir contention, etc.) triggers a
 *      retry with a fresh ID up to {@link MAX_COLLISION_RETRIES} times.
 *   2. Ensure the worktree parent directory (`<repo>/../worktrees/march/`)
 *      exists, creating it on demand per FR-007.
 *   3. Run `git worktree add` to materialize the linked worktree.
 *   4. On any post-step-1 failure, delete the branch (and any partially
 *      created worktree state) before surfacing the error so no
 *      residual state is left behind.
 *
 * @param repoRoot - Absolute path to the source git repository root.
 * @returns The spawn ID, branch, and absolute worktree path.
 * @throws {WorktreeError} On collision-retry exhaustion or any git failure.
 */
export function createSpawnWorktree(repoRoot: string): SpawnWorktree {
  // 1. Pick a unique spawn ID and create its branch atomically. The
  //    branch-creation step IS the collision check — a pre-check would
  //    be racy under concurrent dispatches. We still do a cheap
  //    `branchExists` fast-path to avoid forking git when the branch is
  //    already known to exist, but it is an optimization, not the
  //    authoritative guard.
  let spawnId: string | undefined;
  let branch: string | undefined;
  let lastBranchError: Error | undefined;
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const candidateId = generateSpawnId();
    const candidateBranch = spawnBranchName(candidateId);

    // Fast-path: skip candidates we can already see collide. This saves
    // a git fork in the common case without being relied on for
    // correctness.
    if (branchExists(repoRoot, candidateBranch)) {
      continue;
    }

    try {
      execFileSync("git", ["branch", candidateBranch, "HEAD"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      spawnId = candidateId;
      branch = candidateBranch;
      break;
    } catch (err) {
      // Any branch-creation failure is treated as a retryable collision.
      // Exhausting all retries surfaces the last error to the caller.
      lastBranchError = err as Error;
    }
  }
  if (!spawnId || !branch) {
    const suffix = lastBranchError
      ? `: ${lastBranchError.message}`
      : " (branch-name collisions)";
    throw new WorktreeError(
      `Failed to create spawn branch after ${MAX_COLLISION_RETRIES} attempts${suffix}`,
    );
  }

  const worktreePath = spawnWorktreePath(repoRoot, spawnId);

  // 2. Ensure the worktree parent directory exists.
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (err) {
    if (!deleteBranch(repoRoot, branch)) {
      warnIncompleteRollback(spawnId, branch, undefined);
    }
    throw new WorktreeError(
      `Failed to create worktree parent directory: ${(err as Error).message}`,
    );
  }

  // Safety: if the target worktree path already exists on disk (e.g.,
  // stale content from a prior run or unrelated user data), refuse to
  // proceed. Otherwise `git worktree add` would fail and our rollback
  // would rmSync pre-existing content.
  if (fs.existsSync(worktreePath)) {
    if (!deleteBranch(repoRoot, branch)) {
      warnIncompleteRollback(spawnId, branch, undefined);
    }
    throw new WorktreeError(
      `Worktree target already exists: "${worktreePath}". Refusing to overwrite.`,
    );
  }

  // 3. Create the linked worktree. On failure, roll back the branch and
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

/** Returns true if `dir` looks like a git-linked worktree (has a `.git` file). */
function isGitLinkedWorktree(dir: string): boolean {
  try {
    const dotGit = path.join(dir, ".git");
    // Linked worktrees have a `.git` FILE (not a directory) that points
    // back into `<repoRoot>/.git/worktrees/<name>`. If the entry is
    // missing or is a directory, this is not a git-linked worktree.
    const stat = fs.lstatSync(dotGit);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Result of {@link removeSpawnWorktreeExact}: whether the worktree directory
 * and the branch are gone at the end of the call.
 */
export interface RemoveWorktreeResult {
  readonly worktreeRemoved: boolean;
  readonly branchDeleted: boolean;
}

/**
 * Removes a spawn's worktree and/or branch by EXACT identifier — the only
 * removal path brood teardown uses.
 *
 * Safety (issue #155): this NEVER runs `git worktree prune`. A blanket prune
 * scans every worktree the repo knows about and deletes the admin entry of any
 * whose checkout it cannot see — which, inside a container that doesn't have
 * sibling worktrees mounted, corrupts unrelated host worktrees. This function
 * only ever touches the one `worktreePath` it was handed (via
 * `git worktree remove --force <exact path>`, with a `.git`-guarded `fs.rmSync`
 * fallback) and the one named `branch`. Omitted fields are treated as already
 * removed. Does not throw — the caller inspects the returned flags.
 */
export function removeSpawnWorktreeExact(
  repoRoot: string,
  target: { readonly worktreePath?: string; readonly branch?: string },
): RemoveWorktreeResult {
  const worktreeRemoved = target.worktreePath
    ? removeWorktreePathExact(repoRoot, target.worktreePath)
    : true;
  const branchDeleted = target.branch
    ? deleteBranch(repoRoot, target.branch)
    : true;
  return { worktreeRemoved, branchDeleted };
}

/**
 * Removes a single worktree by its exact path. Idempotent (a missing path is
 * already "removed"). Tries `git worktree remove --force <path>` first; on
 * failure, falls back to `fs.rmSync` only when the directory still looks like a
 * git-linked worktree. Never enumerates or prunes other worktrees.
 */
function removeWorktreePathExact(
  repoRoot: string,
  worktreePath: string,
): boolean {
  if (!fs.existsSync(worktreePath)) return true;
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    // Only rmSync the directory if it actually looks like a git worktree.
    // This avoids clobbering unrelated user data that happens to live at the
    // target path. We deliberately do NOT `git worktree prune` here (#155).
    if (isGitLinkedWorktree(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // swallowed — outcome reported via the existsSync check below
      }
    }
    return !fs.existsSync(worktreePath);
  }
}

/**
 * Removes a spawn's worktree and branch during dispatch rollback. Delegates to
 * {@link removeSpawnWorktreeExact} (which never prunes) and emits a single
 * stderr warning listing anything that may still exist so operators know manual
 * cleanup may be required (FR-021).
 */
export function removeSpawnWorktree(
  repoRoot: string,
  worktree: SpawnWorktree,
): void {
  const { worktreeRemoved, branchDeleted } = removeSpawnWorktreeExact(repoRoot, {
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
  });

  if (!worktreeRemoved || !branchDeleted) {
    warnIncompleteRollback(
      worktree.spawnId,
      branchDeleted ? undefined : worktree.branch,
      worktreeRemoved ? undefined : worktree.worktreePath,
    );
  }
}

/** Outcome of {@link parkSpawnWorktree}: the parked-aside identifiers and which
 *  of the three preserving git ops actually completed. */
export interface ParkWorktreeResult {
  /** Where the worktree now lives (the canonical path is freed for re-dispatch). */
  readonly parkedWorktreePath: string;
  /** What the branch was renamed to (the canonical name is freed). */
  readonly parkedBranch: string;
  readonly worktreeMoved: boolean;
  readonly branchRenamed: boolean;
}

/**
 * PARK a failed spawn's manager worktree + branch instead of deleting them
 * (#460 forensics): rename both ASIDE so the failed state survives on disk for
 * later root-causing, while FREEING the canonical worktree path and branch name
 * so the loop's self-healing re-dispatch starts clean (no collision).
 *
 * Three best-effort, preserving git ops (the inverse of {@link
 * removeSpawnWorktree} — nothing is destroyed, nothing is pruned, #155):
 *   1. `git worktree move <wt> <parked>` — frees the canonical directory.
 *   2. `git -C <parked> checkout --detach` — releases the branch so it can be
 *      renamed (a checked-out branch can't be `-m`'d); the parked worktree stays
 *      at the failed commit (detached), so its files + index are intact.
 *   3. `git branch -m <branch> <parked>` — frees the canonical branch name while
 *      keeping the failed commit reachable under the parked name.
 *
 * Never throws; the caller inspects the returned flags. If the move fails the
 * branch rename is skipped (leaving everything in place is still non-destructive —
 * only a later re-dispatch could then collide, which the existing self-heal
 * handles). The worker container/image are left to the caller (kept, not removed).
 */
export function parkSpawnWorktree(
  repoRoot: string,
  spawn: SpawnWorktree,
): ParkWorktreeResult {
  const parkedWorktreePath = `${spawn.worktreePath}-parked-${spawn.spawnId}`;
  // A fresh namespace that can't D/F-conflict with the freed canonical ref.
  const parkedBranch = `parked/${spawn.spawnId}/${spawn.branch.replace(/^feature\//, "")}`;

  let worktreeMoved = false;
  if (fs.existsSync(spawn.worktreePath) && !fs.existsSync(parkedWorktreePath)) {
    try {
      // `--force` because a failed-apply worktree is DIRTY (a `--3way` apply leaves
      // unmerged paths) and may still be the cwd of the about-to-be-removed
      // agent-deck session — plain `move` refuses both. We want it moved regardless.
      execFileSync("git", ["worktree", "move", "--force", spawn.worktreePath, parkedWorktreePath], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      worktreeMoved = true;
    } catch {
      // Leave the worktree in place — preservation still holds; report via flag.
    }
  }

  let branchRenamed = false;
  // Only free the branch name once the worktree no longer holds it at the
  // canonical path (post-move). Detach the parked checkout so `-m` is permitted —
  // `checkout --detach` with no pathspec just repoints HEAD at the SAME commit, so
  // it leaves the dirty/unmerged working tree + index untouched (the forensics we
  // are preserving) and succeeds even on a conflicted worktree.
  if (worktreeMoved) {
    try {
      execFileSync("git", ["-C", parkedWorktreePath, "checkout", "--detach"], { stdio: "ignore" });
    } catch {
      // best-effort — if detach fails the rename below will simply no-op.
    }
    try {
      execFileSync("git", ["branch", "-m", spawn.branch, parkedBranch], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      branchRenamed = true;
    } catch {
      // Branch left under its original name; a later re-dispatch collision is
      // handled by the existing #243 self-heal. Reported via the flag.
    }
  }

  return { parkedWorktreePath, parkedBranch, worktreeMoved, branchRenamed };
}
