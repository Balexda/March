/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopMeta } from "../legate/loop/meta.js";
import type { LoopState } from "../legate/loop/state/types.js";

// vi.mock is hoisted; close over a mutable handle so each test can route
// execFile(command,args,…) output. sense-io's execText is the only execFile user.
const childProcessMock = { execFile: vi.fn() };
vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));

// Import under test AFTER vi.mock so the stub is applied to its imports.
const { buildSenseIo, createSenseIo, gitHubAuthConfigArgs, summarizeReviews } = await import("./sense-io.js");
// The two consumers of the sensed `conversation_comments` (the comment-fix
// dispatch and the owes_comments merge blocker), for the end-to-end Codex case.
const { assess } = await import("../legate/loop/handlers/babysit.js");
const { mergeBlocker } = await import("../legate/loop/pure/slice.js");

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
    ).toEqual({ human_approval_count: 1, changes_requested_count: 0, bot_approval_count: 2 });
  });

  it("counts bot approvals separately, never as human ones", () => {
    expect(
      summarizeReviews([
        { state: "APPROVED", submittedAt: "2026-05-20T01:00:00Z", author: { login: "copilot-pull-request-reviewer", __typename: "Bot" } },
      ]),
    ).toEqual({ human_approval_count: 0, changes_requested_count: 0, bot_approval_count: 1 });
  });

  it("a dismissed or superseded bot approval does not count; a later bot comment does not hide one", () => {
    const bot = { login: "copilot-pull-request-reviewer", __typename: "Bot" };
    expect(
      summarizeReviews([{ state: "DISMISSED", submittedAt: "2026-05-20T01:00:00Z", author: bot }]).bot_approval_count,
    ).toBe(0);
    expect(
      summarizeReviews([
        { state: "APPROVED", submittedAt: "2026-05-20T01:00:00Z", author: bot },
        { state: "CHANGES_REQUESTED", submittedAt: "2026-05-20T02:00:00Z", author: bot },
      ]),
    ).toEqual({ human_approval_count: 0, changes_requested_count: 0, bot_approval_count: 0 });
    expect(
      summarizeReviews([
        { state: "APPROVED", submittedAt: "2026-05-20T01:00:00Z", author: bot },
        { state: "COMMENTED", submittedAt: "2026-05-20T02:00:00Z", author: bot },
      ]).bot_approval_count,
    ).toBe(1);
  });

  it("uses each human's latest non-COMMENTED review (approval supersedes earlier CR)", () => {
    expect(
      summarizeReviews([
        { state: "CHANGES_REQUESTED", submittedAt: "2026-05-20T01:00:00Z", author: { login: "bob", __typename: "User" } },
        { state: "COMMENTED", submittedAt: "2026-05-20T02:00:00Z", author: { login: "bob", __typename: "User" } },
        { state: "APPROVED", submittedAt: "2026-05-20T03:00:00Z", author: { login: "bob", __typename: "User" } },
      ]),
    ).toEqual({ human_approval_count: 1, changes_requested_count: 0, bot_approval_count: 0 });
  });

  it("counts an outstanding changes-requested", () => {
    expect(
      summarizeReviews([
        { state: "APPROVED", submittedAt: "2026-05-20T01:00:00Z", author: { login: "alice", __typename: "User" } },
        { state: "CHANGES_REQUESTED", submittedAt: "2026-05-20T02:00:00Z", author: { login: "bob", __typename: "User" } },
      ]),
    ).toEqual({ human_approval_count: 1, changes_requested_count: 1, bot_approval_count: 0 });
  });

  it("handles empty / non-array input", () => {
    expect(summarizeReviews([])).toEqual({ human_approval_count: 0, changes_requested_count: 0, bot_approval_count: 0 });
    expect(summarizeReviews(undefined)).toEqual({ human_approval_count: 0, changes_requested_count: 0, bot_approval_count: 0 });
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

  it("captures conversation (non-thread) comments with the :eyes: ack flag", async () => {
    routeExec((_cmd, args) => {
      if (args.includes("graphql")) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: "abc",
                mergeStateStatus: "CLEAN",
                reviews: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      databaseId: 101,
                      body: "We should modify the spec and pull back from this behavior.",
                      createdAt: "2026-06-09T07:00:30Z",
                      url: "https://github.com/octo/march/pull/5#issuecomment-101",
                      author: { login: "reviewer", __typename: "User" },
                      reactionGroups: [{ content: "THUMBS_UP", viewerHasReacted: false }],
                    },
                    {
                      databaseId: 102,
                      body: "already handled",
                      createdAt: "2026-06-09T08:00:00Z",
                      url: "https://github.com/octo/march/pull/5#issuecomment-102",
                      author: { login: "reviewer", __typename: "User" },
                      reactionGroups: [{ content: "EYES", viewerHasReacted: true }],
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
              },
            },
          },
        });
      }
      return JSON.stringify({ number: 5, url: "u", state: "OPEN", mergeable: "MERGEABLE", headRefName: "b", title: "t", author: { login: "me" }, statusCheckRollup: [] });
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const pr = await io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } });
    expect(pr.conversation_comments).toEqual([
      { id: 101, author: "reviewer", author_type: "User", body_preview: "We should modify the spec and pull back from this behavior.", truncated: false, url: "https://github.com/octo/march/pull/5#issuecomment-101", created_at: "2026-06-09T07:00:30Z", reacted_eyes: false },
      { id: 102, author: "reviewer", author_type: "User", body_preview: "already handled", truncated: false, url: "https://github.com/octo/march/pull/5#issuecomment-102", created_at: "2026-06-09T08:00:00Z", reacted_eyes: true },
    ]);
    // No Codex review-summary comment on this PR → no review state to report.
    expect(pr.codex_review).toBeNull();
  });

  it("samples the NEWEST conversation comments (last:50) and flags an over-length body as truncated", async () => {
    const longBody = "x".repeat(400);
    let graphqlArgs: string[] = [];
    routeExec((_cmd, args) => {
      if (args.includes("graphql")) {
        graphqlArgs = args;
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: "abc",
                mergeStateStatus: "CLEAN",
                reviews: { nodes: [] },
                comments: { nodes: [{ databaseId: 7, body: longBody, createdAt: "2026-06-09T09:00:00Z", url: "u7", author: { login: "rev", __typename: "User" }, reactionGroups: [] }] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        });
      }
      return JSON.stringify({ number: 5, url: "u", state: "OPEN", mergeable: "MERGEABLE", headRefName: "b", title: "t", author: { login: "me" }, statusCheckRollup: [] });
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const pr = await io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } });
    // The graphql query asks for the newest page, not the oldest.
    expect(graphqlArgs.some((a) => a.includes("comments(last: 50)"))).toBe(true);
    expect(pr.conversation_comments[0]).toMatchObject({ id: 7, truncated: true, url: "u7" });
    expect(pr.conversation_comments[0].body_preview).toHaveLength(280);
  });

  describe("review pagination", () => {
    const review = (state: string, at: string, oid: string, login: string, type = "User") =>
      ({ state, submittedAt: at, commit: { oid }, author: { login, __typename: type } });
    const firstPage = (hasNextPage: boolean) => ({
      data: { repository: { pullRequest: {
        headRefOid: "head1",
        mergeStateStatus: "CLEAN",
        reviews: {
          pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : null },
          nodes: [review("COMMENTED", "2026-11-16T09:00:00Z", "head1", "someone")],
        },
        comments: { nodes: [] },
        reviewThreads: { nodes: [] },
      } } },
    });
    const secondPage = (headRefOid: string) => ({
      data: { repository: { pullRequest: {
        headRefOid,
        reviews: {
          pageInfo: { hasNextPage: false, endCursor: "c2" },
          nodes: [
            review("APPROVED", "2026-11-16T10:00:00Z", "head1", "coderabbitai", "Bot"),
            review("APPROVED", "2026-11-16T10:05:00Z", "head1", "alice"),
          ],
        },
      } } },
    });
    const prSummary = JSON.stringify({ number: 5, url: "u", state: "OPEN", mergeable: "MERGEABLE", headRefName: "b", title: "t", author: { login: "me" }, statusCheckRollup: [] });
    const query = (page2: () => string) => {
      const graphqlCalls: string[][] = [];
      routeExec((_cmd, args) => {
        if (!args.includes("graphql")) return prSummary;
        graphqlCalls.push(args);
        return args.some((a) => a === "cursor=c1") ? page2() : JSON.stringify(firstPage(true));
      });
      const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
      return { graphqlCalls, pr: io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } }) };
    };

    it("follows the review cursor so later pages count toward the gate evidence", async () => {
      const { graphqlCalls, pr } = query(() => JSON.stringify(secondPage("head1")));
      const result = await pr;
      expect(graphqlCalls).toHaveLength(2);
      // The ambient gh path bounds every review GraphQL call.
      const graphqlOpts = childProcessMock.execFile.mock.calls
        .filter((call: any[]) => (call[1] as string[]).includes("graphql"))
        .map((call: any[]) => call[2]);
      expect(graphqlOpts).toHaveLength(2);
      for (const opts of graphqlOpts) expect(opts).toMatchObject({ timeout: 30_000, killSignal: "SIGKILL" });
      expect(graphqlCalls[1].some((a) => a.includes("reviews(first: 100, after: $cursor)"))).toBe(true);
      expect(result.human_approval_count).toBe(1);
      expect(result.reviews_complete).toBe(true);
      expect(result.coderabbit).toMatchObject({ decision: "APPROVED", decision_commit_sha: "head1", decision_is_bot: true });
    });

    it("walks past five pages to reach a late verdict", async () => {
      let calls = 0;
      routeExec((_cmd, args) => {
        if (!args.includes("graphql")) return prSummary;
        calls++;
        const cursorArg = args.find((a) => a.startsWith("cursor="));
        if (!cursorArg) return JSON.stringify(firstPage(true));
        const n = Number(cursorArg.slice("cursor=c".length));
        if (n < 7) {
          return JSON.stringify({ data: { repository: { pullRequest: {
            headRefOid: "head1",
            reviews: { pageInfo: { hasNextPage: true, endCursor: `c${n + 1}` }, nodes: [] },
          } } } });
        }
        return JSON.stringify(secondPage("head1"));
      });
      const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
      const result = await io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } });
      expect(calls).toBe(8);
      expect(result.reviews_complete).toBe(true);
      expect(result.coderabbit?.decision_is_bot).toBe(true);
    });

    it("stops on a repeated cursor and marks the evidence incomplete", async () => {
      routeExec((_cmd, args) => {
        if (!args.includes("graphql")) return prSummary;
        if (!args.some((a) => a.startsWith("cursor="))) return JSON.stringify(firstPage(true));
        return JSON.stringify({ data: { repository: { pullRequest: {
          headRefOid: "head1",
          reviews: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] },
        } } } });
      });
      const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
      const result = await io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } });
      expect(result.reviews_complete).toBe(false);
    });

    it("withholds decision_is_bot when the head moves between pages", async () => {
      const { pr } = query(() => JSON.stringify(secondPage("head2")));
      const result = await pr;
      expect(result.coderabbit?.decision_is_bot).toBeUndefined();
    });

    it("withholds decision_is_bot when a follow-up page fails", async () => {
      const { pr } = query(() => { throw new Error("HTTP 502"); });
      const result = await pr;
      expect(result.head_sha).toBe("head1");
      expect(result.coderabbit?.decision_is_bot).toBeUndefined();
      expect(result.reviews_complete).toBe(false);
    });
  });

  it("reports CodeRabbit's standing for the re-review request", async () => {
    routeExec((_cmd, args) => {
      if (args.includes("graphql")) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: "d8e383e",
                mergeStateStatus: "BLOCKED",
                reviews: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    { state: "CHANGES_REQUESTED", submittedAt: "2026-11-16T09:37:00Z", commit: { oid: "441db76" }, author: { login: "coderabbitai", __typename: "Bot" } },
                  ],
                },
                comments: { nodes: [{ databaseId: 9, body: "@coderabbitai review", createdAt: "2026-11-16T09:29:00Z", url: "u9", author: { login: "me", __typename: "User" }, reactionGroups: [] }] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        });
      }
      return JSON.stringify({ number: 5, url: "u", state: "OPEN", mergeable: "MERGEABLE", headRefName: "b", title: "t", author: { login: "me" }, statusCheckRollup: [] });
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    const pr = await io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } });
    expect(pr.coderabbit).toEqual({
      decision: "CHANGES_REQUESTED",
      decision_commit_sha: "441db76",
      decision_is_bot: true,
      decision_at: "2026-11-16T09:37:00Z",
      last_review_commit_sha: "441db76",
      last_request_at: "2026-11-16T09:29:00Z",
      last_request_sha: null,
    });
    // A bot's CHANGES_REQUESTED is still not a human changes-requested gate.
    expect(pr.changes_requested_count).toBe(0);
  });

  describe("reviewer conversation comments", () => {
    const CODEX = { login: "chatgpt-codex-connector", __typename: "Bot" };
    const REVIEWER = { login: "reviewer", __typename: "User" };

    /** Codex's review-summary comment body: the two leading HTML comments (summary
     *  marker, then the `v1` state), then its human-readable status. */
    const codexSummary = (codeReview: Record<string, unknown>): string =>
      [
        "<!-- codex-pull-request-review-summary -->",
        `<!-- codex-review-state:v1 ${JSON.stringify({
          code_review: codeReview,
          security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
        })} -->`,
        "",
        "<details>",
        "<summary><strong>Codex Review Summary</strong>: ✅ Completed</summary>",
        "</details>",
      ].join("\n");
    const completed = (sha: string) => ({ commit_sha: sha, has_any_findings: false, has_unresolved_findings: false, status: "completed" });

    const comment = (id: number, author: unknown, body: string) => ({
      databaseId: id,
      body,
      createdAt: "2026-11-15T18:53:24Z",
      url: `u${id}`,
      author,
      reactionGroups: [],
    });

    /** Sense PR #5 with the given conversation-comment nodes. */
    async function sensePr(commentNodes: unknown[], threadNodes: unknown[] = []): Promise<any> {
      routeExec((_cmd, args) => {
        if (args.includes("graphql")) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: "f277786",
                  mergeStateStatus: "CLEAN",
                  reviews: { nodes: [] },
                  comments: { nodes: commentNodes },
                  reviewThreads: { nodes: threadNodes },
                },
              },
            },
          });
        }
        return JSON.stringify({ number: 5, url: "u", state: "OPEN", mergeable: "MERGEABLE", headRefName: "b", title: "t", author: { login: "me" }, statusCheckRollup: [] });
      });
      const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
      return io.queryPrForBabysit({ pr: { number: 5 } }, { repo: { path: "/repo", owner_with_name: "octo/march" } });
    }

    it("drops it from conversation_comments and surfaces its state as codex_review", async () => {
      const pr = await sensePr([
        comment(201, CODEX, codexSummary(completed("f277786"))),
        comment(202, REVIEWER, "please reconsider the spec"),
        // A real finding Codex posts as a comment carries no summary marker → kept.
        comment(203, CODEX, "Codex found an issue: the retry budget is never reset."),
      ]);
      expect(pr.conversation_comments.map((c: any) => c.id)).toEqual([202, 203]);
      expect(pr.codex_review).toEqual({ commit_sha: "f277786", status: "completed", has_unresolved_findings: false });
    });

    it("matches on the marker for the drop, but reads state only from a bot-authored summary", async () => {
      // A commenter pasting the markers cannot forge the per-commit review signal:
      // their comment is dropped like any summary, and Codex's own state stands.
      const forged = await sensePr([
        comment(201, CODEX, codexSummary({ commit_sha: "f277786", has_any_findings: true, has_unresolved_findings: true, status: "completed" })),
        comment(202, REVIEWER, codexSummary(completed("f277786"))),
        comment(203, { login: "other[bot]", __typename: "Bot" }, codexSummary(completed("f277786"))),
      ]);
      expect(forged.conversation_comments).toEqual([]);
      expect(forged.codex_review).toEqual({ commit_sha: "f277786", status: "completed", has_unresolved_findings: true });

      // With no bot-authored summary at all there is no state to trust.
      const humanOnly = await sensePr([comment(202, REVIEWER, codexSummary(completed("f277786")))]);
      expect(humanOnly.conversation_comments).toEqual([]);
      expect(humanOnly.codex_review).toBeNull();
    });

    it("keeps reviewer chatter out of fix and merge decisions while retaining human and inline feedback", async () => {
      // The sensed PR, fed through the real consumers of `conversation_comments`.
      const babysit = (pr: unknown): string[] => {
        const state: LoopState = {
          ts: "2026-11-15T19:00:00Z",
          statePresent: true,
          stateError: null,
          raw: { slices: {}, repo: { default_branch: "main" } },
          slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 }, pr_open_at: "2026-11-15T18:00:00Z" } },
          archived: {},
          repoPath: "/repo",
          workerGroup: "legate-workers",
          sessions: [{ id: "w", group: "legate-workers", status: "idle" }],
          sessionsById: new Map(),
          workers: { waiting: 0, running: 0, idle: 1, error: 0, stopped: 0, other: 0 },
          smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
          perSlice: { s: { recentOutput: { output: "" }, pr } },
        };
        return assess(state).map((d) => d.kind);
      };

      const rabbit = { login: "coderabbitai[bot]", __typename: "Bot" };
      const marker = "<!-- coderabbit-ai-generated:v1 -->";
      const progress = "> Currently processing new changes in this PR.";
      const rateLimit = "> ## Rate limit exceeded\n> Please wait **6 minutes and 43 seconds**.";
      const pause = "> ## Reviews paused";
      const chatter = [
        comment(201, CODEX, codexSummary(completed("f277786"))),
        comment(202, rabbit, marker + "\nWalkthrough"),
        comment(203, rabbit, marker + "\n" + " ".repeat(300) + "\n" + progress),
        comment(204, rabbit, marker + "\n" + rateLimit),
        comment(205, rabbit, marker + "\n" + pause),
        comment(206, REVIEWER, "[march-bot] @coderabbitai review"),
        comment(207, REVIEWER, marker + "\n" + progress),
        comment(208, { login: "unrelated[bot]", __typename: "Bot" }, marker + "\n" + rateLimit),
        comment(209, { login: "coderabbitai", __typename: "User" }, marker + "\n" + pause),
      ];
      const statusOnly = await sensePr(chatter);
      expect(statusOnly.conversation_comments).toEqual([]);
      const created_at = chatter[0].createdAt;
      expect(statusOnly.reviewer_notices).toEqual([
        { reviewer: "codex", kind: "status", created_at },
        { reviewer: "coderabbit", kind: "status", created_at },
        { reviewer: "coderabbit", kind: "in_progress", created_at },
        { reviewer: "coderabbit", kind: "rate_limited", created_at, reset_at: "2026-11-15T19:00:07.000Z" },
        { reviewer: "coderabbit", kind: "paused", created_at },
      ]);
      expect(babysit(statusOnly)).not.toContain("comment-fix");
      expect(mergeBlocker({}, statusOnly)).toBe("none");

      const withFeedback = await sensePr([
        ...chatter,
        comment(210, REVIEWER, "Please reconsider the spec.\n" + marker + "\n[march-bot] @coderabbitai review"),
      ]);
      expect(withFeedback.conversation_comments.map((c: any) => c.id)).toEqual([210]);
      expect(babysit(withFeedback)).toContain("comment-fix");
      expect(mergeBlocker({}, withFeedback)).toBe("owes_comments");

      const withThread = await sensePr(chatter, [{
        isResolved: false,
        comments: { nodes: [{ ...comment(211, rabbit, marker + "\nFix this line"), path: "src/app.ts", line: 12 }] },
      }]);
      expect(withThread.unresolved_threads).toMatchObject([{ id: 211, needs_response: true }]);
      expect(mergeBlocker({}, withThread)).toBe("owes_review_threads");
    });
    it("drops CodeRabbit's generated comments and review-bot commands, but keeps a mid-comment mention", async () => {
      const CODERABBIT = { login: "coderabbitai", __typename: "Bot" };
      const rabbit = (rest: string) => `<!-- coderabbit-ai-generated:v1 -->\n\n${rest}`;
      const pr = await sensePr([
        comment(301, REVIEWER, "@coderabbitai review\n\n<!-- march-coderabbit-request:f277786 -->"),
        comment(302, CODERABBIT, rabbit("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")),
        comment(303, CODERABBIT, rabbit("<!-- This is an auto-generated reply by CodeRabbit -->\nReview triggered.")),
        comment(304, REVIEWER, "@codex review"),
        // Genuine feedback that mentions the bot further down is still feedback.
        comment(305, REVIEWER, "The cache key is wrong — @coderabbitai flagged it too."),
      ]);
      expect(pr.conversation_comments.map((c: any) => c.id)).toEqual([305]);
      expect(pr.coderabbit.last_request_sha).toBe("f277786");
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
  it("runs no PR query (no `gh pr view` / `gh pr list` fallback) on an owner mismatch", async () => {
    const prCalls: string[][] = [];
    routeExec((cmd, args) => {
      if (cmd === "git" && args.includes("remote.origin.url")) return "https://github.com/octo/march\n";
      if (cmd === "gh" && args[0] === "pr") prCalls.push(args);
      return "[]";
    });
    const state = { repo: { path: "/repo", owner_with_name: "other/march" } };
    const io = createSenseIo({
      meta: meta(),
      castra: fakeCastra({ sessionOutput: async () => "opened https://github.com/other/march/pull/9" }),
      warn: () => {},
    });
    expect(await io.queryPrForBabysit({ pr: { number: 9 } }, state)).toMatchObject({ skipped: true, reason: "repo_owner_mismatch" });
    expect(await io.discoverPrForSlice({ branch: "feature/x" }, state, "sess-1")).toBeNull();
    const ioNoUrl = createSenseIo({ meta: meta(), castra: fakeCastra(), warn: () => {} });
    expect(await ioNoUrl.discoverPrForSlice({ branch: "feature/x" }, state, "sess-1")).toBeNull();
    expect(prCalls).toEqual([]);
  });

  it("observes the origin repo, not gh's default remote, so observation matches Legate mutations", async () => {
    let repoViews = 0;
    const prArgs: string[][] = [];
    routeExec((cmd, args) => {
      if (cmd === "git" && args.includes("remote.origin.url")) return "git@github.com:octo/march.git\n";
      if (cmd === "gh" && args.includes("repo")) { repoViews++; return "upstream/march"; }
      if (cmd === "gh" && args.includes("pr")) {
        prArgs.push(args);
        return JSON.stringify({ number: 7, state: "OPEN", headRefName: "b", author: { login: "me" }, statusCheckRollup: [] });
      }
      if (args.includes("graphql")) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      return "";
    });
    const io = createSenseIo({ meta: meta(), castra: fakeCastra() });
    await io.queryPrForBabysit({ pr: { number: 7 } }, { repo: { path: "/repo" } });
    expect(repoViews).toBe(0);
    expect(prArgs[0]).toEqual(expect.arrayContaining(["-R", "octo/march"]));
  });

  it("refuses to observe when a configured owner_with_name disagrees with origin", async () => {
    const warnings: string[] = [];
    routeExec((cmd, args) => (cmd === "git" && args.includes("remote.origin.url") ? "https://github.com/octo/march\n" : ""));
    const io = createSenseIo({ meta: meta(), castra: fakeCastra(), warn: m => warnings.push(m) });
    expect(await io.listOpenPrs({ repo: { path: "/repo", owner_with_name: "other/march" } }))
      .toEqual({ error: "repo owner unavailable" });
    expect(warnings.join("\n")).toMatch(/repo owner mismatch/);
  });

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
