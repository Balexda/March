/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A sync-style fake for every child process the adapter runs. `fakeExec` wraps
// it in the async ExecFn the adapter takes, so a thrown error becomes a rejection.
const childProcessMock = {
  execFileSync: vi.fn(),
};

// The repository each directory's git reports (`rev-parse --git-common-dir`),
// for the launch path that checks a list-diff pick belongs to the requested
// repo. Unlisted directories are worktrees of /repo.
const gitCommonDirs = new Map<string, string>();

const fakeExec: ExecFn = async (cmd, args, opts) => {
  if (cmd === "git" && args.includes("--git-common-dir")) {
    return `${gitCommonDirs.get(args[1]!) ?? "/repo/.git"}\n`;
  }
  return (childProcessMock.execFileSync(cmd, args, opts) as string | undefined) ?? "";
};

const noSleep = async () => {};

function makeAdapter(options: Omit<AgentDeckAdapterOptions, "exec"> = {}) {
  return createAgentDeckAdapter({ exec: fakeExec, sleep: noSleep, ...options });
}

import {
  buildLaunchArgs,
  buildListArgs,
  buildSessionOutputArgs,
  buildSessionRemoveArgs,
  buildSessionRestartArgs,
  buildSessionSendArgs,
  buildSessionSetArgs,
  buildSessionShowArgs,
  createAgentDeckAdapter,
  expectedWorktreeDirName,
  listInteractiveSessions,
  looksLikeComposerRefusal,
  paneTail,
  parseAgentDeckSession,
  parseLaunchOutput,
  pickLaunchedSession,
  resolveAgentDeckEnv,
  type AgentDeckAdapterOptions,
} from "./adapter.js";
import { ExecError, type ExecFn } from "./exec.js";
import { SendTracker } from "./send-health.js";
import { stewardSessionFilePath } from "./steward-skills.js";
import {
  CastraAgentDeckError,
  CastraComposerRefusedError,
  CastraConflictError,
  CastraNotFoundError,
  type CastraSession,
} from "./types.js";

function execError(stderr: string): Error {
  return Object.assign(new Error("agent-deck failed"), {
    stderr: Buffer.from(stderr),
  });
}

function session(overrides: Partial<CastraSession> = {}): Record<string, unknown> {
  return {
    id: overrides.sessionId ?? "sess-1",
    title: overrides.title ?? "Steward",
    group: overrides.group ?? "march-spawn-managers",
    worktree_branch: overrides.branch ?? "",
    worktree_path: overrides.worktreePath ?? "/repo/feature-march-spawn-x",
    created_at: overrides.createdAt ?? "2026-05-20T00:00:00Z",
    status: overrides.status ?? "idle",
  };
}

describe("live interactive inventory", () => {
  it("reads only live march/ names from Castra's tmux server with a timeout", async () => {
    childProcessMock.execFileSync.mockReturnValueOnce("other\nmarch/\nmarch/conductor\nmarch/second name\n");
    await expect(listInteractiveSessions(fakeExec)).resolves.toEqual(["conductor", "second name"]);
    expect(childProcessMock.execFileSync).toHaveBeenLastCalledWith(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      expect.objectContaining({ capture: true, timeoutMs: 3_000 }),
    );
  });

  it("returns empty when the live server has no eligible sessions", async () => {
    childProcessMock.execFileSync.mockReturnValueOnce("unrelated\n");
    await expect(listInteractiveSessions(fakeExec)).resolves.toEqual([]);
  });

  it.each([
    "no server running on /tmp/tmux/default",
    "error connecting to /tmp/tmux/default (No such file or directory)",
  ])("returns empty for %s", async (stderr) => {
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw new ExecError("exit 1", { exitCode: 1, stderr });
    });
    await expect(listInteractiveSessions(fakeExec)).resolves.toEqual([]);
  });

  it.each([
    [{ code: "ENOENT" }, "tmux executable was not found"],
    [{ timedOut: true }, "timed out"],
    [{ exitCode: 1, stderr: "error connecting to /tmp/tmux/default (Permission denied)" }, "Permission denied"],
    [{ exitCode: 1, stderr: "server exited unexpectedly" }, "server exited unexpectedly"],
  ])("reports tmux failure %j", async (failure, message) => {
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw new ExecError("tmux failed", failure);
    });
    await expect(listInteractiveSessions(fakeExec)).rejects.toThrow(message);
  });
});

