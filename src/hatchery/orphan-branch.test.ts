/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyBranchSafety,
  describeVerdict,
  findWorktreePathForBranch,
  verdictLabel,
  type CommandResult,
  type CommandRunner,
} from "./orphan-branch.js";

import * as forge from "./github-read.js";

vi.mock("./github-read.js", { spy: true });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(forge.resolveHatcheryOrigin).mockReset();
  vi.mocked(forge.runHatcheryNetworkGit).mockReset();
  vi.mocked(forge.readHatcheryGitHubJson).mockReset();
});

// Issue #243: the Hatchery self-heal must apply the SAME refuse/allow contract as
// the legate.unwedge validator. These tests pin the verdict ladder by faking the
// local git and forge boundaries so classification is exercised without a real
// GitHub request.

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
const mergeBase = `git merge-base --is-ancestor refs/heads/${BRANCH} refs/heads/main`;
const origin = { url: "https://github.com/team/repo.git", repo: "team/repo" };
const HEAD_SHA = "a".repeat(40);
const mergedHeadCheck = `git merge-base --is-ancestor refs/heads/${BRANCH} ${HEAD_SHA}`;

function mockRemote(status: number, prs: unknown = []) {
  vi.mocked(forge.resolveHatcheryOrigin).mockResolvedValue(origin);
  vi.mocked(forge.runHatcheryNetworkGit).mockResolvedValue(status);
  vi.mocked(forge.readHatcheryGitHubJson).mockResolvedValue(prs);
}

