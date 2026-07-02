/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildPrListArgs,
  buildPrViewArgs,
  buildRepoInfoArgs,
  buildReviewThreadsArgs,
  createGhForgeAdapter,
  parsePullRequestListGhJson,
  parsePullRequestSummaryGhJson,
  parseRepoInfoGhJson,
  type StatioCommandRunner,
} from "./adapter.js";
import { StatioForgeError, StatioNotFoundError, StatioValidationError } from "./types.js";

function runnerReturning(stdout: string): StatioCommandRunner {
  return vi.fn(async () => stdout);
}

describe("statio gh forge adapter — repoInfo", () => {
  it("builds a single gh repo view read for owner and default branch", () => {
    expect(buildRepoInfoArgs()).toEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner,defaultBranchRef",
    ]);
  });

  it("returns owner and default branch from the same gh repo view result", async () => {
    const runCommand = runnerReturning(
      JSON.stringify({
        nameWithOwner: "Balexda/March",
        defaultBranchRef: { name: "main" },
      }),
    );
    const adapter = createGhForgeAdapter({
      cwd: "/repo",
      timeoutMs: 1234,
      runCommand,
    });

    await expect(adapter.repoInfo()).resolves.toEqual({
      owner: "Balexda/March",
      defaultBranch: "main",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("gh", buildRepoInfoArgs(), {
      cwd: "/repo",
      timeoutMs: 1234,
    });
  });

  it("wraps malformed gh output as forge_error", async () => {
    const adapter = createGhForgeAdapter({
      runCommand: runnerReturning(
        JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: {},
        }),
      ),
    });

    await expect(adapter.repoInfo()).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
    });
  });

  it("wraps gh failures as forge_error without leaking dependency details", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async () => {
      throw new Error("gh auth token secret failed");
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.repoInfo()).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh repo view failed while resolving repository metadata.",
    });
  });

  it("parses only the expected repo metadata shape", () => {
    expect(() => parseRepoInfoGhJson("not-json")).toThrow(StatioForgeError);
    expect(() => parseRepoInfoGhJson("[]")).toThrow(StatioForgeError);
  });

  it("normalizes a missing or empty owner to the owner-unavailable fallback", () => {
    expect(
      parseRepoInfoGhJson(JSON.stringify({ nameWithOwner: "", defaultBranchRef: { name: "main" } })),
    ).toEqual({ owner: "", defaultBranch: "main" });
    expect(
      parseRepoInfoGhJson(JSON.stringify({ defaultBranchRef: { name: "main" } })),
    ).toEqual({ owner: "", defaultBranch: "main" });
  });

  it("treats an unsplittable owner as owner-unavailable", async () => {
    const adapter = createGhForgeAdapter({
      runCommand: runnerReturning(
        JSON.stringify({
          nameWithOwner: "no-slash-here",
          defaultBranchRef: { name: "main" },
        }),
      ),
    });

    await expect(adapter.repoInfo()).resolves.toEqual({
      owner: "",
      defaultBranch: "main",
    });
  });
});

