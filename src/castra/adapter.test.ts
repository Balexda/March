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
  buildSessionSendArgs,
  buildSessionSetArgs,
  buildSessionShowArgs,
  createAgentDeckAdapter,
  expectedWorktreeDirName,
  parseAgentDeckSession,
  pickLaunchedSession,
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
});

describe("castra adapter — pure parsers", () => {
  it("derives the worktree dir from a branch", () => {
    expect(expectedWorktreeDirName("march/spawn/x")).toBe("feature-march-spawn-x");
  });

  it("picks the launched session by matching worktree dir", () => {
    const sessions: CastraSession[] = [
      { sessionId: "old", title: "", group: "g", branch: "", worktreePath: "/repo/feature-other", createdAt: "1" },
      { sessionId: "new", title: "", group: "g", branch: "", worktreePath: "/repo/feature-march-spawn-x", createdAt: "2" },
    ];
    const picked = pickLaunchedSession(sessions, new Set(["old"]), "march/spawn/x");
    expect(picked?.sessionId).toBe("new");
  });

  it("parses agent-deck session records with fallback field names", () => {
    const parsed = parseAgentDeckSession(session({ sessionId: "abc" }));
    expect(parsed?.sessionId).toBe("abc");
    expect(parsed?.worktreePath).toBe("/repo/feature-march-spawn-x");
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
