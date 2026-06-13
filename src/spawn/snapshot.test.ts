/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBuildContext,
  SnapshotError,
  SNAPSHOT_EXCLUSION_PATTERNS,
} from "./snapshot.js";

/**
 * Integration tests for the snapshot module. These exercise the build-context
 * assembler against real temp git repositories — `git ls-files` is invoked
 * for real (no mocking) per Task 1's acceptance criteria.
 */
describe("snapshot", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix = "march-snapshot-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  /**
   * Initializes a real git repo, writes the given files, stages and commits
   * them, then returns the absolute path to the repo. `files` maps relative
   * file paths to their content. Empty directories are not created.
   */
  function makeRepoWithFiles(files: Record<string, string>): string {
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
    // Note: avoid `-b main` so this test fixture works on older git
    // versions that don't support the flag. Snapshot tests do not
    // reference the branch name.
    execFileSync("git", ["init", "-q"], { cwd: repoRoot, env });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    execFileSync("git", ["add", "-A"], { cwd: repoRoot, env });
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"],
      { cwd: repoRoot, env },
    );
    return repoRoot;
  }

  /** Recursively lists files under `root` relative to root (sorted). */
  function listRelativeFiles(root: string): string[] {
    const out: string[] = [];
    function walk(dir: string, rel: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childAbs = path.join(dir, entry.name);
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          walk(childAbs, childRel);
        } else {
          out.push(childRel);
        }
      }
    }
    walk(root, "");
    return out.sort();
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

  describe("SNAPSHOT_EXCLUSION_PATTERNS", () => {
    it("matches the contracts' exclusion list", () => {
      // Patterns match the contracts' Snapshot Exclusion List exactly.
      expect(SNAPSHOT_EXCLUSION_PATTERNS).toEqual([
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        ".secrets/",
        "credentials.json",
      ]);
    });
  });

  describe("createBuildContext", () => {
    it("returns a contextPath and cleanup handle", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        expect(typeof handle.contextPath).toBe("string");
        expect(typeof handle.cleanup).toBe("function");
        expect(fs.existsSync(handle.contextPath)).toBe(true);
        expect(fs.statSync(handle.contextPath).isDirectory()).toBe(true);
      } finally {
        handle.cleanup();
      }
    });

    it("populates the build context with all tracked files (FR-008)", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        "src/index.ts": "export {};\n",
        "src/lib/util.ts": "export const x = 1;\n",
        "package.json": "{}\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toEqual(
          [
            "README.md",
            "src/index.ts",
            "src/lib/util.ts",
            "package.json",
          ].map((p) => p.split("/").join(path.sep)).sort(),
        );

        // Files are real regular files (not symlinks): copies, not links.
        for (const rel of got) {
          const abs = path.join(handle.contextPath, rel);
          const lst = fs.lstatSync(abs);
          expect(lst.isSymbolicLink()).toBe(false);
          expect(lst.isFile()).toBe(true);
        }
      } finally {
        handle.cleanup();
      }
    });

    it("preserves file content byte-for-byte", () => {
      const content = "line one\nline two\n  indented\n";
      const repoRoot = makeRepoWithFiles({
        "src/file.txt": content,
      });
      const handle = createBuildContext(repoRoot);
      try {
        const copied = fs.readFileSync(
          path.join(handle.contextPath, "src", "file.txt"),
          "utf-8",
        );
        expect(copied).toBe(content);
      } finally {
        handle.cleanup();
      }
    });

    it("excludes untracked files (relies on `git ls-files`)", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
      });
      // Drop a file into the worktree but do NOT add/commit it.
      fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "nope\n");

      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        expect(got).not.toContain("untracked.txt");
      } finally {
        handle.cleanup();
      }
    });

    it("excludes the `.env` file at the top level (FR-009)", () => {
      const repoRoot = makeRepoWithFiles({
        ".env": "SECRET=1\n",
        "README.md": "hello\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        expect(got).not.toContain(".env");
      } finally {
        handle.cleanup();
      }
    });

    it("excludes nested `.env` files at any depth (recursive path-segment match)", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        "src/config/.env": "DEEP_SECRET=1\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        expect(
          got.some((p) => p.split(path.sep).pop() === ".env"),
        ).toBe(false);
      } finally {
        handle.cleanup();
      }
    });

    it("excludes `.env.*` variants at any depth", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        ".env.local": "X=1\n",
        ".env.production": "X=2\n",
        "config/.env.staging": "X=3\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        for (const p of got) {
          const last = p.split(path.sep).pop() ?? "";
          expect(last.startsWith(".env.")).toBe(false);
        }
      } finally {
        handle.cleanup();
      }
    });

    it("excludes `*.pem` and `*.key` private keys at any depth", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        "id_rsa.key": "PRIVATE\n",
        "tls/server.pem": "PRIVATE\n",
        "deep/nested/dir/leaf.pem": "PRIVATE\n",
        "deep/nested/dir/leaf.key": "PRIVATE\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        for (const p of got) {
          expect(p.endsWith(".pem")).toBe(false);
          expect(p.endsWith(".key")).toBe(false);
        }
      } finally {
        handle.cleanup();
      }
    });

    it("excludes any path containing a `.secrets` directory segment at any depth", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        ".secrets/api.txt": "S\n",
        "src/.secrets/key.txt": "S\n",
        "deep/nested/.secrets/inner/thing": "S\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        for (const p of got) {
          const segments = p.split(path.sep);
          expect(segments.includes(".secrets")).toBe(false);
        }
      } finally {
        handle.cleanup();
      }
    });

    it("excludes `credentials.json` at any depth but keeps similarly named files", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        "credentials.json": "{}\n",
        "config/credentials.json": "{}\n",
        // Files whose basename is NOT exactly "credentials.json" are kept.
        "config/credentials.json.example": "{}\n",
        "config/my-credentials.json": "{}\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got).toContain("README.md");
        // Exact-basename match excludes both top-level and nested.
        for (const p of got) {
          expect(p.split(path.sep).pop()).not.toBe("credentials.json");
        }
        // Non-exact basenames remain.
        expect(
          got.some((p) => p.endsWith("credentials.json.example")),
        ).toBe(true);
        expect(got.some((p) => p.endsWith("my-credentials.json"))).toBe(true);
      } finally {
        handle.cleanup();
      }
    });

    it("does NOT match `.env.*` patterns greedily across path separators", () => {
      // Sanity: `.env.*` is a basename glob, not a recursive directory
      // glob. A file like `notes/.envrc` should not be excluded by `.env.*`
      // since the basename `.envrc` does not match `.env.<anything>` (the
      // dot following `.env` is required by the pattern). Likewise,
      // `something.env.txt` should be kept because its basename is
      // `something.env.txt`, not `.env.txt`.
      const repoRoot = makeRepoWithFiles({
        "notes/.envrc": "x\n",
        "something.env.txt": "x\n",
      });
      const handle = createBuildContext(repoRoot);
      try {
        const got = listRelativeFiles(handle.contextPath);
        expect(got.some((p) => p.endsWith(".envrc"))).toBe(true);
        expect(got.some((p) => p.endsWith("something.env.txt"))).toBe(true);
      } finally {
        handle.cleanup();
      }
    });

    it("creates a unique context path per call", () => {
      const repoRoot = makeRepoWithFiles({ "README.md": "hello\n" });
      const a = createBuildContext(repoRoot);
      const b = createBuildContext(repoRoot);
      try {
        expect(a.contextPath).not.toBe(b.contextPath);
        expect(fs.existsSync(a.contextPath)).toBe(true);
        expect(fs.existsSync(b.contextPath)).toBe(true);
      } finally {
        a.cleanup();
        b.cleanup();
      }
    });

    it("places the context inside the OS temp directory", () => {
      const repoRoot = makeRepoWithFiles({ "README.md": "hello\n" });
      const handle = createBuildContext(repoRoot);
      try {
        const realTmp = fs.realpathSync(os.tmpdir());
        const realCtx = fs.realpathSync(handle.contextPath);
        expect(realCtx.startsWith(realTmp)).toBe(true);
      } finally {
        handle.cleanup();
      }
    });

    it("cleanup removes the context directory and all contents", () => {
      const repoRoot = makeRepoWithFiles({
        "README.md": "hello\n",
        "src/index.ts": "export {};\n",
      });
      const handle = createBuildContext(repoRoot);
      expect(fs.existsSync(handle.contextPath)).toBe(true);

      handle.cleanup();
      expect(fs.existsSync(handle.contextPath)).toBe(false);
    });

    it("cleanup is idempotent and does not throw if the directory is already gone", () => {
      const repoRoot = makeRepoWithFiles({ "README.md": "hello\n" });
      const handle = createBuildContext(repoRoot);
      handle.cleanup();
      expect(() => handle.cleanup()).not.toThrow();
      // Pre-deleting the directory before calling cleanup must also be safe.
      const handle2 = createBuildContext(repoRoot);
      fs.rmSync(handle2.contextPath, { recursive: true, force: true });
      expect(() => handle2.cleanup()).not.toThrow();
    });

    it("throws SnapshotError when the worktree path is not a git working tree", () => {
      const notARepo = makeTmpDir();
      expect(() => createBuildContext(notARepo)).toThrow(SnapshotError);
    });

    it("refuses to snapshot tracked symlinks (security: prevents host file exfiltration)", () => {
      // git stores symlinks as path → target. A tracked symlink whose
      // target lives outside the worktree (e.g. /etc/passwd) would, if
      // followed by fs.copyFileSync, copy host data into the build
      // context. Refuse with SnapshotError instead.
      const repoRoot = makeRepoWithFiles({ "README.md": "hello\n" });
      // Create a symlink and commit it. The target need not exist; git
      // tracks the link itself.
      fs.symlinkSync("/etc/passwd", path.join(repoRoot, "evil-link"));
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      execFileSync("git", ["add", "evil-link"], { cwd: repoRoot, env });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add link"],
        { cwd: repoRoot, env },
      );

      expect(() => createBuildContext(repoRoot)).toThrow(SnapshotError);
      expect(() => createBuildContext(repoRoot)).toThrow(/symlink/i);
    });

    it("skips submodule (gitlink) entries instead of throwing EISDIR", () => {
      // Submodules appear in `git ls-files` output but are directories
      // on disk. fs.copyFileSync would throw EISDIR on them; the
      // snapshot module must skip them (they have their own context).
      // Build a real submodule by initialising a child repo and adding
      // it via `git submodule add` from a file:// URL.
      const child = makeRepoWithFiles({ "child.txt": "child\n" });
      const parent = makeRepoWithFiles({ "README.md": "hello\n" });
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        // Newer git refuses `submodule add` of a local path without this
        // (CVE-2022-39253 mitigation); explicitly opt in for the test.
        GIT_ALLOW_PROTOCOL: "file:http:https:ssh:git",
      };
      try {
        execFileSync(
          "git",
          [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            `file://${child}`,
            "vendor/child",
          ],
          { cwd: parent, env },
        );
      } catch {
        // Older git or sandboxed envs may refuse local submodule adds
        // even with the override. Skip the test rather than fail; the
        // production code path is exercised at runtime when a real
        // submodule is present.
        return;
      }
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add submodule"],
        { cwd: parent, env },
      );

      const handle = createBuildContext(parent);
      try {
        const got = listRelativeFiles(handle.contextPath);
        // README is copied; the submodule directory is silently skipped.
        expect(got).toContain("README.md");
        // No file from inside the submodule made it into the context.
        for (const p of got) {
          expect(p.split(path.sep).includes("vendor")).toBe(false);
        }
      } finally {
        handle.cleanup();
      }
    });
  });
});