describe("statio gh forge adapter — listPrs", () => {
  it("builds bounded gh pr list args with author, state, and repository owner scoping", () => {
    expect(buildPrListArgs({ author: "@me", state: "open" }, "Balexda/March")).toEqual([
      "pr",
      "list",
      "--json",
      "number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt",
      "--author",
      "@me",
      "--state",
      "open",
      "-R",
      "Balexda/March",
    ]);
  });

  it("returns bounded list items for author plus state filters", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      return JSON.stringify([
        {
          number: 42,
          url: "https://github.com/Balexda/March/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefName: "feature/statio",
          title: "Add Statio",
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
          createdAt: "2026-05-26T00:00:00Z",
        },
      ]);
    });
    const adapter = createGhForgeAdapter({ cwd: "/repo", timeoutMs: 1234, runCommand });

    await expect(adapter.listPrs({ author: "@me", state: "open" })).resolves.toEqual([
      {
        number: 42,
        url: "https://github.com/Balexda/March/pull/42",
        state: "OPEN",
        mergeable: "MERGEABLE",
        headBranch: "feature/statio",
        title: "Add Statio",
        checks: "PASS",
        createdAt: "2026-05-26T00:00:00Z",
      },
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "gh",
      buildPrListArgs({ author: "@me", state: "open" }, "Balexda/March"),
      {
        cwd: undefined,
        timeoutMs: 1234,
      },
    );
  });

  it("returns bounded list items for head branch filters", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      return JSON.stringify([
        {
          number: 7,
          url: "https://github.com/Balexda/March/pull/7",
          state: "OPEN",
          headRefName: "feature/head-filter",
          title: "Head match",
          statusCheckRollup: [
            { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
          ],
          createdAt: "2026-05-27T00:00:00Z",
        },
      ]);
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.listPrs({ head: "feature/head-filter" })).resolves.toEqual([
      {
        number: 7,
        url: "https://github.com/Balexda/March/pull/7",
        state: "OPEN",
        headBranch: "feature/head-filter",
        title: "Head match",
        checks: "FAIL",
        createdAt: "2026-05-27T00:00:00Z",
      },
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "gh",
      buildPrListArgs({ head: "feature/head-filter" }, "Balexda/March"),
      {
        cwd: undefined,
        timeoutMs: 10_000,
      },
    );
  });

  it("returns an empty list for empty gh pr list output", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      return "[]";
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.listPrs({ author: "@me", state: "open" })).resolves.toEqual([]);
  });

  it("rejects invalid filters and malformed requests as validation errors", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async () => "[]");
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.listPrs({ state: "draft" as "open" })).rejects.toBeInstanceOf(
      StatioValidationError,
    );
    await expect(adapter.listPrs({ head: "" })).rejects.toBeInstanceOf(StatioValidationError);
    await expect(adapter.listPrs(null as unknown as {})).rejects.toBeInstanceOf(
      StatioValidationError,
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("wraps malformed gh pr list output as forge_error", async () => {
    expect(() => parsePullRequestListGhJson("not-json")).toThrow(StatioForgeError);
    expect(() => parsePullRequestListGhJson("{}")).toThrow(StatioForgeError);
    expect(() =>
      parsePullRequestListGhJson(JSON.stringify([{ number: 42, state: "OPEN" }])),
    ).toThrow(StatioForgeError);
  });

  it("falls back to the repo cwd when owner is unavailable", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({ nameWithOwner: "", defaultBranchRef: { name: "master" } });
      }
      return JSON.stringify([
        {
          number: 9,
          url: "https://github.com/Balexda/March/pull/9",
          state: "OPEN",
          mergeable: "UNKNOWN",
          headRefName: "branch",
          title: "Fallback",
          statusCheckRollup: [],
          createdAt: "2026-05-28T00:00:00Z",
        },
      ]);
    });
    const adapter = createGhForgeAdapter({ cwd: "/repo", timeoutMs: 100, runCommand });

    await expect(adapter.listPrs({ head: "branch" })).resolves.toHaveLength(1);
    expect(runCommand).toHaveBeenNthCalledWith(2, "gh", buildPrListArgs({ head: "branch" }), {
      cwd: "/repo",
      timeoutMs: 100,
    });
  });

  it("falls back to the repo cwd when owner resolution fails", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        throw new Error("gh repo view failed");
      }
      return "[]";
    });
    const adapter = createGhForgeAdapter({ cwd: "/repo", timeoutMs: 100, runCommand });

    await expect(adapter.listPrs({ author: "@me" })).resolves.toEqual([]);
    expect(runCommand).toHaveBeenNthCalledWith(2, "gh", buildPrListArgs({ author: "@me" }), {
      cwd: "/repo",
      timeoutMs: 100,
    });
  });

  it("wraps gh pr list failures as forge_error", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      throw new Error("gh auth token secret failed");
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.listPrs({ state: "all" })).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh pr list failed while listing pull requests.",
    });
  });
});

