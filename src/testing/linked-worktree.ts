import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LinkedWorktreeFixture {
  readonly repoPath: string;
  readonly worktreePath: string;
  /** Remove the repository and linked worktree directories. */
  cleanup(): void;
}

/**
 * Test fixture: a disposable Git repository with one commit plus a linked
 * worktree checked out on `branch`. Hatchery only rolls back a manager
 * worktree it can authorize as a recorded linked checkout (#735 review), so
 * rollback tests need a real one rather than a placeholder path.
 */
export function makeLinkedWorktree(branch: string): LinkedWorktreeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "march-linked-wt-"));
  const repoPath = path.join(root, "repo");
  const worktreePath = path.join(root, "worktree");
  fs.mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repoPath, "f"), "hello\n");
  git("add", "f");
  git("commit", "-qm", "init");
  git("worktree", "add", "-qb", branch, worktreePath);
  return {
    repoPath,
    worktreePath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