describe("castra adapter — argv builders", () => {
  it("builds list args with the profile flag", () => {
    expect(buildListArgs("march")).toEqual(["-p", "march", "list", "--json"]);
  });

  it("builds launch args mirroring the Hatchery handoff shape", () => {
    const prev = process.env.MARCH_STEWARD_SKILLS_DIR;
    const prevPort = process.env.MARCH_TESSERA_PORT;
    process.env.MARCH_STEWARD_SKILLS_DIR = "/steward-skills";
    // Pin the listener port so a developer's exported value cannot leak in.
    process.env.MARCH_TESSERA_PORT = "9477";
    try {
      expect(
        buildLaunchArgs({
          profile: "march",
          repoPath: "/repo",
          title: "Steward",
          group: "g",
          branch: "march/spawn/x",
          model: "opus",
        }),
      ).toEqual([
        "-p",
        "march",
        "launch",
        "/repo",
        "-t",
        "Steward",
        "-c",
        "claude",
        "-g",
        "g",
        "--worktree",
        "march/spawn/x",
        "-b",
        "--title-lock",
        "--wrapper",
        "'/steward-skills/bin/steward-launch' 9477 {command}",
        "--extra-arg",
        "--permission-mode",
        "--extra-arg",
        "auto",
        "--extra-arg",
        "--model",
        "--extra-arg",
        "opus",
        "--extra-arg",
        "--plugin-dir",
        "--extra-arg",
        path.join("/steward-skills", "plugin"),
        "--extra-arg",
        "--settings",
        "--extra-arg",
        path.join("/steward-skills", "settings.json"),
        "--json",
      ]);
    } finally {
      if (prev === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
      else process.env.MARCH_STEWARD_SKILLS_DIR = prev;
      if (prevPort === undefined) delete process.env.MARCH_TESSERA_PORT;
      else process.env.MARCH_TESSERA_PORT = prevPort;
    }
  });

  it("defaults the launch model when none is given", () => {
    const args = buildLaunchArgs({
      profile: "march",
      repoPath: "/repo",
      title: "t",
      group: "g",
      branch: "b",
    });
    // model is the --extra-arg value immediately after the "--model" token.
    expect(args[args.indexOf("--model") + 2]).toBe("opus");
  });

  it("loads the steward skills as a plugin via --plugin-dir, never --add-dir (#608)", () => {
    const prev = process.env.MARCH_STEWARD_SKILLS_DIR;
    process.env.MARCH_STEWARD_SKILLS_DIR = "/steward-skills";
    try {
      const args = buildLaunchArgs({
        profile: "march",
        repoPath: "/repo",
        title: "t",
        group: "g",
        branch: "b",
      });
      const idx = args.indexOf("--plugin-dir");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx - 1]).toBe("--extra-arg");
      expect(args[idx + 1]).toBe("--extra-arg");
      expect(args[idx + 2]).toBe(path.join("/steward-skills", "plugin"));
      // --add-dir raises a directory-trust dialog in Claude Code >= 2.1.326 that
      // blocks the steward's composer, so agent-deck refuses every send.
      expect(args).not.toContain("--add-dir");
    } finally {
      if (prev === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
      else process.env.MARCH_STEWARD_SKILLS_DIR = prev;
    }
  });

  it("loads the steward self-report settings via --settings (#371)", () => {
    const prev = process.env.MARCH_STEWARD_SKILLS_DIR;
    process.env.MARCH_STEWARD_SKILLS_DIR = "/steward-skills";
    try {
      const args = buildLaunchArgs({
        profile: "march",
        repoPath: "/repo",
        title: "t",
        group: "g",
        branch: "b",
      });
      const idx = args.indexOf("--settings");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx - 1]).toBe("--extra-arg");
      expect(args[idx + 1]).toBe("--extra-arg");
      expect(args[idx + 2]).toBe(path.join("/steward-skills", "settings.json"));
    } finally {
      if (prev === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
      else process.env.MARCH_STEWARD_SKILLS_DIR = prev;
    }
  });

  it("includes -b by default and omits it when createBranch is false (attach)", () => {
    const base = { profile: "march", repoPath: "/repo", title: "t", group: "g", branch: "b" };
    expect(buildLaunchArgs(base)).toContain("-b");
    expect(buildLaunchArgs({ ...base, createBranch: false })).not.toContain("-b");
  });

  it("builds session subcommand args", () => {
    expect(buildSessionShowArgs("p", "s")).toEqual(["-p", "p", "session", "show", "s", "--json"]);
    expect(buildSessionSendArgs("p", "s", "hi")).toEqual(["-p", "p", "session", "send", "s", "hi"]);
    expect(buildSessionSetArgs("p", "s", "auto-mode", "true")).toEqual([
      "-p", "p", "session", "set", "s", "auto-mode", "true",
    ]);
    expect(buildSessionOutputArgs("p", "s")).toEqual(["-p", "p", "session", "output", "s"]);
  });

  it("includes --prune-worktree only when requested, always --force", () => {
    expect(buildSessionRemoveArgs("p", "s", true)).toEqual([
      "-p", "p", "session", "remove", "s", "--prune-worktree", "--force",
    ]);
    expect(buildSessionRemoveArgs("p", "s", false)).toEqual([
      "-p", "p", "session", "remove", "s", "--force",
    ]);
  });

  it("builds restart args, defaulting to --force", () => {
    expect(buildSessionRestartArgs("p", "s")).toEqual([
      "-p", "p", "session", "restart", "s", "--force",
    ]);
    expect(buildSessionRestartArgs("p", "s", false)).toEqual([
      "-p", "p", "session", "restart", "s",
    ]);
  });
});

describe("castra adapter — pure parsers", () => {
  it("derives the worktree dir from a branch", () => {
    expect(expectedWorktreeDirName("march/spawn/x")).toBe("feature-march-spawn-x");
  });

  it("picks the launched session by matching worktree dir", () => {
    const sessions: CastraSession[] = [
      { sessionId: "old", title: "", group: "g", branch: "", worktreePath: "/repo/feature-other", createdAt: "1", status: "idle" },
      { sessionId: "new", title: "", group: "g", branch: "", worktreePath: "/repo/feature-march-spawn-x", createdAt: "2", status: "idle" },
    ];
    const picked = pickLaunchedSession(sessions, new Set(["old"]), "march/spawn/x");
    expect(picked?.sessionId).toBe("new");
  });

  it("parses agent-deck session records with fallback field names", () => {
    const parsed = parseAgentDeckSession(session({ sessionId: "abc" }));
    expect(parsed?.sessionId).toBe("abc");
    expect(parsed?.worktreePath).toBe("/repo/feature-march-spawn-x");
    expect(parsed?.status).toBe("idle");
  });
});

