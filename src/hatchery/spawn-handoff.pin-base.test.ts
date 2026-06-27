/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pinManagerWorktreeToDefaultBranch,
  resolveDefaultBranch,
} from "./spawn-handoff.js";

// #460: the worker's patch base is a snapshot of the manager worktree, which
// agent-deck cuts from a stale local base and never fetches. When that base
// predates a merge that CREATED a file, the worker re-creates it from scratch
// and the resulting `new file` patch is rejected at apply time. These tests
// prove `pinManagerWorktreeToDefaultBranch` freshens the worktree to
// origin/<default> so an already-merged file is present (→ the worker edits it).

const GIT_ENV = {
  ...process.env,
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    env: GIT_ENV,
  }).trim();
}

describe("pinManagerWorktreeToDefaultBranch (#460)", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-pin-base-"));
    tmpDirs.push(dir);
    return dir;
  }

  /**
   * Builds: a bare `origin` whose default branch is `defaultBranch` and already
   * carries `contract.md`, plus a `stale` clone whose checkout AND
   * origin/<default> tracking ref predate that file (simulating agent-deck's
   * stale, never-fetched base). Returns the stale worktree path.
   */
  function makeStaleWorktree(defaultBranch: string): {
    stale: string;
    originTip: string;
  } {
    const root = makeTmpDir();
    const origin = path.join(root, "origin.git");
    git(["init", "--bare", "-q", origin], root);

    // Seed origin with a base commit (NO contract.md) on `defaultBranch`.
    const seed = path.join(root, "seed");
    git(["clone", "-q", origin, seed], root);
    fs.writeFileSync(path.join(seed, "README.md"), "base\n");
    git(["add", "-A"], seed);
    git(["commit", "-q", "-m", "base"], seed);
    git(["branch", "-M", defaultBranch], seed);
    git(["push", "-q", "-u", "origin", defaultBranch], seed);
    // Make origin/HEAD resolve to <defaultBranch> for clones.
    git(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], origin);

    // Clone the STALE worktree now — its origin/<default> tracking ref points at
    // the base commit (no contract.md).
    const stale = path.join(root, "stale");
    git(["clone", "-q", origin, stale], root);

    // A LATER user-story merges contract.md to origin (the stale clone is unaware).
    fs.writeFileSync(path.join(seed, "contract.md"), "# Contract\nowned content\n");
    git(["add", "-A"], seed);
    git(["commit", "-q", "-m", "add contract.md"], seed);
    git(["push", "-q", "origin", defaultBranch], seed);
    const originTip = git(["rev-parse", `origin/${defaultBranch}`], seed);

    return { stale, originTip };
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

  it("freshens a stale worktree so an already-merged file is present (the bug repro)", () => {
    const { stale, originTip } = makeStaleWorktree("main");

    // Precondition: the stale base does NOT have contract.md — a worker here
    // would author it as a `new file` and collide at apply.
    expect(fs.existsSync(path.join(stale, "contract.md"))).toBe(false);

    const result = pinManagerWorktreeToDefaultBranch(stale, GIT_ENV);

    expect(result).toEqual({ defaultBranch: "main", fetched: true, pinned: true });
    // Post: contract.md is now present, so the worker EDITS it instead.
    expect(fs.existsSync(path.join(stale, "contract.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], stale)).toBe(originTip);
  });

  it("resolves a non-`main` default branch from origin/HEAD", () => {
    const { stale, originTip } = makeStaleWorktree("master");

    expect(resolveDefaultBranch(stale)).toBe("master");
    const result = pinManagerWorktreeToDefaultBranch(stale, GIT_ENV);
    expect(result.defaultBranch).toBe("master");
    expect(result.pinned).toBe(true);
    expect(fs.existsSync(path.join(stale, "contract.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], stale)).toBe(originTip);
  });

  it("degrades gracefully when the remote is unreachable (pins to last-known origin/<default>)", () => {
    const { stale } = makeStaleWorktree("main");
    // Destroy the remote so `fetch` fails, but origin/main tracking ref persists.
    const originPath = git(["remote", "get-url", "origin"], stale);
    fs.rmSync(originPath, { recursive: true, force: true });

    const result = pinManagerWorktreeToDefaultBranch(stale, GIT_ENV);

    // Fetch failed, but we still pinned to the last-known origin/main (the base,
    // which here lacks contract.md — but is never staler than agent-deck's base).
    expect(result.fetched).toBe(false);
    expect(result.pinned).toBe(true);
  });

  it("never throws and reports unpinned when there is no origin tracking ref", () => {
    const root = makeTmpDir();
    const repo = path.join(root, "repo");
    git(["init", "-q", repo], root);
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "only"], repo);

    const result = pinManagerWorktreeToDefaultBranch(repo, GIT_ENV);

    expect(result.defaultBranch).toBe("main"); // fallback
    expect(result.pinned).toBe(false); // no origin/main to reset onto
  });
});