describe("forge-dependent collision checks", () => {
  it("skips remote operations for absent branches", async () => {
    const { run } = fakeRunner({ [showRef]: { code: 1 } });
    expect(await classifyBranchSafety("/repo", BRANCH, run)).toEqual({ kind: "absent" });
    expect(forge.resolveHatcheryOrigin).not.toHaveBeenCalled();
  });

  it.each([
    [0, [], { kind: "safe", reason: "orphan-ref" }],
    [1, [], { kind: "unsafe", reason: "diverged" }],
    [0, [{ number: 7, state: "open", merged_at: null, head: { sha: HEAD_SHA } }], { kind: "unsafe", reason: "open-pr", detail: "#7" }],
    [1, [{ number: 42, state: "closed", merged_at: "2026-11-19", head: { sha: HEAD_SHA } }], { kind: "safe", reason: "post-merge-stale", detail: "#42" }],
  ] as const)("classifies existing branches with ancestry %i and PRs %j", async (ancestor, prs, verdict) => {
    mockRemote(0, prs);
    const { run } = fakeRunner({ [symbolicRef]: { stdout: "origin/main" }, [mergeBase]: { code: ancestor } });
    expect(await classifyBranchSafety("/repo", BRANCH, run, "slice-3")).toEqual(verdict);
    expect(forge.readHatcheryGitHubJson).toHaveBeenCalledWith(
      "team/repo", "/pulls?state=all&per_page=100&head=" + encodeURIComponent("team:" + BRANCH), "slice-3",
    );
  });

  it("resolves missing default-branch metadata through the same scoped lookup", async () => {
    mockRemote(0);
    vi.mocked(forge.readHatcheryGitHubJson).mockResolvedValueOnce([]).mockResolvedValueOnce({ default_branch: "main" });
    const { run, calls } = fakeRunner({});
    expect(await classifyBranchSafety("/repo", BRANCH, run)).toEqual({ kind: "safe", reason: "orphan-ref" });
    expect(calls).toContain(mergeBase);
    expect(forge.readHatcheryGitHubJson).toHaveBeenLastCalledWith("team/repo", "", undefined);
  });

  it("resolves missing default-branch metadata for an unpushed collision branch", async () => {
    mockRemote(2);
    vi.mocked(forge.readHatcheryGitHubJson).mockResolvedValueOnce({ default_branch: "main" });
    const { run, calls } = fakeRunner({});
    expect(await classifyBranchSafety("/repo", BRANCH, run, "slice-3")).toEqual({ kind: "safe", reason: "orphan-ref" });
    expect(calls).toContain(mergeBase);
    expect(forge.readHatcheryGitHubJson).toHaveBeenCalledTimes(1);
    expect(forge.readHatcheryGitHubJson).toHaveBeenCalledWith("team/repo", "", "slice-3");
  });

  it("fails closed when default-branch metadata is unavailable for an unpushed branch", async () => {
    mockRemote(2);
    vi.mocked(forge.readHatcheryGitHubJson).mockResolvedValueOnce(null);
    const { run } = fakeRunner({});
    await expect(classifyBranchSafety("/repo", BRANCH, run)).rejects.toMatchObject({ code: "invalid_repo_lookup" });
  });

  it("queries GitHub for the exact repository and head with a Tessera read token", async () => {
    vi.mocked(forge.resolveHatcheryOrigin).mockResolvedValue(origin);
    vi.mocked(forge.runHatcheryNetworkGit).mockResolvedValue(0);
    vi.stubEnv("MARCH_TESSERA_URL", "http://collision-test-tessera");
    vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "collision-test-key");
    vi.stubEnv("MARCH_TESSERA_GH_TOKEN_FALLBACK", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "http://collision-test-tessera/v1/github/token") {
        expect(JSON.parse(String(init.body))).toEqual({ repo: "team/repo", identity: "app", access: "read" });
        return Response.json({
          token: "from-tessera", identity: "app[bot]", repo: "team/repo",
          access: "read", expires_at: "2099-01-01T00:00:00Z",
          commit_identity: { name: "bot", email: "bot@example.com" },
        });
      }
      expect(url).toBe("https://api.github.com/repos/team/repo/pulls?state=all&per_page=100&head=" +
        encodeURIComponent("team:" + BRANCH));
      expect(init.headers).toMatchObject({ authorization: "Bearer from-tessera" });
      return Response.json([{ number: 12, state: "open", merged_at: null, head: { sha: HEAD_SHA } }]);
    });
    vi.stubGlobal("fetch", request);
    const { run } = fakeRunner({ [symbolicRef]: { stdout: "origin/main" } });
    await expect(classifyBranchSafety("/repo", BRANCH, run, "collision-slice")).resolves.toEqual({
      kind: "unsafe", reason: "open-pr", detail: "#12",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a local tip the merged PR never carried as unsafe:diverged", async () => {
    mockRemote(0, [{ number: 42, state: "closed", merged_at: "2026-11-19", head: { sha: HEAD_SHA } }]);
    const { run } = fakeRunner({
      [symbolicRef]: { stdout: "origin/main" }, [mergeBase]: { code: 1 }, [mergedHeadCheck]: { code: 1 },
    });
    expect(await classifyBranchSafety("/repo", BRANCH, run)).toEqual({ kind: "unsafe", reason: "diverged" });
  });

  it("reports a failed local branch probe instead of treating it as absent", async () => {
    const { run } = fakeRunner({ [showRef]: { code: -1 } });
    await expect(classifyBranchSafety("/repo", BRANCH, run)).rejects.toMatchObject({ code: "branch_lookup_failed" });
  });

  it("fails closed if origin is unreachable", async () => {
    mockRemote(128);
    const { run } = fakeRunner({ [symbolicRef]: { stdout: "origin/main" } });
    await expect(classifyBranchSafety("/repo", BRANCH, run)).rejects.toMatchObject({ code: "remote_check_failed" });
    expect(forge.readHatcheryGitHubJson).not.toHaveBeenCalled();
  });

  it("fails closed on malformed PR data or a failed lookup", async () => {
    mockRemote(0, [null]);
    const { run } = fakeRunner({ [symbolicRef]: { stdout: "origin/main" } });
    await expect(classifyBranchSafety("/repo", BRANCH, run)).rejects.toMatchObject({ code: "invalid_pr_lookup" });
    const failure = new forge.HatcheryGitHubError("lookup_failed");
    vi.mocked(forge.readHatcheryGitHubJson).mockRejectedValueOnce(failure);
    await expect(classifyBranchSafety("/repo", BRANCH, run)).rejects.toBe(failure);
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

  it("removes a safe local-only orphan branch (real ls-remote miss, no gh)", async () => {
    const work = makeRepoWithLocalOnlyBranches();
    expect(await classifyBranchSafety(work, "orphan")).toEqual({
      kind: "safe",
      reason: "orphan-ref",
    });
  });

  it("escalates a diverged local-only branch as unsafe:diverged (real, no gh)", async () => {
    const work = makeRepoWithLocalOnlyBranches();
    expect(await classifyBranchSafety(work, "diverged")).toEqual({
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
