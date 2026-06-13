/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyBranchSafety,
  describeVerdict,
  findWorktreePathForBranch,
  verdictLabel,
  type CommandResult,
  type CommandRunner,
} from "./orphan-branch.js";

// Issue #243: the Hatchery self-heal must apply the SAME refuse/allow contract as
// the legate.unwedge validator. These tests pin the verdict ladder by faking the
// git/gh command surface so the classification logic is exercised without a real
// repo or `gh`.

const BRANCH = "feature/smithy/mark/march-orchestration-platform-m1-f6";

/**
 * Build a CommandRunner from a map of "file arg arg ..." -> result. Unmatched
 * commands default to a clean exit with empty stdout, so each test only declares
 * the commands whose outcome it cares about.
 */
function fakeRunner(
  map: Record<string, Partial<CommandResult>>,
): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = (file, args) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    const hit = map[key];
    return { code: hit?.code ?? 0, stdout: hit?.stdout ?? "" };
  };
  return { run, calls };
}

const showRef = `git show-ref --verify --quiet refs/heads/${BRANCH}`;
const symbolicRef = "git symbolic-ref --short refs/remotes/origin/HEAD";
const mergeBase = `git merge-base --is-ancestor ${BRANCH} main`;
const lsRemote = `git ls-remote --exit-code origin refs/heads/${BRANCH}`;
const prList = `gh pr list --head ${BRANCH} --state all --json number,state`;

// The forge-dependent (`gh`) ladder only runs for branches that ARE on a remote
// (#249), so these tests mark the branch on-remote explicitly via `lsRemote`.
describe("classifyBranchSafety (on-remote, forge-dependent path)", () => {
  it("returns absent when the branch does not exist", () => {
    const { run } = fakeRunner({ [showRef]: { code: 1 } });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({ kind: "absent" });
  });

  it("classifies an ancestor-of-default branch with no PRs as safe:orphan-ref", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 },
      [lsRemote]: { code: 0 },
      [prList]: { code: 0, stdout: "[]" },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
  });

  it("classifies a diverged branch whose PR merged as safe:post-merge-stale", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 1 }, // not an ancestor — has unique commits
      [lsRemote]: { code: 0 },
      [prList]: { code: 0, stdout: JSON.stringify([{ number: 42, state: "MERGED" }]) },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "safe",
      reason: "post-merge-stale",
      detail: "#42",
    });
  });

  it("refuses a branch with an open PR (#173 adopt path, not delete)", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 }, // even an ancestor must not be deleted with an open PR
      [lsRemote]: { code: 0 },
      [prList]: { code: 0, stdout: JSON.stringify([{ number: 7, state: "OPEN" }]) },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "unsafe",
      reason: "open-pr",
      detail: "#7",
    });
  });

  it("refuses diverged unmerged work as unsafe:diverged", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 1 },
      [lsRemote]: { code: 0 },
      [prList]: { code: 0, stdout: "[]" },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "unsafe",
      reason: "diverged",
    });
  });

  it("refuses when the PR list could not be retrieved (gh failed)", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 },
      [lsRemote]: { code: 0 },
      [prList]: { code: 1, stdout: "" },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "unsafe",
      reason: "pr-lookup-unknown",
    });
  });

  it("refuses when the PR list is unparseable JSON", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 },
      [lsRemote]: { code: 0 },
      [prList]: { code: 0, stdout: "not json" },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "unsafe",
      reason: "pr-lookup-unknown",
    });
  });

  it("falls back to gh for the default branch when origin/HEAD is unset", () => {
    const ghDefault = "gh repo view --json defaultBranchRef -q .defaultBranchRef.name";
    const { run, calls } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { code: 1, stdout: "" },
      [ghDefault]: { stdout: "main\n" },
      [mergeBase]: { code: 0 },
      [lsRemote]: { code: 0 },
      [prList]: { code: 0, stdout: "[]" },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
    expect(calls).toContain(ghDefault);
  });
});

// #249: the no-remote fast-path. A branch on no remote cannot have a PR, so the
// verdict comes from local git alone — `gh` is NEVER consulted (it isn't even
// installed in the hatchery container). This is the path that makes the #243
// self-heal actually work in production.
describe("classifyBranchSafety no-remote fast-path (#249)", () => {
  it("removes a safe local orphan (ancestor of default) without calling gh", () => {
    const { run, calls } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 },
      [lsRemote]: { code: 2 }, // --exit-code: ref absent on origin
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
    // No forge call — hatchery must work with no gh installed.
    expect(calls.some((c) => c.startsWith("gh pr list"))).toBe(false);
  });

  it("escalates a genuinely diverged local-only branch as unsafe:diverged without gh", () => {
    const { run, calls } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 1 }, // has unique commits not on default
      [lsRemote]: { code: 2 },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "unsafe",
      reason: "diverged",
    });
    expect(calls.some((c) => c.startsWith("gh pr list"))).toBe(false);
  });

  it("treats an unreachable origin (non-zero, non-2 exit) as no-remote", () => {
    const { run, calls } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 },
      [lsRemote]: { code: 128 }, // e.g. network failure
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
    expect(calls.some((c) => c.startsWith("gh pr list"))).toBe(false);
  });
});

