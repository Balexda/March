/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpawnWorktree, removeSpawnWorktreeExact } from "./worktree.js";

/**
 * Exact-path worktree removal — the #155 regression suite. Operates against
 * real temporary git repositories (no git CLI mocking) so the absence of a
 * blanket `git worktree prune` is proven against real git behavior.
 */
describe("removeSpawnWorktreeExact", () => {
  const tmpDirs: string[] = [];

  function makeRepo(): string {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brood-wt-exact-"));
    tmpDirs.push(parent);
    const repoRoot = path.join(parent, "repo");
    fs.mkdirSync(repoRoot);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot, env });
    fs.writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot, env });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"],
      { cwd: repoRoot, env },
    );
    return repoRoot;
  }

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

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs.length = 0;
  });

  it("removes only the exact worktree + branch it is handed", () => {
    const repoRoot = makeRepo();
    const wt = createSpawnWorktree(repoRoot);

    const result = removeSpawnWorktreeExact(repoRoot, {
      worktreePath: wt.worktreePath,
      branch: wt.branch,
    });

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(fs.existsSync(wt.worktreePath)).toBe(false);
    expect(branchExists(repoRoot, wt.branch)).toBe(false);
  });

  it("never prunes a sibling worktree whose checkout is missing (#155)", () => {
    const repoRoot = makeRepo();
    const a = createSpawnWorktree(repoRoot);
    const b = createSpawnWorktree(repoRoot);

    // Simulate A's checkout not being visible — e.g. its directory lives outside
    // the volumes mounted into a container. Its git admin entry remains.
    fs.rmSync(a.worktreePath, { recursive: true, force: true });
    const adminA = path.join(repoRoot, ".git", "worktrees", a.spawnId);
    expect(fs.existsSync(adminA)).toBe(true);

    removeSpawnWorktreeExact(repoRoot, {
      worktreePath: b.worktreePath,
      branch: b.branch,
    });

    // B is gone...
    expect(fs.existsSync(b.worktreePath)).toBe(false);
    expect(branchExists(repoRoot, b.branch)).toBe(false);
    // ...and A's admin entry + branch SURVIVE. A blanket `git worktree prune`
    // would have deleted A's admin entry because its checkout is missing — that
    // is exactly the corruption issue #155 is about.
    expect(fs.existsSync(adminA)).toBe(true);
    expect(branchExists(repoRoot, a.branch)).toBe(true);
  });

  it("removes worktree-only or branch-only when the other field is omitted", () => {
    const repoRoot = makeRepo();
    const wt = createSpawnWorktree(repoRoot);

    // Worktree only — branch survives.
    const r1 = removeSpawnWorktreeExact(repoRoot, {
      worktreePath: wt.worktreePath,
    });
    expect(r1.worktreeRemoved).toBe(true);
    expect(fs.existsSync(wt.worktreePath)).toBe(false);
    expect(branchExists(repoRoot, wt.branch)).toBe(true);

    // Branch only — now removed.
    const r2 = removeSpawnWorktreeExact(repoRoot, { branch: wt.branch });
    expect(r2.branchDeleted).toBe(true);
    expect(branchExists(repoRoot, wt.branch)).toBe(false);
  });

  it("is idempotent — a second call against gone artifacts is a no-op", () => {
    const repoRoot = makeRepo();
    const wt = createSpawnWorktree(repoRoot);
    removeSpawnWorktreeExact(repoRoot, {
      worktreePath: wt.worktreePath,
      branch: wt.branch,
    });
    const again = removeSpawnWorktreeExact(repoRoot, {
      worktreePath: wt.worktreePath,
      branch: wt.branch,
    });
    expect(again.worktreeRemoved).toBe(true);
    expect(again.branchDeleted).toBe(true);
  });

  it("omitting both fields is a no-op success", () => {
    const repoRoot = makeRepo();
    const result = removeSpawnWorktreeExact(repoRoot, {});
    expect(result).toEqual({ worktreeRemoved: true, branchDeleted: true });
  });
});
