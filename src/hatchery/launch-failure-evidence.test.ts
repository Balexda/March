/**
 * @l1 @deterministic @ci
 *
 * Real-git tests for launch-failure evidence (step 2) and the parked-spawn cap:
 * a diverged collision reports the unpushed SHAs a deletion would discard, a
 * declined spawn reports the blobs it declined at, and repeated identical
 * failures keep only the first and the latest parked worktree, removed by exact
 * path.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDeclinedFailure, artifactBlobs, collisionFailure, unpushedCommitEvidence } from "./launch-failure-evidence.js";
import { NO_COMMIT_MARKER } from "./launch-failure.js";
import { parkedManifestDir, pruneParkedSpawns, writeParkedSpawnManifest } from "./spawn-handoff.js";

const tmp: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  while (tmp.length) fs.rmSync(tmp.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

function repo(): string {
  const dir = tmpDir("lf-repo-");
  git(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "specs"));
  fs.writeFileSync(path.join(dir, "specs/x.tasks.md"), "Slice 1 must not be forged until SD-001 is resolved.\n");
  fs.writeFileSync(path.join(dir, "specs/x.spec.md"), "# spec\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("diverged collision evidence", () => {
  it("lists the unpushed commits and touched files on the colliding branch", () => {
    const dir = repo();
    const branch = "feature/smithy/forge/x-us1-s1";
    git(dir, "checkout", "-q", "-b", branch);
    const shas: string[] = [];
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `f${i % 3}.ts`), `v${i}\n`);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "work " + i);
      shas.unshift(git(dir, "rev-parse", "HEAD"));
    }
    git(dir, "checkout", "-q", "main");

    const evidence = unpushedCommitEvidence(dir, branch);
    expect(evidence.commitCount).toBe(12);
    expect(evidence.commits).toEqual(shas.slice(0, 10)); // bounded: the newest 10
    expect(evidence.touchedFileCount).toBe(3);

    const failure = collisionFailure({
      repoPath: dir, branch, verdict: { kind: "unsafe", reason: "diverged" }, worktreePath: "/wt/x",
    });
    expect(failure).toMatchObject({
      class: "branch_collision", retry: "operator",
      evidence: { branch, verdict: "unsafe:diverged", worktreePath: "/wt/x", commitCount: 12, touchedFileCount: 3 },
    });
  });
});

describe("agent_declined evidence", () => {
  it("records the base commit and each artifact's blob at it, plus the agent's message", () => {
    const dir = repo();
    const logs = '{"type":"item.completed","item":{"type":"agent_message","text":"Blocked on SD-001."}}\n' +
      "march-spawn: " + NO_COMMIT_MARKER;
    const failure = agentDeclinedFailure({ logs, worktreePath: dir, artifactPaths: ["specs/x.tasks.md", "specs/x.spec.md", "specs/gone.md"] });
    const tasksBlob = git(dir, "rev-parse", "HEAD:specs/x.tasks.md");
    expect(failure).toEqual({
      class: "agent_declined", retry: "until_input_changes", reason: "agent_declined",
      evidence: {
        agentMessage: "Blocked on SD-001.",
        baseCommit: git(dir, "rev-parse", "HEAD"),
        artifacts: [
          { path: "specs/x.tasks.md", blob: tasksBlob },
          { path: "specs/x.spec.md", blob: git(dir, "rev-parse", "HEAD:specs/x.spec.md") },
          { path: "specs/gone.md", blob: null },
        ],
      },
    });
  });

  it("a plan change on the default branch changes the blob the legate compares", () => {
    const dir = repo();
    const before = artifactBlobs(dir, "HEAD", ["specs/x.tasks.md"])!;
    fs.writeFileSync(path.join(dir, "specs/x.tasks.md"), "SD-001 resolved; build it.\n");
    git(dir, "commit", "-q", "-am", "resolve SD-001");
    const after = artifactBlobs(dir, "HEAD", ["specs/x.tasks.md"])!;
    expect(after[0].blob).not.toBe(before[0].blob);
  });
});

describe("parked spawn cap", () => {
  it("N identical failures leave only the first and latest parked worktrees, removed by exact path", () => {
    const dir = repo();
    const home = tmpDir("lf-home-");
    const parent = tmpDir("lf-wt-");
    const sliceId = "tessera-us3-s1-forge";
    const parked: { spawnId: string; worktree: string; branch: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const spawnId = `20261127-00000${i}`;
      const branch = `parked/${spawnId}/smithy/forge/x`;
      const worktree = path.join(parent, `x-parked-${spawnId}`);
      git(dir, "worktree", "add", "-q", "-b", branch, worktree);
      writeParkedSpawnManifest(home, {
        spawnId, sliceId, profile: "march", repoPath: dir, failureClass: "agent_declined",
        parkedAt: new Date(Date.UTC(2026, 10, 27, i)).toISOString(),
        parkedBranch: branch, parkedWorktreePath: worktree,
      });
      parked.push({ spawnId, worktree, branch });
    }
    // An unrelated worktree and a different failure class for the same slice stay.
    const other = path.join(parent, "unrelated");
    git(dir, "worktree", "add", "-q", "-b", "feature/unrelated", other);
    writeParkedSpawnManifest(home, {
      spawnId: "20261127-ffffff", sliceId, profile: "march", repoPath: dir, failureClass: "patch_apply_failed",
      parkedAt: "2026-11-27T02:30:00.000Z", parkedBranch: "feature/unrelated", parkedWorktreePath: other,
    });

    // Another repo's parks of the same slice id and class share the directory and stay.
    const foreign = path.join(parent, "foreign");
    fs.mkdirSync(foreign);
    for (let i = 0; i < 3; i++) {
      writeParkedSpawnManifest(home, {
        spawnId: `20261127-aaaaa${i}`, sliceId, profile: "other", repoPath: "/elsewhere", failureClass: "agent_declined",
        parkedAt: new Date(Date.UTC(2026, 10, 27, i, 30)).toISOString(), parkedBranch: "x", parkedWorktreePath: foreign,
      });
    }

    const containers: string[] = [];
    const removed = pruneParkedSpawns(
      { repoPath: dir, homeDir: home, profile: "march", sliceId, failureClass: "agent_declined" },
      { removeContainer: (id) => containers.push(id), removeImage: () => {} },
    );

    expect(removed.sort()).toEqual(parked.slice(1, 4).map((p) => p.spawnId).sort());
    expect(containers.sort()).toEqual(removed.sort());
    for (const p of [parked[0], parked[4]]) {
      expect(fs.existsSync(p.worktree)).toBe(true);
      expect(git(dir, "branch", "--list", p.branch)).not.toBe("");
    }
    for (const p of parked.slice(1, 4)) {
      expect(fs.existsSync(p.worktree)).toBe(false);
      expect(git(dir, "branch", "--list", p.branch)).toBe("");
    }
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    const manifests = fs.readdirSync(parkedManifestDir(home)).sort();
    expect(manifests).toEqual([parked[0].spawnId, parked[4].spawnId, "20261127-ffffff",
      "20261127-aaaaa0", "20261127-aaaaa1", "20261127-aaaaa2"].map((id) => id + ".json").sort());

    // Idempotent: a second sweep has nothing left to remove.
    expect(pruneParkedSpawns({ repoPath: dir, homeDir: home, profile: "march", sliceId, failureClass: "agent_declined" },
      { removeContainer: () => {}, removeImage: () => {} })).toEqual([]);
  });
});
