import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopMeta } from "../legate/loop/meta.js";

// vi.mock is hoisted; close over a mutable handle so each test can route
// execFile(command,args,…) output. sense-io's execText is the only execFile user.
const childProcessMock = { execFile: vi.fn() };
vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));

// Import under test AFTER vi.mock so the stub is applied to its imports.
const { buildSenseIo, createSenseIo, gitHubAuthConfigArgs, summarizeReviews } = await import("./sense-io.js");

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
      "readSmithyStatus",
      "queryPr",
      "discoverPr",
      "sessionOutput",
    ] as const) {
      expect(typeof (deps as unknown as Record<string, unknown>)[key]).toBe("function");
    }
    // The default-branch sync is Herald-owned (#300) and no longer part of the
    // injected SenseDeps — only the raw bundle (`createSenseIo`) exposes it.
    expect((deps as unknown as Record<string, unknown>).syncDefaultBranch).toBeUndefined();
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

describe("summarizeReviews", () => {
  it("counts a human approval, excludes bots", () => {
    expect(
      summarizeReviews([
        { state: "APPROVED", submittedAt: "2026-05-20T01:00:00Z", author: { login: "alice", __typename: "User" } },
        { state: "APPROVED", submittedAt: "2026-05-20T02:00:00Z", author: { login: "copilot", __typename: "Bot" } },
        { state: "APPROVED", submittedAt: "2026-05-20T03:00:00Z", author: { login: "dependabot[bot]", __typename: "User" } },
      ]),
    ).toEqual({ human_approval_count: 1, changes_requested_count: 0 });
  });

  it("uses each human's latest non-COMMENTED review (approval supersedes earlier CR)", () => {
    expect(
      summarizeReviews([
        { state: "CHANGES_REQUESTED", submittedAt: "2026-05-20T01:00:00Z", author: { login: "bob", __typename: "User" } },
        { state: "COMMENTED", submittedAt: "2026-05-20T02:00:00Z", author: { login: "bob", __typename: "User" } },
        { state: "APPROVED", submittedAt: "2026-05-20T03:00:00Z", author: { login: "bob", __typename: "User" } },
      ]),
    ).toEqual({ human_approval_count: 1, changes_requested_count: 0 });
  });

  it("counts an outstanding changes-requested", () => {
    expect(
      summarizeReviews([
        { state: "APPROVED", submittedAt: "2026-05-20T01:00:00Z", author: { login: "alice", __typename: "User" } },
        { state: "CHANGES_REQUESTED", submittedAt: "2026-05-20T02:00:00Z", author: { login: "bob", __typename: "User" } },
      ]),
    ).toEqual({ human_approval_count: 1, changes_requested_count: 1 });
  });

  it("handles empty / non-array input", () => {
    expect(summarizeReviews([])).toEqual({ human_approval_count: 0, changes_requested_count: 0 });
    expect(summarizeReviews(undefined)).toEqual({ human_approval_count: 0, changes_requested_count: 0 });
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
                headRefOid: "abc123",
                mergeStateStatus: "BLOCKED",
                reviews: {
                  nodes: [
                    { state: "APPROVED", submittedAt: "2026-05-20T04:00:00Z", author: { login: "alice", __typename: "User" } },
                  ],
                },
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
      head_sha: "abc123",
      merge_state_status: "blocked",
      review_decision: "CHANGES_REQUESTED",
      checks: "FAIL",
      thread_count: 1,
      needs_response_count: 1,
      human_approval_count: 1,
      changes_requested_count: 0,
    });
    expect(pr.failed_checks).toEqual([{ name: "lint", url: "http://ci/lint" }]);
    expect(pr.unresolved_threads[0]).toMatchObject({
      author: "reviewer",
      needs_response: true,
      body_preview: "please fix",
      // #224: every comment's databaseId, for comment-id-based review-fix dedup.
      comment_ids: [11],
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

describe("discoverPrForSlice escalated-slice floor skip (#173)", () => {
  // An escalated slice's last_action is the escalation timestamp; the open PR it
  // must adopt was opened during an EARLIER dispatch, so it predates last_action.
  // discoverPrForSlice skips the prDiscoverySince floor for escalated slices so
  // Herald can observe that PR (the legate then adopts from the fold). The floor
  // still applies to the implementing/babysit discovery path.
  const routeBranchPr = (created: string) =>
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("list")) {
        return JSON.stringify([
          { number: 42, url: "https://github.com/octo/march/pull/42", state: "OPEN", headRefName: "feature/right", title: "Ours", createdAt: created },
        ]);
      }
      if (cmd === "gh" && args.includes("view")) {
        return JSON.stringify({
          number: 42,
          url: "https://github.com/octo/march/pull/42",
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

  const state = () => ({ repo: { path: "/repo", owner_with_name: "octo/march" } });
  const PR_CREATED = "2026-05-20T01:00:00Z"; // BEFORE the slice's last_action below
  const LAST_ACTION = "2026-05-25T00:00:00Z";

  it("finds the branch's open PR for an escalated slice even though it predates last_action", async () => {
    routeBranchPr(PR_CREATED);
    const io = createSenseIo({ meta: meta(), castra: fakeCastra({ sessionOutput: async () => "" }) });
    const slice = { branch: "feature/right", last_action: LAST_ACTION, stage: "escalated" };
    const pr = await io.discoverPrForSlice(slice, state(), "sess-x");
    expect(pr).not.toBeNull();
    expect(pr.number).toBe(42);
    expect(pr.head_branch).toBe("feature/right");
  });

  it("still floors candidates by last_action for a non-escalated (implementing) slice", async () => {
    routeBranchPr(PR_CREATED);
    const io = createSenseIo({ meta: meta(), castra: fakeCastra({ sessionOutput: async () => "" }) });
    const slice = { branch: "feature/right", last_action: LAST_ACTION, stage: "implementing" };
    // The since floor excludes the older PR — original behavior preserved.
    expect(await io.discoverPrForSlice(slice, state(), "sess-x")).toBeNull();
  });

  it("returns null for an escalated slice when no open PR matches its branch", async () => {
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("list")) {
        return JSON.stringify([
          { number: 99, url: "https://github.com/octo/march/pull/99", state: "OPEN", headRefName: "feature/wrong", title: "Unrelated", createdAt: PR_CREATED },
        ]);
      }
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra({ sessionOutput: async () => "" }) });
    const slice = { branch: "feature/right", last_action: LAST_ACTION, stage: "escalated" };
    expect(await io.discoverPrForSlice(slice, state(), "sess-x")).toBeNull();
  });
});

describe("syncDefaultBranch (Herald-owned, via the raw bundle — #300)", () => {
  it("fetches/switches/pulls the known default branch and returns the result", async () => {
    const calls: string[][] = [];
    routeExec((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse")) return "deadbeef\n";
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const result = await io.syncDefaultBranch({ repo: { path: "/repo", default_branch: "main" } });
    expect(result).toMatchObject({ default_branch: "main", synced: true, head: "deadbeef" });
    const joined = calls.map((c) => c.join(" "));
    expect(joined).toContain("git fetch origin main");
    expect(joined).toContain("git switch main");
    expect(joined).toContain("git pull --ff-only origin main");
  });

  it("resolves a non-`main` default (e.g. master) via origin/HEAD when none is known", async () => {
    const calls: string[][] = [];
    routeExec((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("symbolic-ref")) return "origin/master\n";
      if (args.includes("rev-parse")) return "cafe\n";
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const result = await io.syncDefaultBranch({ repo: { path: "/repo" } });
    expect(result).toMatchObject({ default_branch: "master", synced: true });
    const joined = calls.map((c) => c.join(" "));
    expect(joined).toContain("git fetch origin master");
    expect(joined).toContain("git pull --ff-only origin master");
  });

  it("rewrites SSH remotes to token-auth HTTPS on the network ops when a token is set (#301)", async () => {
    const calls: string[][] = [];
    routeExec((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse")) return "deadbeef\n";
      return "";
    });
    // env-injected token → the fetch/pull carry the insteadOf rewrite; the local
    // `switch` does not need auth.
    const io = createSenseIo({ meta: meta(), castra: fakeCastra(), env: { GH_TOKEN: "ghs_abc" } as NodeJS.ProcessEnv });
    await io.syncDefaultBranch({ repo: { path: "/repo", default_branch: "main" } });
    const fetch = calls.find((c) => c.includes("fetch"))!;
    const pull = calls.find((c) => c.includes("pull"))!;
    const sw = calls.find((c) => c.includes("switch"))!;
    const rewrite = "url.https://x-access-token:ghs_abc@github.com/.insteadOf=git@github.com:";
    expect(fetch).toContain(rewrite);
    expect(pull).toContain(rewrite);
    // The rewrite precedes the subcommand (it is a top-level `git -c` flag).
    expect(fetch.indexOf("-c")).toBeLessThan(fetch.indexOf("fetch"));
    expect(sw).not.toContain(rewrite);
  });

  it("emits no rewrite when no token is set (falls back to the remote as-is)", async () => {
    const calls: string[][] = [];
    routeExec((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse")) return "deadbeef\n";
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra(), env: {} as NodeJS.ProcessEnv });
    await io.syncDefaultBranch({ repo: { path: "/repo", default_branch: "main" } });
    const fetch = calls.find((c) => c.includes("fetch"))!;
    expect(fetch).toEqual(["git", "fetch", "origin", "main"]);
  });
});

describe("gitHubAuthConfigArgs (#301)", () => {
  it("emits accumulating insteadOf rewrites for both SSH remote forms when a token is set", () => {
    const args = gitHubAuthConfigArgs({ GH_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(args).toEqual([
      "-c",
      "url.https://x-access-token:tok@github.com/.insteadOf=git@github.com:",
      "-c",
      "url.https://x-access-token:tok@github.com/.insteadOf=ssh://git@github.com/",
    ]);
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN, and trims", () => {
    const args = gitHubAuthConfigArgs({ GH_TOKEN: " a ", GITHUB_TOKEN: "b" } as NodeJS.ProcessEnv);
    expect(args[1]).toContain("x-access-token:a@github.com");
  });

  it("falls back to GITHUB_TOKEN when GH_TOKEN is absent", () => {
    const args = gitHubAuthConfigArgs({ GITHUB_TOKEN: "b" } as NodeJS.ProcessEnv);
    expect(args[1]).toContain("x-access-token:b@github.com");
  });

  it("returns [] when neither token is set", () => {
    expect(gitHubAuthConfigArgs({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("listOpenPrs (open-PR change-cursor probe)", () => {
  it("builds the number→{updatedAt,headRefName} index from one graphql call", async () => {
    let graphqlArgs: string[] | undefined;
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("graphql")) {
        graphqlArgs = args;
        return JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  { number: 7, updatedAt: "T2", headRefName: "feature/a" },
                  { number: 9, updatedAt: "T1", headRefName: "feature/b" },
                ],
              },
            },
          },
        });
      }
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const result = await io.listOpenPrs({ repo: { owner_with_name: "octo/march" } });
    expect(result instanceof Map).toBe(true);
    const map = result as Map<number, { updatedAt: string; headRefName: string }>;
    expect(map.get(7)).toEqual({ updatedAt: "T2", headRefName: "feature/a" });
    expect(map.get(9)).toEqual({ updatedAt: "T1", headRefName: "feature/b" });
    // The owner/name are passed as graphql variables, split from owner_with_name.
    expect(graphqlArgs).toEqual(expect.arrayContaining(["owner=octo", "name=march"]));
  });

  it("returns {error} (never throws) when the repo owner can't be resolved", async () => {
    routeExec((cmd, args) => (cmd === "gh" && args.includes("repo") ? "" : "")); // empty nameWithOwner
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    expect(await io.listOpenPrs({ repo: { path: "/repo" } })).toEqual({ error: "repo owner unavailable" });
  });

  it("returns {error} when the probe query fails (so the caller degrades, not strands)", async () => {
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("graphql")) throw new Error("HTTP 403: rate limit exceeded");
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const result = await io.listOpenPrs({ repo: { owner_with_name: "octo/march" } });
    expect(result).toMatchObject({ error: expect.stringContaining("rate limit") });
  });
});

describe("repoOwner caching (#gh-over-usage)", () => {
  it("resolves the owner via gh ONCE and reuses it across PR queries (no per-slice gh repo view)", async () => {
    let repoViews = 0;
    routeExec((cmd, args) => {
      if (cmd === "gh" && args.includes("repo") && args.includes("view")) {
        repoViews++;
        return "octo/march";
      }
      if (cmd === "gh" && args.includes("pr") && args.includes("view")) {
        return JSON.stringify({
          number: Number(args[2]),
          state: "OPEN",
          headRefName: "b",
          author: { login: "me" },
          statusCheckRollup: [],
        });
      }
      if (args.includes("graphql")) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      }
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    // No owner_with_name in state → the owner must be resolved via `gh repo view`.
    const state = { repo: { path: "/repo" } };
    await io.queryPrForBabysit({ pr: { number: 7 } }, state);
    await io.queryPrForBabysit({ pr: { number: 8 } }, state);
    expect(repoViews).toBe(1);
  });
});
