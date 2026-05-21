import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopMeta } from "../legate/loop/meta.js";

// vi.mock is hoisted; close over a mutable handle so each test can route
// execFile(command,args,…) output. sense-io's execText is the only execFile user.
const childProcessMock = { execFile: vi.fn() };
vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));

// Import under test AFTER vi.mock so the stub is applied to its imports.
const { buildSenseIo, createSenseIo } = await import("./sense-io.js");

/** Route execFile by command+args to canned stdout. */
function routeExec(router: (cmd: string, args: string[]) => string): void {
  childProcessMock.execFile.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb?: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as (
        e: unknown,
        out: string,
        err: string,
      ) => void;
      try {
        callback(null, router(cmd, args), "");
      } catch (err) {
        callback(err, "", String((err as Error).message));
      }
    },
  );
}

function fakeCastra(over: Partial<Record<string, unknown>> = {}): any {
  return {
    listSessions: async () => [],
    sessionOutput: async () => "",
    sendPrompt: async () => {},
    ...over,
  };
}

function meta(over: Partial<LoopMeta> = {}): LoopMeta {
  return {
    profile: "default",
    worker_group: "legate-workers",
    repo: { name: "march", path: "/repo" },
    legate_state_path: "/nonexistent/state.json",
    ...over,
  } as unknown as LoopMeta;
}

afterEach(() => {
  childProcessMock.execFile.mockReset();
});

describe("buildSenseIo → SenseDeps", () => {
  it("exposes the full SenseDeps contract", () => {
    const deps = buildSenseIo({ meta: meta(), castra: fakeCastra() });
    expect(deps.meta).toBeDefined();
    expect(typeof deps.now()).toBe("string");
    for (const key of [
      "listSessions",
      "syncDefaultBranch",
      "readSmithyStatus",
      "queryPr",
      "discoverPr",
      "sessionOutput",
    ] as const) {
      expect(typeof (deps as unknown as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("omits warn when not provided and includes it when provided", () => {
    expect(buildSenseIo({ meta: meta(), castra: fakeCastra() }).warn).toBeUndefined();
    const warn = vi.fn();
    expect(buildSenseIo({ meta: meta(), castra: fakeCastra(), warn }).warn).toBe(warn);
  });
});

describe("listSessions", () => {
  it("maps Castra sessions to the agent-deck-shaped objects the loop consumes", async () => {
    const io = createSenseIo({
      meta: meta(),
      castra: fakeCastra({
        listSessions: async () => [
          {
            sessionId: "s1",
            title: "slice-a",
            group: "legate-workers",
            status: "running",
            branch: "feature/a",
            worktreePath: "/wt/a",
            createdAt: "2026-05-20T00:00:00Z",
          },
        ],
      }),
    });
    const sessions = await io.listSessions();
    expect(sessions).toEqual([
      {
        id: "s1",
        title: "slice-a",
        name: "slice-a",
        group: "legate-workers",
        status: "running",
        branch: "feature/a",
        worktree_path: "/wt/a",
        created_at: "2026-05-20T00:00:00Z",
      },
    ]);
  });

  it("returns {error} when Castra throws (so summarizeWorkers reports unavailable)", async () => {
    const io = createSenseIo({
      meta: meta(),
      castra: fakeCastra({
        listSessions: async () => {
          throw new Error("castra down");
        },
      }),
    });
    expect(await io.listSessions()).toEqual({ error: "castra down" });
  });
});

describe("captureRecentSessionOutput", () => {
  it("returns trimmed output and {output:'',error} on failure", async () => {
    const ok = createSenseIo({
      meta: meta(),
      castra: fakeCastra({ sessionOutput: async () => "  hello world  \n" }),
    });
    expect(await ok.captureRecentSessionOutput("s1")).toEqual({ output: "hello world" });

    const bad = createSenseIo({
      meta: meta(),
      castra: fakeCastra({
        sessionOutput: async () => {
          throw new Error("nope");
        },
      }),
    });
    expect(await bad.captureRecentSessionOutput("s1")).toEqual({ output: "", error: "nope" });
  });
});

describe("queryPrForBabysit", () => {
  it("assembles the babysit PR shape from gh pr view + review-thread graphql", async () => {
    routeExec((_cmd, args) => {
      if (args.includes("graphql")) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            databaseId: 11,
                            body: "please fix",
                            path: "a.ts",
                            line: 3,
                            author: { login: "reviewer" },
                            createdAt: "2026-05-20T01:00:00Z",
                          },
                        ],
                      },
                    },
                    { isResolved: true, comments: { nodes: [] } },
                  ],
                },
              },
            },
          },
        });
      }
      // gh pr view
      return JSON.stringify({
        number: 42,
        url: "https://github.com/octo/march/pull/42",
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        headRefName: "feature/a",
        title: "Add a",
        author: { login: "me" },
        statusCheckRollup: [
          { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "http://ci/lint" },
        ],
      });
    });

    const io = createSenseIo({
      meta: meta(),
      castra: fakeCastra(),
    });
    const pr = await io.queryPrForBabysit(
      { pr: { number: 42 } },
      { repo: { path: "/repo", owner_with_name: "octo/march" } },
    );
    expect(pr).toMatchObject({
      number: 42,
      state: "OPEN",
      head_branch: "feature/a",
      review_decision: "CHANGES_REQUESTED",
      checks: "FAIL",
      thread_count: 1,
      needs_response_count: 1,
    });
    expect(pr.failed_checks).toEqual([{ name: "lint", url: "http://ci/lint" }]);
    expect(pr.unresolved_threads[0]).toMatchObject({
      author: "reviewer",
      needs_response: true,
      body_preview: "please fix",
    });
  });

  it("skips when the slice has no PR number", async () => {
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const pr = await io.queryPrForBabysit({}, { repo: { owner_with_name: "octo/march" } });
    expect(pr).toEqual({ skipped: true, reason: "missing_pr_number" });
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
  });
});

