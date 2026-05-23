import { describe, expect, it } from "vitest";
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
const prList = `gh pr list --head ${BRANCH} --state all --json number,state`;

describe("classifyBranchSafety", () => {
  it("returns absent when the branch does not exist", () => {
    const { run } = fakeRunner({ [showRef]: { code: 1 } });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({ kind: "absent" });
  });

  it("classifies an ancestor-of-default branch with no PRs as safe:orphan-ref", () => {
    const { run } = fakeRunner({
      [showRef]: { code: 0 },
      [symbolicRef]: { stdout: "origin/main\n" },
      [mergeBase]: { code: 0 },
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
      [prList]: { code: 0, stdout: "[]" },
    });
    expect(classifyBranchSafety("/repo", BRANCH, run)).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
    expect(calls).toContain(ghDefault);
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