describe("statio gh forge adapter — getPr", () => {
  it("builds bounded gh pr view args with repository owner scoping", () => {
    expect(buildPrViewArgs(42, "Balexda/March")).toEqual([
      "pr",
      "view",
      "42",
      "--json",
      "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author",
      "-R",
      "Balexda/March",
    ]);
  });

  it("returns the documented PR summary with checks and unresolved threads", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
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
                            path: "src/a.ts",
                            line: 9,
                            author: { login: "reviewer" },
                            createdAt: "2026-05-26T00:00:00Z",
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
      return JSON.stringify({
        number: 42,
        url: "https://github.com/Balexda/March/pull/42",
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        headRefName: "feature/statio",
        title: "Add Statio",
        author: { login: "worker" },
        statusCheckRollup: [
          { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          {
            name: "lint",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/lint",
          },
        ],
      });
    });
    const adapter = createGhForgeAdapter({ cwd: "/repo", timeoutMs: 1234, runCommand });

    await expect(adapter.getPr(42)).resolves.toEqual({
      number: 42,
      url: "https://github.com/Balexda/March/pull/42",
      state: "OPEN",
      mergeable: "MERGEABLE",
      reviewDecision: "CHANGES_REQUESTED",
      headBranch: "feature/statio",
      title: "Add Statio",
      author: "worker",
      checks: "FAIL",
      failedChecks: [{ name: "lint", conclusion: "FAILURE", url: "https://ci/lint" }],
      unresolvedThreads: [
        {
          id: 11,
          path: "src/a.ts",
          line: 9,
          author: "reviewer",
          bodyPreview: "please fix",
          lastAuthor: "reviewer",
          lastCommentAt: "2026-05-26T00:00:00Z",
          commentCount: 1,
          commentIds: [11],
          needsResponse: true,
        },
      ],
      threadCount: 1,
      needsResponseCount: 1,
    });
    expect(runCommand).toHaveBeenNthCalledWith(2, "gh", buildPrViewArgs(42, "Balexda/March"), {
      cwd: undefined,
      timeoutMs: 1234,
    });
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      "gh",
      buildReviewThreadsArgs("Balexda/March", 42),
      { timeoutMs: 1234 },
    );
  });

  it("falls back to the repo cwd when owner is unavailable", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({ nameWithOwner: "", defaultBranchRef: { name: "master" } });
      }
      return JSON.stringify({
        number: 7,
        url: "https://github.com/Balexda/March/pull/7",
        state: "OPEN",
        mergeable: "UNKNOWN",
        headRefName: "branch",
        title: "Fallback",
        author: { login: "worker" },
        statusCheckRollup: [],
      });
    });
    const adapter = createGhForgeAdapter({ cwd: "/repo", timeoutMs: 100, runCommand });

    await expect(adapter.getPr(7)).resolves.toMatchObject({
      number: 7,
      checks: "NONE",
      unresolvedThreads: [],
    });
    expect(runCommand).toHaveBeenNthCalledWith(2, "gh", buildPrViewArgs(7), {
      cwd: "/repo",
      timeoutMs: 100,
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("returns not_found when gh reports the PR is absent", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      throw new Error("no pull request found for branch");
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.getPr(404)).rejects.toMatchObject({
      name: "StatioNotFoundError",
      code: "not_found",
    });
    await expect(adapter.getPr(404)).rejects.toBeInstanceOf(StatioNotFoundError);
  });

  it("detects a not_found reported only on gh stderr", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      const err = new Error("Command failed: gh pr view 99");
      (err as Error & { stderr?: string }).stderr = "no pull request found for branch";
      throw err;
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.getPr(99)).rejects.toBeInstanceOf(StatioNotFoundError);
  });

  it("rejects a non-positive or non-integer PR number as a validation error", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async () => "");
    const adapter = createGhForgeAdapter({ runCommand });

    for (const bad of [0, -1, 1.5]) {
      await expect(adapter.getPr(bad)).rejects.toBeInstanceOf(StatioValidationError);
    }
    // The forge is never reached for a malformed argument.
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("wraps malformed gh pr view output as forge_error", async () => {
    expect(() => parsePullRequestSummaryGhJson("not-json")).toThrow(StatioForgeError);
    expect(() => parsePullRequestSummaryGhJson(JSON.stringify({ number: 2 }))).toThrow(
      StatioForgeError,
    );
  });

  it("wraps gh failures and review-thread failures as forge_error", async () => {
    const prFailure: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      throw new Error("gh auth token secret failed");
    });
    await expect(createGhForgeAdapter({ runCommand: prFailure }).getPr(12)).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh pr view failed while reading pull request state.",
    });

    const graphqlFailure: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      if (args.includes("graphql")) {
        throw new Error("rate limit");
      }
      return JSON.stringify({
        number: 12,
        url: "u",
        state: "OPEN",
        mergeable: "UNKNOWN",
        headRefName: "branch",
        title: "Title",
        author: { login: "worker" },
        statusCheckRollup: [],
      });
    });
    await expect(
      createGhForgeAdapter({ runCommand: graphqlFailure }).getPr(12),
    ).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh api graphql failed while reading review threads.",
    });
  });
});