describe("castra adapter — agent-deck tmux env (issue #174)", () => {
  it("passes the environment through untouched when $TMUX is already set", () => {
    const env = { TMUX: "/tmp/tmux-1000/default,693,0", PATH: "/usr/bin" };
    expect(resolveAgentDeckEnv(env, 1000)).toBe(env);
  });

  it("synthesizes $TMUX at the default socket when it is absent", () => {
    const resolved = resolveAgentDeckEnv({ PATH: "/usr/bin" }, 1000);
    expect(resolved.TMUX).toBe("/tmp/tmux-1000/default,0,0");
    // Existing vars are preserved (we don't replace the whole environment).
    expect(resolved.PATH).toBe("/usr/bin");
  });

  it("treats a blank $TMUX as absent and synthesizes one", () => {
    expect(resolveAgentDeckEnv({ TMUX: "   " }, 1000).TMUX).toBe(
      "/tmp/tmux-1000/default,0,0",
    );
  });

  it("honors $TMUX_TMPDIR for the socket directory", () => {
    expect(resolveAgentDeckEnv({ TMUX_TMPDIR: "/run/tmux" }, 1000).TMUX).toBe(
      "/run/tmux/tmux-1000/default,0,0",
    );
  });

  it("leaves the environment untouched when the uid is unknown", () => {
    const env = { PATH: "/usr/bin" };
    expect(resolveAgentDeckEnv(env, undefined)).toBe(env);
  });

  it("hands the resolved env (with $TMUX) to the spawned agent-deck", async () => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_TMPDIR", "");
    childProcessMock.execFileSync.mockReset();
    childProcessMock.execFileSync.mockReturnValue("[]");
    try {
      await makeAdapter().list({ profile: "march" });
      const opts = childProcessMock.execFileSync.mock.calls[0]?.[2] as {
        env?: NodeJS.ProcessEnv;
      };
      expect(opts.env?.TMUX).toMatch(/\/tmux-\d+\/default,0,0$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("castra adapter — operations", () => {
  // launch() writes a per-session steward-report sidecar under the steward
  // skills root (#371). Point it at a throwaway temp dir so these tests never
  // touch ~/.march/steward, and clean it up afterward.
  const sidecarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "castra-adapter-"));
  const prevSkillsDir = process.env.MARCH_STEWARD_SKILLS_DIR;

  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
    gitCommonDirs.clear();
    process.env.MARCH_STEWARD_SKILLS_DIR = sidecarRoot;
    // Start each test with a clean sessions dir so a prior launch's sidecar
    // can't make a later "should not write" assertion pass spuriously.
    fs.rmSync(path.join(sidecarRoot, "sessions"), { recursive: true, force: true });
  });

  afterEach(() => {
    if (prevSkillsDir === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
    else process.env.MARCH_STEWARD_SKILLS_DIR = prevSkillsDir;
  });

  afterAll(() => {
    fs.rmSync(sidecarRoot, { recursive: true, force: true });
  });

  it("lists sessions, filtering by group when given", async () => {
    childProcessMock.execFileSync.mockReturnValue(
      JSON.stringify([
        session({ sessionId: "a", group: "g1" }),
        session({ sessionId: "b", group: "g2" }),
      ]),
    );
    const adapter = makeAdapter();
    expect(await adapter.list({ profile: "march" })).toHaveLength(2);
    expect((await adapter.list({ profile: "march", group: "g1" })).map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("treats an empty profile as [] (agent-deck prints 'No sessions found', not [])", async () => {
    const adapter = makeAdapter();
    // The exact human line agent-deck prints to stdout for an empty profile.
    childProcessMock.execFileSync.mockReturnValue("No sessions found in profile 'gatecli'.\n");
    expect(await adapter.list({ profile: "gatecli" })).toEqual([]);
    // Empty stdout is also a normal empty listing, not malformed output.
    childProcessMock.execFileSync.mockReturnValue("");
    expect(await adapter.list({ profile: "gatecli" })).toEqual([]);
  });

  it("still throws on genuinely malformed (non-empty, non-JSON) list output", async () => {
    const adapter = makeAdapter();
    childProcessMock.execFileSync.mockReturnValue("garbled <not json> output");
    await expect(adapter.list({ profile: "march" })).rejects.toThrow(/unexpected output/);
  });

  it("launches and returns the identified session", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        return listCalls === 1
          ? "[]"
          : JSON.stringify([session({ sessionId: "sess-new", group: "g" })]);
      }
      return "";
    });
    const adapter = makeAdapter();
    const result = await adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
    });
    expect(result.sessionId).toBe("sess-new");
    expect(result.worktreePath).toBe("/repo/feature-march-spawn-x");
    // launch issues a best-effort auto-mode set after identifying the session.
    expect(
      childProcessMock.execFileSync.mock.calls.some(
        (c) => Array.isArray(c[1]) && c[1].includes("set") && c[1].includes("auto-mode"),
      ),
    ).toBe(true);
  });

  it("stamps launch metadata, returns it on launch, and re-attaches it on list/show (#214)", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        // First list = pre-launch snapshot (empty); later lists report the new
        // session, but agent-deck does NOT carry our metadata.
        return listCalls === 1
          ? "[]"
          : JSON.stringify([session({ sessionId: "sess-new", group: "g" })]);
      }
      if (args.includes("show")) {
        return JSON.stringify(session({ sessionId: "sess-new", group: "g" }));
      }
      return "";
    });
    const adapter = makeAdapter();
    const launched = await adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
      metadata: { sliceId: "slice-7", spawnId: "sp-1" },
    });
    expect(launched.metadata).toEqual({ sliceId: "slice-7", spawnId: "sp-1" });

    // list re-attaches the Castra-owned metadata even though agent-deck omits it.
    const listed = (await adapter.list({ profile: "march" })).find((s) => s.sessionId === "sess-new");
    expect(listed?.metadata).toEqual({ sliceId: "slice-7", spawnId: "sp-1" });
    // show does too.
    expect((await adapter.show({ profile: "march", sessionId: "sess-new" })).metadata).toEqual({
      sliceId: "slice-7",
      spawnId: "sp-1",
    });
  });

  it("writes the steward-report sidecar keyed by the worktree dir on launch (#371)", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        return listCalls === 1
          ? "[]"
          : JSON.stringify([session({ sessionId: "sess-new", group: "g" })]);
      }
      return "";
    });
    process.env.MARCH_HERALD_URL = "http://herald.example:1234";
    try {
      await makeAdapter().launch({
        profile: "march",
        repoPath: "/repo",
        branch: "march/spawn/x",
        title: "Steward",
        group: "g",
        metadata: { sliceId: "slice-7", spawnId: "sp-1" },
      });
      // Sidecar is keyed by the full worktree path (the same key the hook
      // derives from its cwd) — assert via the shared keying function.
      const sidecar = stewardSessionFilePath("/repo/feature-march-spawn-x");
      const payload = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
      expect(payload).toEqual({
        profile: "march",
        sliceId: "slice-7",
        heraldUrl: "http://herald.example:1234",
      });
    } finally {
      delete process.env.MARCH_HERALD_URL;
    }
  });

  it("skips the steward-report sidecar when no sliceId is supplied (#371)", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        return listCalls === 1
          ? "[]"
          : JSON.stringify([session({ sessionId: "sess-new", group: "g" })]);
      }
      return "";
    });
    await makeAdapter().launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
    });
    const sidecar = stewardSessionFilePath("/repo/feature-march-spawn-x");
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it("backfills an empty branch from the launch branch on list (stale-branch fix #214)", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        // agent-deck reports an empty branch for the live session.
        return listCalls === 1
          ? "[]"
          : JSON.stringify([session({ sessionId: "sess-new", group: "g", branch: "" })]);
      }
      return "";
    });
    const adapter = makeAdapter();
    await adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
    });
    const listed = (await adapter.list({ profile: "march" })).find((s) => s.sessionId === "sess-new");
    expect(listed?.branch).toBe("march/spawn/x");
  });

  it("derives an empty session branch from the working directory's git head (#264)", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("list")) {
        return JSON.stringify([
          session({ sessionId: "legacy", group: "g", branch: "", worktreePath: "/wt/legacy" }),
        ]);
      }
      if (cmd === "git" && args.includes("--is-inside-work-tree")) return "true\n";
      if (cmd === "git" && args.includes("--show-current")) return "feature/smithy/cut/01\n";
      return "";
    });
    const adapter = makeAdapter();
    const listed = (await adapter.list({ profile: "march" })).find((s) => s.sessionId === "legacy");
    expect(listed?.branch).toBe("feature/smithy/cut/01");
  });

  it("returns an empty branch for a non-git working directory (#264)", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("list")) {
        return JSON.stringify([
          session({ sessionId: "nogit", group: "g", branch: "", worktreePath: "/tmp/plain" }),
        ]);
      }
      if (cmd === "git") throw execError("not a git repository");
      return "";
    });
    const adapter = makeAdapter();
    const listed = (await adapter.list({ profile: "march" })).find((s) => s.sessionId === "nogit");
    expect(listed?.branch).toBe("");
  });

  it("returns an empty branch for a detached HEAD checkout (#264)", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("list")) {
        return JSON.stringify([
          session({ sessionId: "detached", group: "g", branch: "", worktreePath: "/wt/detached" }),
        ]);
      }
      if (cmd === "git" && args.includes("--is-inside-work-tree")) return "true\n";
      // Detached HEAD: `branch --show-current` prints nothing.
      if (cmd === "git" && args.includes("--show-current")) return "\n";
      return "";
    });
    const adapter = makeAdapter();
    const listed = (await adapter.list({ profile: "march" })).find((s) => s.sessionId === "detached");
    expect(listed?.branch).toBe("");
  });

  it("caches the derived branch for the session lifetime — git runs once across calls (#264)", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("list")) {
        return JSON.stringify([
          session({ sessionId: "cached", group: "g", branch: "", worktreePath: "/wt/cached" }),
        ]);
      }
      if (cmd === "git" && args.includes("--is-inside-work-tree")) return "true\n";
      if (cmd === "git" && args.includes("--show-current")) return "feature/x\n";
      return "";
    });
    const adapter = makeAdapter();
    expect((await adapter.list({ profile: "march" }))[0]?.branch).toBe("feature/x");
    expect((await adapter.list({ profile: "march" }))[0]?.branch).toBe("feature/x");
    const gitShowCurrentCalls = childProcessMock.execFileSync.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("--show-current"),
    );
    expect(gitShowCurrentCalls).toHaveLength(1);
  });

  it("re-derives the branch after the session is removed (cache invalidation #264)", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("list")) {
        return JSON.stringify([
          session({ sessionId: "recycle", group: "g", branch: "", worktreePath: "/wt/recycle" }),
        ]);
      }
      if (cmd === "git" && args.includes("--is-inside-work-tree")) return "true\n";
      if (cmd === "git" && args.includes("--show-current")) return "feature/x\n";
      return "";
    });
    const adapter = makeAdapter();
    await adapter.list({ profile: "march" });
    await adapter.remove({ profile: "march", sessionId: "recycle", pruneWorktree: false });
    await adapter.list({ profile: "march" });
    const gitShowCurrentCalls = childProcessMock.execFileSync.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("--show-current"),
    );
    // Once before remove, once after — the cache was invalidated on remove.
    expect(gitShowCurrentCalls).toHaveLength(2);
  });

  it("forgets a session's metadata after remove", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        return listCalls === 1
          ? "[]"
          : JSON.stringify([session({ sessionId: "sess-new", group: "g" })]);
      }
      return "";
    });
    const adapter = makeAdapter();
    await adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
      metadata: { sliceId: "slice-7" },
    });
    expect(await adapter.remove({ profile: "march", sessionId: "sess-new", pruneWorktree: false })).toEqual({
      removed: true,
    });
    const listed = (await adapter.list({ profile: "march" })).find((s) => s.sessionId === "sess-new");
    expect(listed?.metadata).toBeUndefined();
  });

  it("raises a conflict when the launched worktree dir does not match the branch", async () => {
    let listCalls = 0;
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("list")) {
        listCalls++;
        return listCalls === 1
          ? "[]"
          : JSON.stringify([
              session({ sessionId: "sess-wrong", group: "g", worktreePath: "/repo/feature-collision" }),
            ]);
      }
      return "";
    });
    const adapter = makeAdapter();
    await expect(
      adapter.launch({
        profile: "march",
        repoPath: "/repo",
        branch: "march/spawn/x",
        title: "t",
        group: "g",
      }),
    ).rejects.toThrow(CastraConflictError);
  });

  it("reports removed:true on success and removed:false when the session is already gone", async () => {
    const adapter = makeAdapter();
    childProcessMock.execFileSync.mockReturnValueOnce("");
    expect(await adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).toEqual({
      removed: true,
    });
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw execError("session not found");
    });
    expect(await adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).toEqual({
      removed: false,
    });
  });

  it("maps an unexpected remove failure to a 502-class error", async () => {
    const adapter = makeAdapter();
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw execError("tmux server connection refused");
    });
    await expect(adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).rejects.toThrow(
      CastraAgentDeckError,
    );
  });

  it("throws not-found when showing a missing session", async () => {
    const adapter = makeAdapter();
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw execError("no such session");
    });
    await expect(adapter.show({ profile: "p", sessionId: "missing" })).rejects.toThrow(CastraNotFoundError);
  });

  it("truncates output to the last N lines", async () => {
    const adapter = makeAdapter();
    childProcessMock.execFileSync.mockReturnValueOnce("l1\nl2\nl3\nl4\nl5");
    expect(await adapter.output({ profile: "p", sessionId: "s", lines: 2 })).toEqual({
      output: "l4\nl5",
      truncated: true,
    });
  });

  it("reports reachability from agent-deck --version", async () => {
    const adapter = makeAdapter();
    childProcessMock.execFileSync.mockReturnValueOnce("agent-deck 1.9.17");
    expect(await adapter.reachable()).toBe(true);
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw new Error("not installed");
    });
    expect(await adapter.reachable()).toBe(false);
  });
});

