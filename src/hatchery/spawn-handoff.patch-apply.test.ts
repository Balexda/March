import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPatchToManagerWorktree,
  firstGitRejectLine,
  offendingPathFromReject,
  PatchApplyError,
  summarizePatch,
} from "./spawn-handoff.js";

// Issue #244: steward.apply must (a) fall back to `git apply --index --3way` so a
// new-file-on-existing patch the base already contains can still merge, and (b)
// surface a parsed diagnostic (offending path + reject) when even --3way can't
// resolve it. These tests use a real temp git repo so the git behavior is real.

const tmpDirs: string[] = [];
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-apply-"));
  tmpDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f"), "hello\n");
  git("add", "f");
  git("commit", "-qm", "init");
  return dir;
}

function writePatch(dir: string, content: string): string {
  const p = path.join(dir, "worker.patch");
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("applyPatchToManagerWorktree", () => {
  it("applies a clean patch with plain --index", () => {
    const repo = makeRepo();
    const patch = writePatch(
      repo,
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-hello\n+world\n",
    );
    const strategy = applyPatchToManagerWorktree({ patchPath: patch, worktreePath: repo });
    expect(strategy).toBe("index");
    expect(fs.readFileSync(path.join(repo, "f"), "utf-8")).toBe("world\n");
  });

  it("falls back to --3way for a new-file patch the base already contains (#244 root cause)", () => {
    const repo = makeRepo();
    // The worker emitted a "new file" patch for `f`, but `f` already exists in the
    // base with identical content — plain --index rejects ("already exists in
    // index"), but the 3-way merge resolves it cleanly.
    const blob = execFileSync("git", ["hash-object", path.join(repo, "f")], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    const patch = writePatch(
      repo,
      `diff --git a/f b/f\nnew file mode 100644\nindex 0000000..${blob}\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+hello\n`,
    );
    const strategy = applyPatchToManagerWorktree({ patchPath: patch, worktreePath: repo });
    expect(strategy).toBe("index-3way");
  });

  it("throws PatchApplyError with the offending path when even --3way conflicts", () => {
    const repo = makeRepo();
    // New-file patch for the existing `f` but with conflicting content and a blob
    // git can't reconstruct — neither --index nor --3way can apply it.
    const patch = writePatch(
      repo,
      "diff --git a/f b/f\nnew file mode 100644\nindex 0000000..deadbee\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+totally different content\n",
    );
    try {
      applyPatchToManagerWorktree({ patchPath: patch, worktreePath: repo });
      throw new Error("expected applyPatchToManagerWorktree to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchApplyError);
      const e = err as PatchApplyError;
      expect(e.offendingPath).toBe("f");
      expect(e.firstRejectLine).toBeTruthy();
      // The combined stderr keeps both rejects for root-cause-from-telemetry.
      expect(e.stderr).toContain("already exists in index");
    }
  });

  it("throws a plain HatcherySpawnError (not PatchApplyError) when the worktree is missing", () => {
    const patch = writePatch(makeRepo(), "diff --git a/f b/f\n");
    expect(() =>
      applyPatchToManagerWorktree({
        patchPath: patch,
        worktreePath: path.join(os.tmpdir(), "missing-" + Date.now()),
      }),
    ).toThrow(/manager worktree not found/);
  });
});

describe("summarizePatch", () => {
  it("counts files, bytes, and the first target path", () => {
    const dir = makeRepo();
    const content =
      "diff --git a/docs/a.md b/docs/a.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+x\n" +
      "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const p = writePatch(dir, content);
    const summary = summarizePatch(p);
    expect(summary.files).toBe(2);
    expect(summary.firstPath).toBe("docs/a.md");
    expect(summary.bytes).toBe(Buffer.byteLength(content, "utf-8"));
  });

  it("returns zeroes for a missing patch file", () => {
    expect(summarizePatch(path.join(os.tmpdir(), "nope-" + Date.now()))).toEqual({
      files: 0,
      bytes: 0,
      firstPath: undefined,
    });
  });
});

describe("reject parsing", () => {
  it("extracts the offending path from 'already exists in index'", () => {
    const line = firstGitRejectLine("error: docs/x.md: already exists in index");
    expect(line).toBe("error: docs/x.md: already exists in index");
    expect(offendingPathFromReject(line)).toBe("docs/x.md");
  });

  it("extracts the offending path from 'patch failed: <path>:<line>'", () => {
    const line = firstGitRejectLine(
      "error: patch failed: src/a.ts:12\nerror: src/a.ts: patch does not apply",
    );
    expect(offendingPathFromReject(line)).toBe("src/a.ts");
  });

  it("extracts the offending path from a --3way conflict summary (no error: line)", () => {
    const stderr = "Performing three-way merge...\nApplied patch to 'f' with conflicts.\nU f";
    const line = firstGitRejectLine(stderr);
    expect(offendingPathFromReject(line)).toBe("f");
  });

  it("returns undefined for empty stderr", () => {
    expect(firstGitRejectLine("")).toBeUndefined();
    expect(offendingPathFromReject(undefined)).toBeUndefined();
  });
});
