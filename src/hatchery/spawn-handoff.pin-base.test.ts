/**
 * @l1 @deterministic @ci
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("pinManagerWorktreeToDefaultBranch (#460)", async () => {
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
    origin: string;
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

    return { stale, origin, originTip };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tmpDirs.length = 0;
  });

  it("freshens a stale worktree so an already-merged file is present (the bug repro)", async () => {
    const { stale, originTip } = makeStaleWorktree("main");

    // Precondition: the stale base does NOT have contract.md — a worker here
    // would author it as a `new file` and collide at apply.
    expect(fs.existsSync(path.join(stale, "contract.md"))).toBe(false);

    const result = await pinManagerWorktreeToDefaultBranch(stale);

    expect(result).toEqual({ defaultBranch: "main", fetched: true, pinned: true });
    // Post: contract.md is now present, so the worker EDITS it instead.
    expect(fs.existsSync(path.join(stale, "contract.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], stale)).toBe(originTip);
  });

  it("fetches an SSH origin with scoped HTTPS auth and refreshes once on HTTP 401", async () => {
    const { stale, origin, originTip } = makeStaleWorktree("main");
    git(["remote", "set-url", "origin", "git@github.com:my-team/project.git"], stale);
    const fakeBin = makeTmpDir();
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const calls = path.join(fakeBin, "fetches");
    const home = makeTmpDir();
    fs.writeFileSync(path.join(home, ".gitconfig"), "[credential]\n  helper = operator-helper\n");
    fs.writeFileSync(path.join(fakeBin, "git"), `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const env = process.env;
const git = ${JSON.stringify(realGit)};
if (args[0] === "fetch") {
  const log = ${JSON.stringify(calls)};
  fs.appendFileSync(log, JSON.stringify({
    args, protocol: env.GIT_ALLOW_PROTOCOL, globalConfig: env.GIT_CONFIG_GLOBAL,
    ambient: env.GH_TOKEN,
    config: Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) },
      (_, i) => [env["GIT_CONFIG_KEY_" + i], env["GIT_CONFIG_VALUE_" + i]])),
  }) + "\\n");
  if (fs.readFileSync(log, "utf8").trim().split("\\n").length === 1) {
    console.error("trace: <= Recv header: HTTP/2 401");
    process.exit(128);
  }
  args[4] = ${JSON.stringify(origin)};
  env.GIT_ALLOW_PROTOCOL = "file";
} else if (Object.keys(env).some((key) => key.startsWith("GIT_CONFIG_VALUE_") && env[key].startsWith("Authorization"))) {
  process.exit(99);
}
execFileSync(git, args, { stdio: "inherit", env });
`, { mode: 0o755 });
    vi.stubEnv("PATH", fakeBin + path.delimiter + process.env.PATH);
    vi.stubEnv("HOME", home);
    vi.stubEnv("GH_TOKEN", "operator-token");
    vi.stubEnv("MARCH_TESSERA_GH_TOKEN_FALLBACK", "");
    vi.stubEnv("MARCH_TESSERA_URL", "http://pin-test-tessera");
    vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "pin-test-key");
    const issuance = vi.fn(async (_url: string, init: RequestInit) => {
      if (String(_url) === "https://api.github.com/repos/my-team/project") {
        return Response.json({ default_branch: "main" });
      }
      const request = JSON.parse(String(init.body));
      return Response.json({
        token: request.refresh ? "refreshed" : "initial", identity: "app[bot]",
        repo: request.repo, access: request.access, expires_at: "2099-01-01T00:00:00Z",
        commit_identity: { name: "bot", email: "bot@example.com" },
      });
    });
    vi.stubGlobal("fetch", issuance);

    await expect(pinManagerWorktreeToDefaultBranch(stale, "slice-3")).resolves.toEqual({
      defaultBranch: "main", fetched: true, pinned: true,
    });
    expect(git(["rev-parse", "HEAD"], stale)).toBe(originTip);
    expect(git(["config", "--get", "remote.origin.url"], stale)).toBe("git@github.com:my-team/project.git");
    const issuances = issuance.mock.calls.filter(([url]) => String(url).startsWith("http://pin-test-tessera"));
    expect(issuances.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { repo: "my-team/project", identity: "app", access: "read" },
      { repo: "my-team/project", identity: "app", access: "read", refresh: true },
    ]);
    expect(issuances[0][1].headers).toMatchObject({ "x-march-slice-id": "slice-3" });
    const attempts = fs.readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(attempts).toEqual(["initial", "refreshed"].map((token) => ({
      args: ["fetch", "--no-recurse-submodules", "--no-auto-maintenance", "--", "https://github.com/my-team/project.git",
        "+refs/heads/main:refs/remotes/origin/main"],
      protocol: "https", globalConfig: "/dev/null",
      config: {
        "credential.helper": "",
        "core.askPass": "",
        "http.extraHeader": "",
        "http.followRedirects": "false",
        "http.sslVerify": "true",
        "core.hooksPath": "/dev/null",
        "http.https://github.com/my-team/project.git.sslVerify": "true",
        "http.https://github.com/my-team/project.git.extraHeader":
          "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64"),
      },
    })));
    expect(process.env.GH_TOKEN).toBe("operator-token");
  });

  it.each(["unset", "stale"] as const)("resolves a GitHub default branch through scoped metadata when origin/HEAD is %s", async (originHead) => {
    const { stale, origin, originTip } = makeStaleWorktree("master");
    git(["remote", "set-url", "origin", "git@github.com:my-team/master-project.git"], stale);
    if (originHead === "unset") git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], stale);
    // A rename on GitHub leaves origin/HEAD pointing at a branch that no longer exists.
    else git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], stale);
    const fakeBin = makeTmpDir();
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(fakeBin, "git"), `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const env = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };
if (args[0] === "fetch") args[4] = ${JSON.stringify(origin)};
execFileSync(${JSON.stringify(realGit)}, args, { stdio: "inherit", env });
`, { mode: 0o755 });
    vi.stubEnv("PATH", fakeBin + path.delimiter + process.env.PATH);
    vi.stubEnv("MARCH_TESSERA_GH_TOKEN_FALLBACK", "");
    vi.stubEnv("MARCH_TESSERA_URL", "http://pin-test-tessera");
    vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "pin-test-key");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push(String(url));
      if (String(url).startsWith("https://api.github.com/")) {
        expect(init.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer /) });
        return Response.json({ default_branch: "master" });
      }
      const request = JSON.parse(String(init.body));
      return Response.json({
        token: "read-token", identity: "app[bot]", repo: request.repo, access: request.access,
        expires_at: "2099-01-01T00:00:00Z", commit_identity: { name: "bot", email: "bot@example.com" },
      });
    }));

    await expect(pinManagerWorktreeToDefaultBranch(stale, "slice-3")).resolves.toEqual({
      defaultBranch: "master", fetched: true, pinned: true,
    });
    expect(git(["rev-parse", "HEAD"], stale)).toBe(originTip);
    expect(requests).toContain("https://api.github.com/repos/my-team/master-project");
  });

  it("resolves a non-`main` default branch from origin/HEAD", async () => {
    const { stale, originTip } = makeStaleWorktree("master");

    expect(resolveDefaultBranch(stale)).toBe("master");
    const result = await pinManagerWorktreeToDefaultBranch(stale);
    expect(result.defaultBranch).toBe("master");
    expect(result.pinned).toBe(true);
    expect(fs.existsSync(path.join(stale, "contract.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], stale)).toBe(originTip);
  });

  it("degrades gracefully when the remote is unreachable (pins to last-known origin/<default>)", async () => {
    const { stale } = makeStaleWorktree("main");
    // Destroy the remote so `fetch` fails, but origin/main tracking ref persists.
    const originPath = git(["remote", "get-url", "origin"], stale);
    fs.rmSync(originPath, { recursive: true, force: true });

    const result = await pinManagerWorktreeToDefaultBranch(stale);

    // Fetch failed, but we still pinned to the last-known origin/main (the base,
    // which here lacks contract.md — but is never staler than agent-deck's base).
    expect(result.fetched).toBe(false);
    expect(result.pinned).toBe(true);
  });

  it("does NOT regress a base that is ahead of / divergent from origin (fast-forward only)", async () => {
    const { origin } = makeStaleWorktree("main");
    // A worktree cut from a base that is AHEAD of origin/main (a local-only
    // commit on top of the tip), as could happen with a divergent checkout.
    const root = makeTmpDir();
    const ahead = path.join(root, "ahead");
    git(["clone", "-q", origin, ahead], root);
    fs.writeFileSync(path.join(ahead, "local-only.txt"), "unpushed\n");
    git(["add", "-A"], ahead);
    git(["commit", "-q", "-m", "local-only commit"], ahead);
    const headBefore = git(["rev-parse", "HEAD"], ahead);

    const result = await pinManagerWorktreeToDefaultBranch(ahead);

    // origin/main is BEHIND HEAD → pin is skipped, the local commit is preserved.
    expect(result.pinned).toBe(false);
    expect(git(["rev-parse", "HEAD"], ahead)).toBe(headBefore);
    expect(fs.existsSync(path.join(ahead, "local-only.txt"))).toBe(true);
  });

  it("never throws and reports unpinned when there is no origin tracking ref", async () => {
    const root = makeTmpDir();
    const repo = path.join(root, "repo");
    git(["init", "-q", repo], root);
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "only"], repo);

    const result = await pinManagerWorktreeToDefaultBranch(repo);

    expect(result.defaultBranch).toBe("main"); // fallback
    expect(result.pinned).toBe(false); // no origin/main to reset onto
  });
});