describe("discoverPrForSlice (branch-based lookup)", () => {
  // Regression for issue #178 bug 1: the candidate filter awaits the async
  // prMatchesSliceBranch. Before the fix it filtered on the raw Promise (always
  // truthy), so every open PR "matched" and the newest one was adopted —
  // including a PR on the wrong branch.
  it("does NOT adopt a newer PR on the wrong branch; picks the branch match", async () => {
    let viewedNumber: string | undefined;
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("list")) {
        // Wrong-branch PR is NEWER — if the predicate isn't awaited it would
        // win the createdAt sort and be (incorrectly) adopted.
        return JSON.stringify([
          {
            number: 99,
            url: "https://github.com/octo/march/pull/99",
            state: "OPEN",
            headRefName: "feature/wrong",
            title: "Unrelated",
            createdAt: "2026-05-20T10:00:00Z",
          },
          {
            number: 42,
            url: "https://github.com/octo/march/pull/42",
            state: "OPEN",
            headRefName: "feature/right",
            title: "Ours",
            createdAt: "2026-05-20T01:00:00Z",
          },
        ]);
      }
      if (cmd === "gh" && args.includes("view")) {
        viewedNumber = args[2];
        return JSON.stringify({
          number: Number(viewedNumber),
          url: "https://github.com/octo/march/pull/" + viewedNumber,
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefName: "feature/right",
          title: "Ours",
          author: { login: "me" },
          statusCheckRollup: [],
        });
      }
      if (args.includes("graphql")) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      }
      return "";
    });

    const io = createSenseIo({ meta: meta(), castra: fakeCastra({ sessionOutput: async () => "" }) });
    const slice = { branch: "feature/right" };
    const state = { repo: { path: "/repo", owner_with_name: "octo/march" } };
    const pr = await io.discoverPrForSlice(slice, state, "sess-1");

    expect(pr).not.toBeNull();
    expect(pr.number).toBe(42);
    expect(pr.head_branch).toBe("feature/right");
    expect(viewedNumber).toBe("42"); // never hydrated the wrong-branch PR #99
  });

  it("returns null when no candidate matches the slice branch", async () => {
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("list")) {
        return JSON.stringify([
          {
            number: 99,
            url: "https://github.com/octo/march/pull/99",
            state: "OPEN",
            headRefName: "feature/wrong",
            title: "Unrelated",
            createdAt: "2026-05-20T10:00:00Z",
          },
        ]);
      }
      return "";
    });

    const io = createSenseIo({ meta: meta(), castra: fakeCastra({ sessionOutput: async () => "" }) });
    const pr = await io.discoverPrForSlice(
      { branch: "feature/right" },
      { repo: { path: "/repo", owner_with_name: "octo/march" } },
      "sess-2",
    );
    expect(pr).toBeNull();
  });
});

describe("syncDefaultBranch (via SenseDeps)", () => {
  it("fetches/switches/pulls the known default branch and resolves void", async () => {
    const calls: string[][] = [];
    routeExec((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse")) return "deadbeef\n";
      return "";
    });
    const deps = buildSenseIo({ meta: meta(), castra: fakeCastra() });
    await expect(deps.syncDefaultBranch("/repo", "main")).resolves.toBeUndefined();
    const joined = calls.map((c) => c.join(" "));
    expect(joined).toContain("git fetch origin main");
    expect(joined).toContain("git switch main");
    expect(joined).toContain("git pull --ff-only origin main");
  });
});