describe("castra adapter — refused send diagnostics (#608)", () => {
  const REFUSAL =
    "Error: message not delivered to 't': message not sent: composer is occupied or " +
    "unreadable; existing draft preserved, nothing was typed";
  const DIALOG_PANE = [
    "\u2500".repeat(80),
    " Adding a new directory:",
    " /home/u/.march/steward",
    "",
    " \u276f No, exit",
    "   Yes, add it",
    " Enter to confirm \u00b7 Esc to cancel",
    "",
    "",
  ].join("\n");

  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
  });

  it("recognizes agent-deck's composer refusal and nothing else", () => {
    expect(looksLikeComposerRefusal(REFUSAL)).toBe(true);
    expect(looksLikeComposerRefusal("session not found")).toBe(false);
  });

  it("paneTail keeps the last non-blank, non-rule lines", () => {
    expect(paneTail(DIALOG_PANE, 3)).toBe(
      "   Yes, add it\n Enter to confirm \u00b7 Esc to cancel".replace(/^/, " \u276f No, exit\n"),
    );
    expect(paneTail(DIALOG_PANE, 50)).not.toContain("\u2500");
  });

  it("appends the steward's pane tail to a refused send", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("send")) {
        throw Object.assign(new Error("exit 1"), { stderr: REFUSAL });
      }
      if (cmd === "agent-deck" && args.includes("show")) {
        return JSON.stringify({ id: "s1", tmux_session: "agentdeck_t_1" });
      }
      if (cmd === "tmux") {
        expect(args).toEqual(["capture-pane", "-p", "-t", "agentdeck_t_1"]);
        return DIALOG_PANE;
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    });
    await expect(
      makeAdapter().send({ profile: "march", sessionId: "s1", prompt: "go" }),
    ).rejects.toThrow(/composer is occupied[\s\S]*Steward pane at refusal[\s\S]*Adding a new directory/);
  });

  it("leaves other send failures unchanged and never captures the pane", async () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") throw new Error("must not capture");
      throw Object.assign(new Error("exit 1"), { stderr: "tmux: server exited" });
    });
    await expect(
      makeAdapter().send({ profile: "march", sessionId: "s1", prompt: "go" }),
    ).rejects.toThrow(/^agent-deck session send failed: tmux: server exited$/);
  });
});

