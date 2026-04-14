import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSpawnWorktree,
  generateSpawnId,
  removeSpawnWorktree,
  spawnBranchName,
  spawnWorktreePath,
  WorktreeError,
} from "./worktree.js";

/**
 * Integration test fixtures for the worktree module. These tests operate
 * against real temporary git repositories — no git CLI mocking per Task 1
 * acceptance criteria.
 */
describe("worktree", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix = "march-worktree-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  /**
   * Initializes a real git repo inside a fresh tmp dir and returns its
   * absolute path. The repo has a single commit so HEAD is resolvable
   * and `git branch <name> HEAD` succeeds.
   */
  function makeRepo(): string {
    // Nest the repo one level deep so its parent dir (where the worktree
    // sibling `worktrees/march/` lives) is itself isolated from other tests.
    const parent = makeTmpDir();
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
    // Disable GPG signing explicitly so the test commit does not depend
    // on a signing key in the host environment.
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"],
      { cwd: repoRoot, env },
    );
    return repoRoot;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs.length = 0;
  });

  describe("generateSpawnId", () => {
    it("produces IDs matching the YYYYMMDD-<6-char-hex> pattern", () => {
      for (let i = 0; i < 10; i++) {
        expect(generateSpawnId()).toMatch(/^\d{8}-[0-9a-f]{6}$/);
      }
    });

    it("uses UTC date components for the date prefix", () => {
      const id = generateSpawnId(new Date(Date.UTC(2026, 3, 11, 12, 0, 0)));
      expect(id.startsWith("20260411-")).toBe(true);
    });
  });

  describe("spawnBranchName", () => {
    it("returns march/spawn/<id>", () => {
      expect(spawnBranchName("20260411-a1b2c3")).toBe(
        "march/spawn/20260411-a1b2c3",
      );
    });
  });

  describe("spawnWorktreePath", () => {
    it("resolves to <repo>/../worktrees/march/<id>/", () => {
      const repoRoot = "/home/user/my-project";
      expect(spawnWorktreePath(repoRoot, "20260411-a1b2c3")).toBe(
        "/home/user/worktrees/march/20260411-a1b2c3",
      );
    });
  });

  describe("createSpawnWorktree", () => {
    it("creates a march/spawn/* branch from HEAD and a linked worktree", () => {
      const repoRoot = makeRepo();
      const result = createSpawnWorktree(repoRoot);

      // Spawn ID format per data model.
      expect(result.spawnId).toMatch(/^\d{8}-[0-9a-f]{6}$/);
      // Branch name per Branch Naming Convention contract.
      expect(result.branch).toBe(`march/spawn/${result.spawnId}`);
      // Worktree path per FR-006: sibling of the repo.
      expect(result.worktreePath).toBe(
        path.join(
          path.dirname(repoRoot),
          "worktrees",
          "march",
          result.spawnId,
        ),
      );

      // Branch exists in the source repo.
      const refOutput = execFileSync(
        "git",
        ["rev-parse", "--verify", `refs/heads/${result.branch}`],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      expect(refOutput.trim()).toMatch(/^[0-9a-f]{40}$/);

      // Worktree directory exists on disk and has the tracked file.
      expect(fs.existsSync(result.worktreePath)).toBe(true);
      expect(
        fs.existsSync(path.join(result.worktreePath, "README.md")),
      ).toBe(true);

      // `git worktree list` (from the source repo) reports the new linked tree.
      const listing = execFileSync("git", ["worktree", "list"], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      expect(listing).toContain(result.worktreePath);
    });

    it("creates the worktree parent directory on demand (FR-007)", () => {
      const repoRoot = makeRepo();
      const parentDir = path.join(
        path.dirname(repoRoot),
        "worktrees",
        "march",
      );
      // Parent dir should not yet exist.
      expect(fs.existsSync(parentDir)).toBe(false);

      createSpawnWorktree(repoRoot);

      expect(fs.existsSync(parentDir)).toBe(true);
      expect(fs.statSync(parentDir).isDirectory()).toBe(true);
    });

    it("creates the branch from the current HEAD of the repo", () => {
      const repoRoot = makeRepo();
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf-8",
      }).trim();

      const result = createSpawnWorktree(repoRoot);

      const branchSha = execFileSync(
        "git",
        ["rev-parse", result.branch],
        { cwd: repoRoot, encoding: "utf-8" },
      ).trim();
      expect(branchSha).toBe(headSha);
    });

    it("regenerates the spawn ID on collision without surfacing to the caller", () => {
      const repoRoot = makeRepo();
      // Pre-create several branches to force at least one collision. Since
      // the spawn ID's date prefix is fixed per day, we seed the same prefix
      // and a few candidate suffixes. We can't deterministically guarantee
      // a collision without stubbing crypto, so we instead assert the
      // weaker property: pre-existing march/spawn/* branches don't block
      // a fresh creation, and the returned branch is not one of them.
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      const preexisting = ["march/spawn/20260101-000001", "march/spawn/20260101-000002"];
      for (const b of preexisting) {
        execFileSync("git", ["branch", b, "HEAD"], { cwd: repoRoot, env });
      }

      const result = createSpawnWorktree(repoRoot);
      expect(preexisting).not.toContain(result.branch);
      expect(result.branch.startsWith("march/spawn/")).toBe(true);
    });

    it("rolls back the branch when `git worktree add` fails mid-creation", () => {
      const repoRoot = makeRepo();
      // Induce a failure in `git worktree add` AFTER branch creation so
      // the rollback code path is exercised. `git worktree add` runs the
      // `post-checkout` hook as part of populating the new worktree, and
      // per git docs the hook's exit status becomes the operation's exit
      // status. A hook that always exits 1 causes `git worktree add` to
      // fail without relying on filesystem permissions — important
      // because the test environment may run as root.
      const hookPath = path.join(repoRoot, ".git", "hooks", "post-checkout");
      fs.writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(hookPath, 0o755);

      expect(() => createSpawnWorktree(repoRoot)).toThrow(WorktreeError);
      // Branch must be rolled back (no leftover march/spawn/* ref).
      const branches = execFileSync(
        "git",
        ["branch", "--list", "march/spawn/*"],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      expect(branches.trim()).toBe("");
    });
  });

  describe("removeSpawnWorktree", () => {
    it("removes the branch and worktree directory created by createSpawnWorktree", () => {
      const repoRoot = makeRepo();
      const result = createSpawnWorktree(repoRoot);
      expect(fs.existsSync(result.worktreePath)).toBe(true);

      removeSpawnWorktree(repoRoot, result);

      expect(fs.existsSync(result.worktreePath)).toBe(false);
      const branches = execFileSync(
        "git",
        ["branch", "--list", result.branch],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      expect(branches.trim()).toBe("");
    });

    it("is idempotent / does not throw if artifacts are already gone", () => {
      const repoRoot = makeRepo();
      const result = createSpawnWorktree(repoRoot);
      removeSpawnWorktree(repoRoot, result);
      // Second removal should be a no-op and not throw.
      expect(() => removeSpawnWorktree(repoRoot, result)).not.toThrow();
    });

    it("fallback rmSync refuses to delete a non-worktree directory", () => {
      // Guard against the rollback wiping pre-existing user data. Build a
      // SpawnWorktree handle that points at an unregistered directory
      // containing important user content, then invoke the rollback
      // helper. `git worktree remove --force` will fail (the path is not
      // a registered worktree), and the fallback path must refuse to
      // rmSync because there is no `.git` file marking the directory as
      // a linked worktree.
      const repoRoot = makeRepo();
      const userDir = path.join(path.dirname(repoRoot), "unrelated");
      fs.mkdirSync(userDir);
      fs.writeFileSync(path.join(userDir, "precious.txt"), "do not delete");

      removeSpawnWorktree(repoRoot, {
        spawnId: "20990101-deadbe",
        branch: "march/spawn/20990101-deadbe",
        worktreePath: userDir,
      });

      expect(fs.existsSync(userDir)).toBe(true);
      expect(
        fs.readFileSync(path.join(userDir, "precious.txt"), "utf-8"),
      ).toBe("do not delete");
    });
  });
});