describe("statio gh forge adapter — reviewThreads", () => {
  it("returns only unresolved threads in first-comment shape with ordered comment ids", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    comments: {
                      nodes: [
                        {
                          databaseId: 999,
                          body: "resolved",
                          createdAt: "2026-05-26T00:00:00Z",
                        },
                      ],
                    },
                  },
                  {
                    isResolved: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: 22,
                          body: "follow-up",
                          path: "src/later.ts",
                          line: 12,
                          author: { login: "second-reviewer" },
                          createdAt: "2026-05-26T00:02:00Z",
                        },
                        {
                          databaseId: 11,
                          body: "please fix this ordering-sensitive comment",
                          path: "src/first.ts",
                          line: 7,
                          author: { login: "first-reviewer" },
                          createdAt: "2026-05-26T00:01:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });
    const adapter = createGhForgeAdapter({ timeoutMs: 1234, runCommand });

    await expect(adapter.reviewThreads(42)).resolves.toEqual([
      {
        id: 11,
        path: "src/first.ts",
        line: 7,
        author: "first-reviewer",
        bodyPreview: "please fix this ordering-sensitive comment",
        lastAuthor: "second-reviewer",
        lastCommentAt: "2026-05-26T00:02:00Z",
        commentCount: 2,
        commentIds: [11, 22],
      },
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "gh",
      buildReviewThreadsArgs("Balexda/March", 42),
      { timeoutMs: 1234 },
    );
  });

  it("bounds the body preview to the sense-io review-thread limit", async () => {
    const longBody = "x".repeat(200);
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
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
                          databaseId: 1,
                          body: longBody,
                          author: { login: "reviewer" },
                          createdAt: "2026-05-26T00:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });
    const adapter = createGhForgeAdapter({ runCommand });

    const threads = await adapter.reviewThreads(42);

    expect(threads[0]?.bodyPreview).toBe("x".repeat(140));
  });

  it("returns an empty list when repository owner is unavailable", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async () =>
      JSON.stringify({ nameWithOwner: "", defaultBranchRef: { name: "master" } }),
    );
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.reviewThreads(42)).resolves.toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("propagates a repo-resolution failure as forge_error, not an empty list", async () => {
    const ghFailed: StatioCommandRunner = vi.fn(async () => {
      throw new Error("gh: not authenticated");
    });
    const unparseableMetadata: StatioCommandRunner = vi.fn(async () => "not-json");

    await expect(
      createGhForgeAdapter({ runCommand: ghFailed }).reviewThreads(42),
    ).rejects.toMatchObject({ name: "StatioForgeError", code: "forge_error" });
    await expect(
      createGhForgeAdapter({ runCommand: unparseableMetadata }).reviewThreads(42),
    ).rejects.toMatchObject({ name: "StatioForgeError", code: "forge_error" });
    // The GraphQL read is never reached — only repo resolution ran.
    expect(ghFailed).toHaveBeenCalledTimes(1);
    expect(unparseableMetadata).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive or non-integer PR number as a validation error", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async () => "");
    const adapter = createGhForgeAdapter({ runCommand });

    for (const bad of [0, -1, 1.5]) {
      await expect(adapter.reviewThreads(bad)).rejects.toBeInstanceOf(StatioValidationError);
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("wraps malformed GraphQL output as forge_error", async () => {
    const malformedShape: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      return JSON.stringify({ data: { repository: { pullRequest: {} } } });
    });
    const unparseableJson: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      return "not-json";
    });

    await expect(
      createGhForgeAdapter({ runCommand: malformedShape }).reviewThreads(42),
    ).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh api graphql failed while reading review threads.",
    });
    await expect(
      createGhForgeAdapter({ runCommand: unparseableJson }).reviewThreads(42),
    ).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh api graphql failed while reading review threads.",
    });
  });

  it("wraps failed GraphQL reads as forge_error", async () => {
    const runCommand: StatioCommandRunner = vi.fn(async (_command, args) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "Balexda/March",
          defaultBranchRef: { name: "master" },
        });
      }
      throw new Error("rate limit");
    });
    const adapter = createGhForgeAdapter({ runCommand });

    await expect(adapter.reviewThreads(42)).rejects.toMatchObject({
      name: "StatioForgeError",
      code: "forge_error",
      message: "gh api graphql failed while reading review threads.",
    });
  });
});