describe("castra adapter — async sends (stuck-steward unbrick)", () => {
  const REFUSAL =
    "Error: message not delivered to 't': message not sent: composer is occupied or " +
    "unreadable; existing draft preserved, nothing was typed";
  const BUSY_PANE = "❯ half-typed draft the operator left\n  ? for shortcuts";
  const prevSkillsDir = process.env.MARCH_STEWARD_SKILLS_DIR;

  beforeEach(() => {
    process.env.MARCH_STEWARD_SKILLS_DIR = "/home/u/.march/steward";
  });

  afterEach(() => {
    if (prevSkillsDir === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
    else process.env.MARCH_STEWARD_SKILLS_DIR = prevSkillsDir;
  });

  function deferred() {
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    return { promise, resolve };
  }

  function sendCalls(calls: { args: readonly string[] }[]): string[] {
    return calls.filter((c) => c.args.includes("send")).map((c) => c.args[4]!);
  }

  it("serializes sends to one session and runs other sessions concurrently", async () => {
    const calls: { args: readonly string[] }[] = [];
    const pending = new Map<string, ReturnType<typeof deferred>[]>();
    const exec: ExecFn = (cmd, args) => {
      calls.push({ args });
      const d = deferred();
      const id = args[4]!;
      pending.set(id, [...(pending.get(id) ?? []), d]);
      return d.promise;
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    const a1 = adapter.send({ profile: "march", sessionId: "s1", prompt: "one" });
    const a2 = adapter.send({ profile: "march", sessionId: "s1", prompt: "two" });
    const b1 = adapter.send({ profile: "march", sessionId: "s2", prompt: "other" });
    await new Promise((r) => setTimeout(r, 0));
    // s1's second prompt waits for its first; s2 is not held up by s1.
    expect(calls.map((c) => `${c.args[4]}:${c.args[5]}`)).toEqual(["s1:one", "s2:other"]);

    pending.get("s2")![0]!.resolve("");
    await b1;
    pending.get("s1")![0]!.resolve("");
    await a1;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => `${c.args[4]}:${c.args[5]}`)).toEqual(["s1:one", "s2:other", "s1:two"]);
    pending.get("s1")![1]!.resolve("");
    await a2;
  });

  it("fails fast with composer_refused during the cooldown, until the pane changes", async () => {
    let pane = BUSY_PANE;
    const calls: { args: readonly string[] }[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ args });
      if (cmd === "agent-deck" && args.includes("send")) {
        throw Object.assign(new Error("exit 1"), { stderr: REFUSAL });
      }
      if (cmd === "agent-deck" && args.includes("show")) {
        return JSON.stringify({ id: "s1", tmux_session: "agentdeck_t_1" });
      }
      if (cmd === "tmux" && args[0] === "capture-pane") return pane;
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    };
    const tracker = new SendTracker();
    const adapter = createAgentDeckAdapter({ exec, sendTracker: tracker, sleep: noSleep });
    const send = () => adapter.send({ profile: "march", sessionId: "s1", prompt: "go" });

    const first = await send().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(CastraComposerRefusedError);
    expect((first as CastraComposerRefusedError).cached).toBe(false);
    expect((first as Error).message).toMatch(/composer is occupied[\s\S]*half-typed draft/);
    expect(tracker.refusedSessionIds()).toEqual(["s1"]);

    // Same pane: no agent-deck send at all, the same refusal comes straight back.
    const second = await send().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(CastraComposerRefusedError);
    expect((second as CastraComposerRefusedError).cached).toBe(true);
    expect((second as Error).message).toMatch(/composer_refused cooldown[\s\S]*Last refusal: agent-deck session send failed/);
    expect(sendCalls(calls)).toHaveLength(1);

    // The pane changed (the operator cleared the draft): agent-deck runs again.
    pane = "❯ \n  ? for shortcuts";
    await expect(send()).rejects.toBeInstanceOf(CastraComposerRefusedError);
    expect(sendCalls(calls)).toHaveLength(2);
  });

  it("retries agent-deck once the cooldown has expired", async () => {
    let now = 0;
    let sends = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "agent-deck" && args.includes("send")) {
        sends++;
        throw Object.assign(new Error("exit 1"), { stderr: REFUSAL });
      }
      return "";
    };
    const tracker = new SendTracker({ cooldownMs: 1_000, now: () => now });
    const adapter = createAgentDeckAdapter({ exec, sendTracker: tracker, sleep: noSleep });
    const send = () => adapter.send({ profile: "march", sessionId: "s1", prompt: "go" });
    await expect(send()).rejects.toBeInstanceOf(CastraComposerRefusedError);
    await expect(send()).rejects.toThrow(/cooldown/);
    expect(sends).toBe(1);
    now = 1_000;
    await expect(send()).rejects.toBeInstanceOf(CastraComposerRefusedError);
    expect(sends).toBe(2);
  });

  it("starts no cooldown for a send failure that is not a composer refusal", async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error("exit 1"), { stderr: "tmux: server exited" });
    };
    const tracker = new SendTracker();
    const adapter = createAgentDeckAdapter({ exec, sendTracker: tracker, sleep: noSleep });
    await expect(adapter.send({ profile: "march", sessionId: "s1", prompt: "go" })).rejects.not.toBeInstanceOf(
      CastraComposerRefusedError,
    );
    expect(tracker.refusedSessionIds()).toEqual([]);
  });

  function trustDialogHost(dir: string) {
    let open = true;
    let cursorOnYes = false;
    const keys: string[] = [];
    let sends = 0;
    const pane = () =>
      open
        ? [
            " Adding a new directory:",
            ` ${dir}`,
            "",
            ` ${cursorOnYes ? " " : "❯"} No, exit`,
            ` ${cursorOnYes ? "❯" : " "} Yes, add it`,
            " Enter to confirm · Esc to cancel",
          ].join("\n")
        : "❯ \n  ? for shortcuts";
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "agent-deck" && args.includes("send")) {
        sends++;
        if (open) throw Object.assign(new Error("exit 1"), { stderr: REFUSAL });
        return "";
      }
      if (cmd === "agent-deck" && args.includes("show")) {
        return JSON.stringify({ id: "s1", tmux_session: "agentdeck_t_1" });
      }
      if (cmd === "tmux" && args[0] === "capture-pane") return pane();
      if (cmd === "tmux" && args[0] === "send-keys") {
        expect(args.slice(0, 3)).toEqual(["send-keys", "-t", "agentdeck_t_1"]);
        const key = args[3]!;
        keys.push(key);
        if (key === "Down") cursorOnYes = true;
        if (key === "Enter" && cursorOnYes) open = false;
        return "";
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    };
    return { exec, keys, sends: () => sends, isOpen: () => open };
  }

  it("answers 'Yes, add it' on Castra's own steward-dir trust dialog and redelivers the send", async () => {
    const host = trustDialogHost("/home/u/.march/steward");
    const tracker = new SendTracker();
    const logs: string[] = [];
    const adapter = createAgentDeckAdapter({
      exec: host.exec,
      sendTracker: tracker,
      sleep: noSleep,
      logger: { info: (_o, msg) => logs.push(msg), warn: (_o, msg) => logs.push(msg) },
    });
    await expect(adapter.send({ profile: "march", sessionId: "s1", prompt: "go" })).resolves.toBeUndefined();
    expect(host.keys).toEqual(["Down", "Enter"]);
    expect(host.isOpen()).toBe(false);
    expect(host.sends()).toBe(2);
    expect(tracker.refusedSessionIds()).toEqual([]);
    expect(logs).toEqual(["castra answered the steward directory-trust dialog"]);
  });

  it("leaves another directory's trust dialog alone and reports it", async () => {
    const host = trustDialogHost("/home/u/src/someone-elses-repo");
    const logs: string[] = [];
    const adapter = createAgentDeckAdapter({
      exec: host.exec,
      sleep: noSleep,
      logger: { info: (_o, msg) => logs.push(msg), warn: (_o, msg) => logs.push(msg) },
    });
    const err = await adapter.send({ profile: "march", sessionId: "s1", prompt: "go" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CastraComposerRefusedError);
    expect((err as Error).message).toMatch(
      /left the directory-trust dialog for \/home\/u\/src\/someone-elses-repo unanswered/,
    );
    expect(host.keys).toEqual([]);
    expect(host.sends()).toBe(1);
    expect(logs).toEqual(["castra left a directory-trust dialog unanswered"]);
  });

  it("answers the dialog but, with too little budget left to resend, says so and starts no cooldown", async () => {
    const host = trustDialogHost("/home/u/.march/steward");
    let now = 0;
    const exec: ExecFn = async (cmd, args, opts) => {
      const out = await host.exec(cmd, args, opts);
      // Answering the dialog took most of the send budget.
      if (cmd === "tmux" && args[0] === "send-keys" && args[3] === "Enter") now = 60_000;
      return out;
    };
    const tracker = new SendTracker();
    const adapter = createAgentDeckAdapter({ exec, sendTracker: tracker, sleep: noSleep, now: () => now, budgets: { sendMs: 100_000 } });
    const err = await adapter.send({ profile: "march", sessionId: "s1", prompt: "go" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CastraComposerRefusedError);
    expect((err as Error).message).toMatch(/answered the directory-trust dialog .* so it was not delivered\. No cooldown was started/s);
    expect(host.isOpen()).toBe(false);
    expect(host.sends()).toBe(1);
    expect(tracker.refusedSessionIds()).toEqual([]);
    // The next send reaches agent-deck and goes through.
    await expect(adapter.send({ profile: "march", sessionId: "s1", prompt: "go" })).resolves.toBeUndefined();
    expect(host.sends()).toBe(2);
  });

  it("never treats a send Castra killed as a refusal, whatever it printed first", async () => {
    for (const killed of [
      new ExecError("agent-deck timed out after 45000ms and was killed", { stderr: REFUSAL, timedOut: true }),
      Object.assign(new Error("agent-deck output exceeded 1048576 bytes and was killed"), { stderr: REFUSAL }),
    ]) {
      const calls: string[] = [];
      const exec: ExecFn = async (cmd, args) => {
        calls.push(`${cmd} ${args.includes("send") ? "send" : args.join(" ")}`);
        if (cmd === "agent-deck" && args.includes("send")) throw killed;
        return "";
      };
      const tracker = new SendTracker();
      const adapter = createAgentDeckAdapter({ exec, sendTracker: tracker, sleep: noSleep });
      const err = await adapter.send({ profile: "march", sessionId: "s1", prompt: "go" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CastraAgentDeckError);
      expect(err).not.toBeInstanceOf(CastraComposerRefusedError);
      // No pane inspection, no trust-dialog retry, no cooldown.
      expect(calls).toEqual(["agent-deck send"]);
      expect(tracker.refusedSessionIds()).toEqual([]);
    }
  });
});

describe("castra adapter — review fixes (#702)", () => {
  const REFUSAL = "agent-deck: composer is occupied or unreadable";
  const sidecarRoot = fs.mkdtempSync(path.join(os.tmpdir(), "castra-adapter-702-"));
  const prevSkillsDir = process.env.MARCH_STEWARD_SKILLS_DIR;
  beforeEach(() => {
    process.env.MARCH_STEWARD_SKILLS_DIR = sidecarRoot;
  });
  afterEach(() => {
    if (prevSkillsDir === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
    else process.env.MARCH_STEWARD_SKILLS_DIR = prevSkillsDir;
  });
  afterAll(() => {
    fs.rmSync(sidecarRoot, { recursive: true, force: true });
  });

  const launchInput = { profile: "march", repoPath: "/repo", branch: "march/spawn/x", title: "Steward", group: "g" };
  const deckRecord = (id: string, worktreePath: string, createdAt = "2026-05-20T00:00:00Z") =>
    ({ id, title: "Steward", group: "g", worktree_branch: "", worktree_path: worktreePath, created_at: createdAt, status: "idle" });
  const subcommand = (args: readonly string[]) => args.find((a) => ["list", "launch", "show", "set"].includes(a));

  it("parses the session id and worktree agent-deck launch --json reports", () => {
    expect(parseLaunchOutput('{"success":true,"id":"a","session_id":"b","worktree_path":"/w"}')).toEqual({ sessionId: "b", worktreePath: "/w" });
    expect(parseLaunchOutput('note: something\n{"id":"a"}')).toEqual({ sessionId: "a" });
    expect(parseLaunchOutput("✓ Launched session: Steward")).toEqual({});
    expect(parseLaunchOutput("")).toEqual({});
  });

  it("takes the launched session from agent-deck's reported id, even when another launch made a same-named one", async () => {
    let listed = 0;
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push(`${cmd} ${subcommand(args) ?? args.join(" ")}`);
      if (cmd === "agent-deck" && args.includes("list")) {
        listed++;
        // After the launch: ours (older) and a concurrent same-branch launch in another repo (newer).
        return listed === 1 ? "[]" : JSON.stringify([
          deckRecord("ours", "/repo/feature-march-spawn-x", "2026-05-20T00:00:00Z"),
          deckRecord("theirs", "/other/feature-march-spawn-x", "2026-05-20T00:00:05Z"),
        ]);
      }
      if (cmd === "agent-deck" && args.includes("launch")) return '{"success":true,"session_id":"ours"}';
      if (cmd === "agent-deck" && args.includes("show")) return JSON.stringify(deckRecord("ours", "/repo/feature-march-spawn-x"));
      return "";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    const result = await adapter.launch(launchInput);
    expect(result.sessionId).toBe("ours");
    expect(result.worktreePath).toBe("/repo/feature-march-spawn-x");
    // An exact id needs no repo check.
    expect(calls.some((c) => c.includes("--git-common-dir"))).toBe(false);

    // Having seen ids reported, the next launch skips the before/after lists.
    calls.length = 0;
    await adapter.launch(launchInput);
    expect(calls.filter((c) => c === "agent-deck list")).toEqual([]);
  });

  it("refuses a list-diff pick whose worktree belongs to another repository", async () => {
    let listed = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args.includes("--git-common-dir")) {
        return args[1] === "/repo" ? "/repo/.git\n" : "/other/.git\n";
      }
      if (cmd === "agent-deck" && args.includes("list")) {
        listed++;
        return listed === 1 ? "[]" : JSON.stringify([deckRecord("theirs", "/other/feature-march-spawn-x")]);
      }
      return ""; // an agent-deck that reports no id
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    const err = await adapter.launch(launchInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CastraConflictError);
    expect((err as Error).message).toMatch(/belongs to the repository at "\/other\/.git", not "\/repo"/);
  });

  it("serializes list-diff launches into one profile+group", async () => {
    const order: string[] = [];
    const sessions: Record<string, unknown>[] = [];
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args.includes("--git-common-dir")) return "/repo/.git\n";
      const sub = subcommand(args);
      if (cmd === "agent-deck" && (sub === "list" || sub === "launch")) order.push(sub);
      if (cmd === "agent-deck" && sub === "list") return JSON.stringify(sessions);
      if (cmd === "agent-deck" && sub === "launch") {
        await new Promise((r) => setTimeout(r, 5));
        const branch = args[args.indexOf("--worktree") + 1]!;
        sessions.push(deckRecord(`s-${branch}`, `/repo/${expectedWorktreeDirName(branch)}`, `2026-05-20T00:00:0${sessions.length}Z`));
        return "";
      }
      return "";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    const [a, b] = await Promise.all([
      adapter.launch({ ...launchInput, branch: "march/spawn/a" }),
      adapter.launch({ ...launchInput, branch: "march/spawn/b" }),
    ]);
    expect([a.sessionId, b.sessionId]).toEqual(["s-march/spawn/a", "s-march/spawn/b"]);
    expect(order).toEqual(["list", "launch", "list", "list", "launch", "list"]);
  });

  it("fails closed when an agent-deck that reported ids launches without one, then serializes again", async () => {
    let reportIds = true;
    const calls: string[] = [];
    const sessions: Record<string, unknown>[] = [];
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args.includes("--git-common-dir")) return "/repo/.git\n";
      const sub = subcommand(args);
      if (cmd === "agent-deck") calls.push(sub ?? "");
      if (cmd === "agent-deck" && sub === "list") return JSON.stringify(sessions);
      if (cmd === "agent-deck" && sub === "show") return JSON.stringify(sessions.find((r) => r.id === args.at(-2) || r.id === args.at(-1)) ?? {});
      if (cmd === "agent-deck" && sub === "launch") {
        await new Promise((r) => setTimeout(r, 5));
        const id = `s${sessions.length}`;
        // Same repository and branch: only an id can tell these launches apart.
        sessions.push(deckRecord(id, "/repo/feature-march-spawn-x", `2026-05-20T00:00:0${sessions.length}Z`));
        return reportIds ? JSON.stringify({ session_id: id }) : "";
      }
      return "";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    expect((await adapter.launch(launchInput)).sessionId).toBe("s0");

    // A downgrade: two concurrent launches come back without ids. Neither can
    // be told apart from the other, so both fail rather than guess.
    reportIds = false;
    calls.length = 0;
    const results = await Promise.all([
      adapter.launch(launchInput).catch((e: unknown) => e),
      adapter.launch(launchInput).catch((e: unknown) => e),
    ]);
    for (const r of results) {
      expect(r).toBeInstanceOf(CastraAgentDeckError);
      expect((r as Error).message).toMatch(/reported no session id.*will not guess/s);
    }
    expect(calls).toEqual(["launch", "launch"]);

    // The next launch takes the serialized before/after list path.
    calls.length = 0;
    await adapter.launch({ ...launchInput, branch: "march/spawn/y" }).catch(() => undefined);
    expect(calls.slice(0, 2)).toEqual(["list", "launch"]);
  });

  it("a fallback launch waits for an id-path launch still running in its group", async () => {
    let reportIds = true;
    const events: string[] = [];
    const sessions: Record<string, unknown>[] = [];
    const gates = new Map<string, () => void>();
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "git" && args.includes("--git-common-dir")) return "/repo/.git\n";
      const sub = subcommand(args);
      if (cmd === "agent-deck" && sub === "list") {
        events.push("list");
        return JSON.stringify(sessions);
      }
      if (cmd === "agent-deck" && sub === "show") return JSON.stringify(sessions.find((r) => r.id === args.at(-2)) ?? {});
      if (cmd === "agent-deck" && sub === "launch") {
        const title = args[args.indexOf("-t") + 1] ?? args[args.indexOf("--title") + 1] ?? "";
        events.push(`launch:${title}`);
        if (title === "slow") await new Promise<void>((r) => gates.set("slow", r));
        const id = `s${sessions.length}`;
        sessions.push(deckRecord(id, "/repo/feature-march-spawn-x", `2026-05-20T00:00:${String(10 + sessions.length)}Z`));
        events.push(`created:${title}`);
        return reportIds ? JSON.stringify({ session_id: id }) : "";
      }
      return "";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    await adapter.launch({ ...launchInput, title: "first" });

    reportIds = false;
    events.length = 0;
    const fast = adapter.launch({ ...launchInput, title: "fast" }).catch((e: unknown) => e);
    const slow = adapter.launch({ ...launchInput, title: "slow" }).catch((e: unknown) => e);
    expect(await fast).toBeInstanceOf(CastraAgentDeckError);
    // The fallback starts after the first failure, while "slow" is still launching.
    const fallback = adapter.launch({ ...launchInput, title: "fallback" });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).not.toContain("list");
    gates.get("slow")!();
    expect(await slow).toBeInstanceOf(CastraAgentDeckError);
    const picked = await fallback;
    // Its before-list came after "slow" made its session, so it picks only its own.
    expect(events.indexOf("created:slow")).toBeLessThan(events.indexOf("list"));
    expect(picked.sessionId).toBe(`s${sessions.length - 1}`);
  });

  it("finds the launch object after chatter that holds braces", () => {
    expect(parseLaunchOutput('note: worktree {created}\n{"session_id":"s","worktree_path":"/w"}')).toEqual({ sessionId: "s", worktreePath: "/w" });
    expect(parseLaunchOutput('{"note":1} then\n{\n  "session_id": "t"\n}\n')).toEqual({ sessionId: "t" });
    expect(parseLaunchOutput("braces {but} no object")).toEqual({});
  });

  it("enables auto-mode only when its full timeout fits, and never with a cut one", async () => {
    let now = 0;
    const sets: number[] = [];
    const exec: ExecFn = async (cmd, args, opts) => {
      const sub = subcommand(args);
      if (cmd === "agent-deck" && sub === "launch") {
        now = 225_000; // the launch left 15s of the 240s budget
        return '{"session_id":"ours"}';
      }
      if (cmd === "agent-deck" && sub === "show") return JSON.stringify(deckRecord("ours", "/repo/feature-march-spawn-x"));
      if (cmd === "agent-deck" && sub === "set") sets.push(opts?.timeoutMs ?? -1);
      return "";
    };
    const warns: string[] = [];
    const adapter = createAgentDeckAdapter({
      exec,
      sleep: noSleep,
      now: () => now,
      logger: { info: () => undefined, warn: (_o, msg) => warns.push(msg) },
    });
    const launched = await adapter.launch(launchInput);
    expect(launched.sessionId).toBe("ours");
    expect(sets).toEqual([]);
    expect(warns.some((w) => /auto-mode .*skipped/.test(w))).toBe(true);

    // With room left it runs with its whole timeout.
    now = 0;
    const roomy: ExecFn = async (cmd, args, opts) => {
      const sub = subcommand(args);
      if (cmd === "agent-deck" && sub === "launch") return '{"session_id":"ours"}';
      if (cmd === "agent-deck" && sub === "show") return JSON.stringify(deckRecord("ours", "/repo/feature-march-spawn-x"));
      if (cmd === "agent-deck" && sub === "set") sets.push(opts?.timeoutMs ?? -1);
      return "";
    };
    await createAgentDeckAdapter({ exec: roomy, sleep: noSleep, now: () => 0 }).launch(launchInput);
    expect(sets).toEqual([60_000]);
  });

  it("a remove killed at its timeout is an error, even if it printed 'not found' first", async () => {
    const exec: ExecFn = async () => {
      throw new ExecError("agent-deck timed out after 120000ms and was killed", {
        stderr: "worktree not found, skipping\n",
        timedOut: true,
      });
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    const err = await adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CastraAgentDeckError);
    expect((err as Error).message).toMatch(/timed out[\s\S]*stderr before it stopped: worktree not found/);
  });

  it("a completed remove that reports the session missing is still removed:false", async () => {
    const exec: ExecFn = async () => {
      throw new ExecError("Command failed: agent-deck (exit code 1)", { stderr: "session not found", exitCode: 1 });
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    expect(await adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).toEqual({ removed: false });
  });

  it("does not cache an empty branch after a git timeout", async () => {
    let gitTimesOut = true;
    let showCurrent = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "agent-deck") return JSON.stringify([deckRecord("legacy", "/wt/legacy")]);
      if (args.includes("--is-inside-work-tree")) return "true\n";
      if (args.includes("--show-current")) {
        showCurrent++;
        if (gitTimesOut) throw new ExecError("git timed out", { timedOut: true });
        return "feature/x\n";
      }
      return "";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    expect((await adapter.list({ profile: "march" }))[0]!.branch).toBe("");
    gitTimesOut = false;
    expect((await adapter.list({ profile: "march" }))[0]!.branch).toBe("feature/x");
    // Settled now: served from the cache.
    expect((await adapter.list({ profile: "march" }))[0]!.branch).toBe("feature/x");
    expect(showCurrent).toBe(2);
  });

  it("looks up branches only for the requested group", async () => {
    const looked: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "agent-deck") {
        return JSON.stringify([
          { ...deckRecord("a", "/wt/a"), group: "g1" },
          { ...deckRecord("b", "/wt/b"), group: "g2" },
          { ...deckRecord("c", "/wt/c"), group: "g1" },
        ]);
      }
      if (args.includes("--is-inside-work-tree")) {
        looked.push(args[1]!);
        return "true\n";
      }
      return "main\n";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep });
    expect((await adapter.list({ profile: "march", group: "g1" })).map((s) => s.sessionId)).toEqual(["a", "c"]);
    expect(looked).toEqual(["/wt/a", "/wt/c"]);
  });

  it("sends when the cooldown ran out while the pane was being read", async () => {
    let now = 999;
    let sends = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        now = 1_000; // the cooldown ends during this read
        return "same pane";
      }
      if (cmd === "agent-deck" && args.includes("send")) sends++;
      return "";
    };
    const tracker = new SendTracker({ cooldownMs: 1_000, now: () => now });
    tracker.recordRefusal({ profile: "march", sessionId: "s1", message: "refused", tmuxSession: "t1", paneTail: "same pane", at: 0 });
    const adapter = createAgentDeckAdapter({ exec, sendTracker: tracker, sleep: noSleep });
    await expect(adapter.send({ profile: "march", sessionId: "s1", prompt: "go" })).resolves.toBeUndefined();
    expect(sends).toBe(1);
  });

  it("after a failed trust-dialog answer, the resolver's own keys do not end the cooldown", async () => {
    // Castra's dialog, where Enter on "Yes" does not close it: the resolver moves
    // the cursor (the pane changes) and then fails.
    let cursorOnYes = false;
    let sends = 0;
    const pane = () => [
      " Adding a new directory:",
      " /home/u/.march/steward",
      "",
      ` ${cursorOnYes ? " " : "❯"} No, exit`,
      ` ${cursorOnYes ? "❯" : " "} Yes, add it`,
    ].join("\n");
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "agent-deck" && args.includes("send")) {
        sends++;
        throw Object.assign(new Error("exit 1"), { stderr: REFUSAL });
      }
      if (cmd === "agent-deck" && args.includes("show")) return JSON.stringify({ id: "s1", tmux_session: "t1" });
      if (cmd === "tmux" && args[0] === "capture-pane") return pane();
      if (cmd === "tmux" && args[0] === "send-keys") {
        if (args[3] === "Down") cursorOnYes = true;
        return "";
      }
      return "";
    };
    const tracker = new SendTracker();
    const adapter = createAgentDeckAdapter({
      exec,
      sendTracker: tracker,
      sleep: noSleep,
      trustDialog: { ownedDirs: ["/home/u/.march/steward"] },
    });
    const first = await adapter.send({ profile: "march", sessionId: "s1", prompt: "go" }).catch((e: unknown) => e);
    expect((first as Error).message).toMatch(/could not answer the directory-trust dialog/);
    // The message keeps the pane as it was at refusal (cursor on No).
    expect((first as Error).message).toMatch(/❯ No, exit/);
    const second = await adapter.send({ profile: "march", sessionId: "s1", prompt: "go" }).catch((e: unknown) => e);
    expect((second as CastraComposerRefusedError).cached).toBe(true);
    expect(sends).toBe(1);
  });

  it("a send whose budget ran out while queued is not started", async () => {
    let now = 0;
    let release!: () => void;
    const sends: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "agent-deck" && args.includes("send")) {
        sends.push(args.at(-1)!);
        if (sends.length === 1) {
          await new Promise<void>((r) => (release = r));
          now = 60_000; // the first send held the queue for a minute
        }
      }
      return "";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep, now: () => now, budgets: { sendMs: 100_000 } });
    const first = adapter.send({ profile: "march", sessionId: "s1", prompt: "one" });
    const second = adapter.send({ profile: "march", sessionId: "s1", prompt: "two" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;
    const err = await second;
    // 100s budget, 60s spent queued: a whole 45s send no longer fits.
    expect(err).toBeInstanceOf(CastraAgentDeckError);
    expect((err as Error).message).toMatch(/send budget ran out before the send, so it was not started/);
    expect(sends).toEqual(["one"]);
  });

  it("a launch that cannot fit its 180s subprocess in the budget is not started", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push(subcommand(args) ?? "");
      return "[]";
    };
    const adapter = createAgentDeckAdapter({ exec, sleep: noSleep, budgets: { launchMs: 100_000 } });
    await expect(adapter.launch(launchInput)).rejects.toThrow(/launch budget ran out before agent-deck launch/);
    expect(calls).not.toContain("launch");
  });
});

describe("castra adapter — budgets agree with the step timeouts", () => {
  it("each mutating step fits its operation's budget", async () => {
    const { AGENT_DECK_LAUNCH_TIMEOUT_MS, AGENT_DECK_SEND_TIMEOUT_MS, AGENT_DECK_REMOVE_TIMEOUT_MS } = await import("./adapter.js");
    const budgets = await import("./budgets.js");
    expect(AGENT_DECK_LAUNCH_TIMEOUT_MS).toBeLessThan(budgets.CASTRA_LAUNCH_BUDGET_MS);
    // The send and its one retry.
    expect(2 * AGENT_DECK_SEND_TIMEOUT_MS).toBeLessThan(budgets.CASTRA_SEND_BUDGET_MS);
    expect(AGENT_DECK_REMOVE_TIMEOUT_MS).toBeLessThanOrEqual(budgets.CASTRA_REMOVE_BUDGET_MS);
  });
});
