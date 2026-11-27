/**
 * @l1
 * @deterministic
 * @ci
 */
import { describe, expect, it, vi } from "vitest";
import { buildPullRequestMetadata, openOrReusePullRequest, PR_BODY_LIMIT, PR_TITLE_LIMIT } from "./pr-publisher.js";

const repository = "example/project";
const commit = {
  spawnId: "20260524-abcdef", branch: "006/us-04/slice-1", commitSha: "a".repeat(40),
  patchSha256: "b".repeat(64), committedAt: "2026-05-24T00:00:00Z",
};
const metadata = { title: "Review spawn", body: "## Summary\n\n## Validation" };
const pull = (number: number, base = "main", state = "open", source = repository, target = repository) => ({
  number, state, html_url: `https://github.com/${repository}/pull/${number}`,
  head: { ref: commit.branch, repo: { full_name: source } },
  base: { ref: base, repo: { full_name: target } },
});

function api(options: {
  open?: ReturnType<typeof pull>[];
  next?: ReturnType<typeof pull>[];
  defaultBranch?: string;
  branches?: string[];
  create?: () => Response | Promise<Response>;
  lookup?: () => Response;
} = {}) {
  const create = vi.fn(options.create ?? (() => Response.json(pull(1), { status: 201 })));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const prefix = `/repos/${repository}`;
    if (url.pathname === prefix + "/pulls") {
      if (init?.method === "POST") return create();
      expect(url.searchParams.get("head")).toBe("example:" + commit.branch);
      expect(url.searchParams.get("state")).toBe("open");
      const page = url.searchParams.get("page");
      if (page === "2") return Response.json(options.next);
      return options.lookup?.() ?? Response.json(options.open ?? [], options.next ? {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      } : undefined);
    }
    if (url.pathname === prefix) return Response.json({ default_branch: options.defaultBranch ?? "main" });
    const branches = options.branches ?? ["main"];
    const branch = decodeURIComponent(url.pathname.slice((prefix + "/branches/").length));
    return branches.includes(branch) ? Response.json({ name: branch }) : new Response(null, { status: 404 });
  });
  const token = vi.fn(async () => "isolated-test-token");
  const publish = (baseBranch?: string, review = vi.fn(async () => metadata)) =>
    openOrReusePullRequest({ repository, commit, baseBranch, metadata: review }, { token, fetch });
  return { create, fetch, publish, token };
}

describe("PR metadata", () => {
  it("bounds optional detail and retains traceability and unavailable verification", () => {
    const secret = "ghp_sensitive";
    const result = buildPullRequestMetadata({
      commit, backend: "codex " + secret, touchedPaths: [
        "src/file.ts", "secrets/" + secret, ...Array.from({ length: 2000 }, (_, i) => `src/path-${i}.ts`),
      ],
    });
    expect(result.title.length).toBeLessThanOrEqual(PR_TITLE_LIMIT);
    expect(result.body.length).toBeLessThanOrEqual(PR_BODY_LIMIT);
    for (const required of [commit.spawnId, "codex", commit.branch, "validated patch", "src/file.ts",
      "more path(s) omitted", "Verification results unavailable."]) {
      expect(result.body).toContain(required);
    }
    expect(result.body).toContain("[redacted]");
    expect(result.body).not.toContain(secret);
    expect(buildPullRequestMetadata({ commit, backend: "codex", touchedPaths: [], verification: "passed" }).body)
      .toContain("Steward verification passed.");
  });
});