// End-to-end against REAL git (default runner, no injected commands) so the
// "no gh in the container" condition #249 fixes is faithfully exercised: an
// unpushed local branch makes `git ls-remote --exit-code` exit non-zero, and the
// verdict is reached without ever invoking `gh`. A local bare repo stands in for
// `origin` so the test is offline.
describe("classifyBranchSafety no-remote fast-path against real git (#249)", () => {
  const tmpDirs: string[] = [];

  function makeRepoWithLocalOnlyBranches(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-remote-git-"));
    tmpDirs.push(root);
    const work = path.join(root, "work");
    const remote = path.join(root, "remote.git");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });

    execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "ignore" });
    git(work, "config", "user.email", "t@t");
    git(work, "config", "user.name", "t");
    fs.writeFileSync(path.join(work, "f"), "a\n");
    git(work, "add", "f");
    git(work, "commit", "-qm", "init");

    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "-q", "-u", "origin", "main");
    git(work, "remote", "set-head", "origin", "main");

    // A local-only orphan at main HEAD (ancestor, no unique commits)...
    git(work, "branch", "orphan", "main");
    // ...and a local-only branch with a unique unpushed commit (diverged).
    git(work, "checkout", "-q", "-b", "diverged", "main");
    fs.appendFileSync(path.join(work, "f"), "b\n");
    git(work, "add", "f");
    git(work, "commit", "-qm", "extra");
    git(work, "checkout", "-q", "main");
    return work;
  }

  afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("removes a safe local-only orphan branch (real ls-remote miss, no gh)", () => {
    const work = makeRepoWithLocalOnlyBranches();
    expect(classifyBranchSafety(work, "orphan")).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
  });

  it("escalates a diverged local-only branch as unsafe:diverged (real, no gh)", () => {
    const work = makeRepoWithLocalOnlyBranches();
    expect(classifyBranchSafety(work, "diverged")).toEqual({
      kind: "unsafe",
      reason: "diverged",
    });
  });
});

describe("findWorktreePathForBranch", () => {
  const porcelain = [
    "worktree /home/u/Development/March",
    "HEAD 4d217e2",
    "branch refs/heads/main",
    "",
    `worktree /home/u/Development/WorkTrees/March/feature-smithy-mark-m1-f6`,
    "HEAD abc1234",
    `branch refs/heads/${BRANCH}`,
    "",
  ].join("\n");

  it("returns the exact path of the worktree holding the branch", () => {
    const { run } = fakeRunner({
      "git worktree list --porcelain": { code: 0, stdout: porcelain },
    });
    expect(findWorktreePathForBranch("/repo", BRANCH, run)).toBe(
      "/home/u/Development/WorkTrees/March/feature-smithy-mark-m1-f6",
    );
  });

  it("returns undefined when no worktree holds the branch", () => {
    const { run } = fakeRunner({
      "git worktree list --porcelain": {
        code: 0,
        stdout: "worktree /home/u/Development/March\nHEAD x\nbranch refs/heads/main\n",
      },
    });
    expect(findWorktreePathForBranch("/repo", BRANCH, run)).toBeUndefined();
  });

  it("returns undefined when git worktree list fails", () => {
    const { run } = fakeRunner({
      "git worktree list --porcelain": { code: 1, stdout: "" },
    });
    expect(findWorktreePathForBranch("/repo", BRANCH, run)).toBeUndefined();
  });
});

describe("verdict formatting", () => {
  it("verdictLabel is a bounded kind:reason (no PR ids)", () => {
    expect(verdictLabel({ kind: "absent" })).toBe("absent");
    expect(verdictLabel({ kind: "safe", reason: "orphan-ref" })).toBe("safe:orphan-ref");
    expect(
      verdictLabel({ kind: "unsafe", reason: "open-pr", detail: "#7" }),
    ).toBe("unsafe:open-pr");
  });

  it("describeVerdict includes PR detail for humans", () => {
    expect(describeVerdict({ kind: "unsafe", reason: "open-pr", detail: "#7" })).toContain(
      "#7",
    );
    expect(describeVerdict({ kind: "safe", reason: "orphan-ref" })).toContain(
      "orphan-ref",
    );
  });
});
