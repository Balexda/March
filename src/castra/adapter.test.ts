import { describe, it, expect, beforeEach, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMock.execFileSync,
}));

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
  parseAgentDeckSession,
  pickLaunchedSession,
  resolveAgentDeckEnv,
} from "./adapter.js";
import {
  CastraAgentDeckError,
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

describe("castra adapter — argv builders", () => {
  it("builds list args with the profile flag", () => {
    expect(buildListArgs("march")).toEqual(["-p", "march", "list", "--json"]);
  });

  it("builds launch args mirroring the Hatchery handoff shape", () => {
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
      "--extra-arg",
      "--permission-mode",
      "--extra-arg",
      "auto",
      "--extra-arg",
      "--model",
      "--extra-arg",
      "opus",
    ]);
  });

  it("defaults the launch model when none is given", () => {
    const args = buildLaunchArgs({
      profile: "march",
      repoPath: "/repo",
      title: "t",
      group: "g",
      branch: "b",
    });
    expect(args.at(-1)).toBe("opus");
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

  it("hands the resolved env (with $TMUX) to the spawned agent-deck", () => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_TMPDIR", "");
    childProcessMock.execFileSync.mockReset();
    childProcessMock.execFileSync.mockReturnValue("[]");
    try {
      createAgentDeckAdapter().list({ profile: "march" });
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
  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
  });

  it("lists sessions, filtering by group when given", () => {
    childProcessMock.execFileSync.mockReturnValue(
      JSON.stringify([
        session({ sessionId: "a", group: "g1" }),
        session({ sessionId: "b", group: "g2" }),
      ]),
    );
    const adapter = createAgentDeckAdapter();
    expect(adapter.list({ profile: "march" })).toHaveLength(2);
    expect(adapter.list({ profile: "march", group: "g1" }).map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("launches and returns the identified session", () => {
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
    const adapter = createAgentDeckAdapter();
    const result = adapter.launch({
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

  it("stamps launch metadata, returns it on launch, and re-attaches it on list/show (#214)", () => {
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
    const adapter = createAgentDeckAdapter();
    const launched = adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
      metadata: { sliceId: "slice-7", spawnId: "sp-1" },
    });
    expect(launched.metadata).toEqual({ sliceId: "slice-7", spawnId: "sp-1" });

    // list re-attaches the Castra-owned metadata even though agent-deck omits it.
    const listed = adapter.list({ profile: "march" }).find((s) => s.sessionId === "sess-new");
    expect(listed?.metadata).toEqual({ sliceId: "slice-7", spawnId: "sp-1" });
    // show does too.
    expect(adapter.show({ profile: "march", sessionId: "sess-new" }).metadata).toEqual({
      sliceId: "slice-7",
      spawnId: "sp-1",
    });
  });

  it("backfills an empty branch from the launch branch on list (stale-branch fix #214)", () => {
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
    const adapter = createAgentDeckAdapter();
    adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
    });
    const listed = adapter.list({ profile: "march" }).find((s) => s.sessionId === "sess-new");
    expect(listed?.branch).toBe("march/spawn/x");
  });

  it("derives an empty session branch from the working directory's git head (#264)", () => {
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
    const adapter = createAgentDeckAdapter();
    const listed = adapter.list({ profile: "march" }).find((s) => s.sessionId === "legacy");
    expect(listed?.branch).toBe("feature/smithy/cut/01");
  });

  it("returns an empty branch for a non-git working directory (#264)", () => {
    childProcessMock.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "agent-deck" && args.includes("list")) {
        return JSON.stringify([
          session({ sessionId: "nogit", group: "g", branch: "", worktreePath: "/tmp/plain" }),
        ]);
      }
      if (cmd === "git") throw execError("not a git repository");
      return "";
    });
    const adapter = createAgentDeckAdapter();
    const listed = adapter.list({ profile: "march" }).find((s) => s.sessionId === "nogit");
    expect(listed?.branch).toBe("");
  });

  it("returns an empty branch for a detached HEAD checkout (#264)", () => {
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
    const adapter = createAgentDeckAdapter();
    const listed = adapter.list({ profile: "march" }).find((s) => s.sessionId === "detached");
    expect(listed?.branch).toBe("");
  });

  it("caches the derived branch for the session lifetime — git runs once across calls (#264)", () => {
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
    const adapter = createAgentDeckAdapter();
    expect(adapter.list({ profile: "march" })[0]?.branch).toBe("feature/x");
    expect(adapter.list({ profile: "march" })[0]?.branch).toBe("feature/x");
    const gitShowCurrentCalls = childProcessMock.execFileSync.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("--show-current"),
    );
    expect(gitShowCurrentCalls).toHaveLength(1);
  });

  it("re-derives the branch after the session is removed (cache invalidation #264)", () => {
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
    const adapter = createAgentDeckAdapter();
    adapter.list({ profile: "march" });
    adapter.remove({ profile: "march", sessionId: "recycle", pruneWorktree: false });
    adapter.list({ profile: "march" });
    const gitShowCurrentCalls = childProcessMock.execFileSync.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1].includes("--show-current"),
    );
    // Once before remove, once after — the cache was invalidated on remove.
    expect(gitShowCurrentCalls).toHaveLength(2);
  });

  it("forgets a session's metadata after remove", () => {
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
    const adapter = createAgentDeckAdapter();
    adapter.launch({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
      metadata: { sliceId: "slice-7" },
    });
    expect(adapter.remove({ profile: "march", sessionId: "sess-new", pruneWorktree: false })).toEqual({
      removed: true,
    });
    const listed = adapter.list({ profile: "march" }).find((s) => s.sessionId === "sess-new");
    expect(listed?.metadata).toBeUndefined();
  });

  it("raises a conflict when the launched worktree dir does not match the branch", () => {
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
    const adapter = createAgentDeckAdapter();
    expect(() =>
      adapter.launch({
        profile: "march",
        repoPath: "/repo",
        branch: "march/spawn/x",
        title: "t",
        group: "g",
      }),
    ).toThrow(CastraConflictError);
  });

  it("reports removed:true on success and removed:false when the session is already gone", () => {
    const adapter = createAgentDeckAdapter();
    childProcessMock.execFileSync.mockReturnValueOnce("");
    expect(adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).toEqual({
      removed: true,
    });
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw execError("session not found");
    });
    expect(adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).toEqual({
      removed: false,
    });
  });

  it("maps an unexpected remove failure to a 502-class error", () => {
    const adapter = createAgentDeckAdapter();
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw execError("tmux server connection refused");
    });
    expect(() => adapter.remove({ profile: "p", sessionId: "s", pruneWorktree: true })).toThrow(
      CastraAgentDeckError,
    );
  });

  it("throws not-found when showing a missing session", () => {
    const adapter = createAgentDeckAdapter();
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw execError("no such session");
    });
    expect(() => adapter.show({ profile: "p", sessionId: "missing" })).toThrow(CastraNotFoundError);
  });

  it("truncates output to the last N lines", () => {
    const adapter = createAgentDeckAdapter();
    childProcessMock.execFileSync.mockReturnValueOnce("l1\nl2\nl3\nl4\nl5");
    expect(adapter.output({ profile: "p", sessionId: "s", lines: 2 })).toEqual({
      output: "l4\nl5",
      truncated: true,
    });
  });

  it("reports reachability from agent-deck --version", () => {
    const adapter = createAgentDeckAdapter();
    childProcessMock.execFileSync.mockReturnValueOnce("agent-deck 1.9.17");
    expect(adapter.reachable()).toBe(true);
    childProcessMock.execFileSync.mockImplementationOnce(() => {
      throw new Error("not installed");
    });
    expect(adapter.reachable()).toBe(false);
  });
});
