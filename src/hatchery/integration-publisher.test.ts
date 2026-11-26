/**
 * @l1
 * @deterministic
 * @ci
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createIntegrationCommit, findIntegrationCommit, pushIntegrationCommit } from "./integration-publisher.js";

const branch = "feature/recorded/slice";
const branchRef = "refs/heads/" + branch;
let root: string;
let target: { target: string; branchRef: string };
let remote: string;
let patch: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function handoff() {
  return {
    spawnId: "spawn-test",
    backend: "codex",
    patchText: patch,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    touchedPaths: ["f"],
    extractedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "march-publisher-test-"));
  git(root, "init", "-qb", "main", "repo");
  const repo = path.join(root, "repo");
  target = { target: path.join(root, "integration"), branchRef };
  remote = path.join(root, "remote.git");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "f"), "base\n");
  git(repo, "add", "f");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-qb", branch, target.target);
  git(root, "init", "-q", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(target.target, "f"), "validated\n");
  patch = git(target.target, "diff", "--binary");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("commits the full validated index and leaves unrelated unstaged edits alone", () => {
  const cwd = target.target;
  git(cwd, "add", "f");
  fs.writeFileSync(path.join(cwd, "f"), "unstaged touched file edit\n");
  fs.writeFileSync(path.join(cwd, "extra"), "untracked\n");
  const input = handoff();
  const commit = createIntegrationCommit(target, input);

  expect(git(cwd, "show", commit.commitSha + ":f")).toBe("validated\n");
  expect(git(cwd, "show", "--format=", "--name-only", commit.commitSha)).toBe("f\n");
  expect(git(cwd, "status", "--short")).toBe(" M f\n?? extra\n");
  expect(findIntegrationCommit(target, input)).toEqual(commit);
  expect(createIntegrationCommit(target, input)).toEqual(commit);
  expect(git(cwd, "rev-list", "--count", branch).trim()).toBe("2");
});

it.each(["empty", "extra path", "modified touched path"])("rejects %s staging", (kind) => {
  const cwd = target.target;
  const original = git(cwd, "rev-parse", "HEAD");
  if (kind === "modified touched path") fs.appendFileSync(path.join(cwd, "f"), "extra edit\n");
  if (kind === "extra path") fs.writeFileSync(path.join(cwd, "extra"), "extra\n");
  if (kind !== "empty") git(cwd, "add", "--all");
  expect(() => createIntegrationCommit(target, handoff())).toThrow("unexpected_staged_tree");
  expect(git(cwd, "rev-parse", "HEAD")).toBe(original);
});

it("publishes the exact ref after a failed push and reuses the same commit", async () => {
  const cwd = target.target;
  git(cwd, "add", "f");
  const input = handoff();
  const commit = createIntegrationCommit(target, input);
  git(cwd, "remote", "set-url", "origin", path.join(root, "missing.git"));
  await expect(pushIntegrationCommit(target, input, commit)).rejects.toMatchObject({
    publication: { failureReason: "push_failed", branch, commit },
  });
  expect(findIntegrationCommit(target, input)).toEqual(commit);
  git(cwd, "remote", "set-url", "origin", remote);
  git(cwd, "push", remote, "HEAD^:" + branchRef);
  await expect(pushIntegrationCommit(target, input, commit)).resolves.toEqual(commit);
  await expect(pushIntegrationCommit(target, input, commit)).resolves.toEqual(commit);
  expect(git(remote, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(
    branchRef + " " + commit.commitSha + "\n",
  );
  // The checkout tracks the published head, as `git push -u` would leave it.
  expect(git(cwd, "rev-parse", "--symbolic-full-name", "@{upstream}").trim()).toBe("refs/remotes/origin/" + branch);
  expect(git(cwd, "rev-parse", "@{upstream}").trim()).toBe(commit.commitSha);
});

it("preserves a separately created divergent remote head", async () => {
  const cwd = target.target;
  const competing = git(cwd, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "separate remote commit").trim();
  git(cwd, "push", remote, competing + ":" + branchRef);
  const before = git(remote, "rev-parse", branchRef);
  git(cwd, "add", "f");
  const input = handoff();
  const commit = createIntegrationCommit(target, input);
  await expect(pushIntegrationCommit(target, input, commit)).rejects.toMatchObject({
    publication: { failureReason: "push_failed", commit },
  });
  expect(git(remote, "rev-parse", branchRef)).toBe(before);
});

it("accepts an equivalent remote commit with a different committer date", async () => {
  const cwd = target.target;
  git(cwd, "add", "f");
  const input = handoff();
  const commit = createIntegrationCommit(target, input);
  const message = git(cwd, "show", "-s", "--format=%B", commit.commitSha).trimEnd();
  const parent = git(cwd, "rev-parse", "HEAD^").trim();
  const tree = git(cwd, "write-tree").trim();
  const equivalent = execFileSync("git", ["commit-tree", tree, "-p", parent, "-m", message], {
    cwd,
    env: { ...process.env, GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
    encoding: "utf8",
  }).trim();
  git(cwd, "push", remote, equivalent + ":" + branchRef);

  expect(equivalent).not.toBe(commit.commitSha);
  await expect(pushIntegrationCommit(target, input, commit)).resolves.toMatchObject({
    branch, commitSha: equivalent, patchSha256: input.patchSha256,
  });
  expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(commit.commitSha);
  expect(git(cwd, "rev-parse", "@{upstream}").trim()).toBe(equivalent);
});

it("refuses to reuse a commit with matching metadata and different content", () => {
  const cwd = target.target;
  const input = handoff();
  fs.appendFileSync(path.join(cwd, "f"), "extra\n");
  git(cwd, "add", "f");
  git(cwd, "commit", "-qm", [
    "Integrate validated spawn changes", "",
    "March-Spawn-Id: " + input.spawnId,
    "March-Patch-SHA256: " + input.patchSha256,
  ].join("\n"));
  expect(findIntegrationCommit(target, input)).toBeUndefined();
  expect(() => createIntegrationCommit(target, input)).toThrow();
});