describe("Steward PR publication", () => {
  it("creates for the exact pushed branch when only closed history exists", async () => {
    const upstream = api({ open: [pull(9, "main", "closed")], branches: ["release/1"],
      create: () => Response.json(pull(1, "release/1"), { status: 201 }) });
    await expect(upstream.publish("release/1")).resolves.toMatchObject({
      status: "succeeded", pullRequest: {
        provider: "github", repository, number: 1, url: `https://github.com/${repository}/pull/1`,
        headBranch: commit.branch, baseBranch: "release/1", state: "open", observedAt: expect.any(String),
      },
    });
    const post = upstream.fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ ...metadata, head: "example:" + commit.branch, base: "release/1" });
  });

  it("prefers a base match across pages and ignores foreign repositories and non-exact refs", async () => {
    const upstream = api({ open: [
      pull(8, "main", "open", "fork/project"), pull(9, "main", "open", repository, "other/project"),
      { ...pull(10), head: { ref: commit.branch + "-extra", repo: { full_name: repository } } },
      pull(11, "other"),
    ], next: [pull(12)] });
    const review = vi.fn(async () => metadata);
    await expect(upstream.publish(undefined, review)).resolves.toMatchObject({
      status: "succeeded", pullRequest: { number: 12, baseBranch: "main" },
    });
    expect(upstream.create).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("fails with the existing PR when only a different base matches", async () => {
    const upstream = api({ open: [pull(8, "other")] });
    await expect(upstream.publish("missing")).resolves.toMatchObject({
      status: "failed", failureReason: "base_mismatch", existingPullRequest: { number: 8, baseBranch: "other" },
    });
    expect(upstream.create).not.toHaveBeenCalled();
  });

  it.each([{ open: [] }, { open: [pull(8, "other")] }])("handles an unresolved base with or without a matching PR (%j)", async ({ open }) => {
    const upstream = api({ open, branches: [] });
    const result = await upstream.publish("missing");
    expect(result).toMatchObject({ status: "failed", failureReason: "base_unresolved", branch: commit.branch, commit });
    expect(result.status === "failed" && result.existingPullRequest?.number).toBe(open[0]?.number);
    expect(upstream.create).not.toHaveBeenCalled();
  });

  it.each(["concurrent", "ambiguous"])("reconciles a %s creation", async (mode) => {
    let created = false;
    const upstream = api({
      lookup: () => Response.json(created ? [pull(42)] : []),
      create: () => {
        created = true;
        if (mode === "ambiguous") throw new Error("connection lost after create");
        return new Response(null, { status: 422 });
      },
    });
    await expect(upstream.publish()).resolves.toMatchObject({ status: "succeeded", pullRequest: { number: 42 } });
    await expect(upstream.publish()).resolves.toMatchObject({ status: "succeeded", pullRequest: { number: 42 } });
    expect(upstream.create).toHaveBeenCalledTimes(1);
  });

  it.each([[401, "unauthorized"], [403, "forbidden"], [503, "network"], [422, "publication_failed"]])(
    "reports a redacted terminal failure for HTTP %i", async (status, failureReason) => {
      const upstream = api({ create: () => new Response("secret=ghp_sensitive", { status }) });
      const result = await upstream.publish();
      expect(result).toMatchObject({ status: "failed", failureReason, branch: commit.branch, commit });
      expect(JSON.stringify(result)).not.toContain("ghp_sensitive");
    },
  );

  it("does not create a PR when the Steward rejects the review", async () => {
    const upstream = api();
    const result = await openOrReusePullRequest({ repository, commit, metadata: async () => "review_failed" },
      { token: upstream.token, fetch: upstream.fetch });
    expect(result).toMatchObject({ status: "failed", failureReason: "review_failed" });
    expect(upstream.create).not.toHaveBeenCalled();
  });

  it("reports a timed-out GitHub create after checking whether it succeeded", async () => {
    const upstream = api({ create: () => { throw new DOMException("secret-token", "TimeoutError"); } });
    const result = await upstream.publish();
    expect(result).toMatchObject({ status: "failed", failureReason: "timeout", branch: commit.branch, commit });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(upstream.fetch.mock.calls.filter(([url, init]) =>
      init?.method === "GET" && String(url).includes("/pulls?"))).toHaveLength(3);
  });
});
