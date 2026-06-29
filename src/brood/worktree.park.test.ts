/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parkSpawnWorktree } from "./worktree.js";

// #460: parkSpawnWorktree must PRESERVE a failed spawn's manager worktree+branch
// for forensics while FREEING the canonical path/branch so the self-healing
// re-dispatch starts clean. These run real git.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", env: GIT_ENV }).trim();
}

describe("parkSpawnWorktree (#460)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    tmpDirs.length = 0;
  });

  /** A repo with a linked worktree checked out on `feature/<bare>`, carrying a
   *  marker file so we can prove the parked content survives. */
  function makeRepoWithWorktree(bare: string): { repo: string; worktree: string; branch: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "march-park-"));
    tmpDirs.push(root);
    const repo = path.join(root, "repo");
    git(["init", "-q", "-b", "main", repo], root);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "base"], repo);

    const branch = "feature/" + bare;
    const worktree = path.join(root, "WorkTrees", "feature-" + bare.replace(/\//g, "-"));
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(["worktree", "add", "-b", branch, worktree], repo);
    // The failed worker's in-progress state we want to preserve.
    fs.writeFileSync(path.join(worktree, "FAILED_STATE.txt"), "evidence\n");
    git(["add", "-A"], worktree);
    git(["commit", "-q", "-m", "wip"], worktree);
    return { repo, worktree, branch };
  }

  it("renames worktree+branch aside, preserving content and freeing the canonical names", () => {
    const { repo, worktree, branch } = makeRepoWithWorktree("foo/bar-us1");

    const res = parkSpawnWorktree(repo, { spawnId: "20260628-abc123", branch, worktreePath: worktree });

    expect(res.worktreeMoved).toBe(true);
    expect(res.branchRenamed).toBe(true);
    // Canonical path + branch are FREED.
    expect(fs.existsSync(worktree)).toBe(false);
    const branches = git(["branch", "--list"], repo);
    expect(branches).not.toContain(" " + branch);
    // Parked path exists with the evidence intact, parked branch present.
    expect(fs.existsSync(path.join(res.parkedWorktreePath, "FAILED_STATE.txt"))).toBe(true);
    expect(git(["rev-parse", "--verify", res.parkedBranch], repo)).toMatch(/^[0-9a-f]{40}$/);

    // Re-dispatch can now recreate the canonical worktree+branch with no collision.
    expect(() => git(["worktree", "add", "-b", branch, worktree], repo)).not.toThrow();
    expect(fs.existsSync(worktree)).toBe(true);
  });

  it("parks a DIRTY worktree with unmerged paths (the live failed-apply condition)", () => {
    const { repo, worktree, branch } = makeRepoWithWorktree("dirty/us2");
    // Reproduce a failed `git apply --index --3way`: leave an unmerged path + a
    // dirty working tree, exactly what parking must preserve, not reset.
    const conflicted = path.join(worktree, "contract.md");
    fs.writeFileSync(conflicted, "<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n");
    git(["add", conflicted], worktree);
    // Force an unmerged index entry (stage the same path at two stages).
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: worktree,
      input: `100644 ${git(["hash-object", "-w", conflicted], worktree)} 1\tcontract.md\n` +
             `100644 ${git(["hash-object", "-w", conflicted], worktree)} 2\tcontract.md\n`,
      env: GIT_ENV,
    });
    expect(git(["status", "--porcelain"], worktree)).toMatch(/contract\.md/);

    const res = parkSpawnWorktree(repo, { spawnId: "20260628-dirty1", branch, worktreePath: worktree });

    // The whole point: a dirty/conflicted worktree is STILL parked + branch freed.
    expect(res.worktreeMoved).toBe(true);
    expect(res.branchRenamed).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(fs.existsSync(path.join(res.parkedWorktreePath, "contract.md"))).toBe(true);
    // Canonical branch freed → re-dispatch can recreate it.
    expect(() => git(["worktree", "add", "-b", branch, worktree], repo)).not.toThrow();
  });

  it("is non-destructive and idempotent-ish when the worktree path is already gone", () => {
    const { repo, branch } = makeRepoWithWorktree("gone-us2");
    const missing = path.join(repo, "..", "WorkTrees", "does-not-exist");
    const res = parkSpawnWorktree(repo, { spawnId: "20260628-def456", branch, worktreePath: missing });
    expect(res.worktreeMoved).toBe(false);
    // Nothing moved → branch left untouched (no rename attempted).
    expect(res.branchRenamed).toBe(false);
    expect(git(["rev-parse", "--verify", branch], repo)).toMatch(/^[0-9a-f]{40}$/);
  });
});
