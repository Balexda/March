/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  buildSmithySpawnPrompt,
  ciFixMessage,
  commentFixMessage,
  commentsNeedingResponse,
  conflictMessage,
  failedChecksSummary,
  prDiscoverySince,
  reviewFixMessage,
  threadsNeedingResponse,
} from "./messages.js";

const item = { path: "docs/x.tasks.md", next_action: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"] } };

describe("messages pure builders", () => {
  it("spawn prompt carries the command line + artifact + checkbox rule", () => {
    const p = buildSmithySpawnPrompt(item);
    expect(p).toContain("/smithy.forge docs/x.tasks.md 1");
    expect(p).toContain("docs/x.tasks.md");
    expect(p).toContain("[ ]` to `[x]`");
  });

  it("conflictMessage targets the repo default branch + worktree", () => {
    const m = conflictMessage({ worktree_path: "/wt" }, { number: 9 }, { repo: { default_branch: "trunk" } });
    expect(m).toContain("origin/trunk");
    expect(m).toContain('cd "/wt"');
    expect(m).toContain("PR #9");
  });

  it("ciFixMessage rebases onto the default and lists the failed checks (#303)", () => {
    const m = ciFixMessage(
      { worktree_path: "/wt" },
      { number: 9, failed_checks: [{ name: "validate", url: "http://ci/1" }] },
      { repo: { default_branch: "trunk" } },
    );
    expect(m).toContain("/smithy.fix");
    expect(m).toContain("PR #9 has failing CI");
    expect(m).toContain("git rebase origin/trunk");
    expect(m).toContain('cd "/wt"');
    expect(m).toContain("- validate: http://ci/1");
  });

  it("threadsNeedingResponse honors needs_response and pr-open recency", () => {
    const slice = { stage: "pr-open", pr_open_at: "2026-01-01T00:00:00Z" };
    const pr = {
      unresolved_threads: [
        { needs_response: true },
        { needs_response: false, last_comment_at: "2026-02-01T00:00:00Z" }, // after open → needs
        { needs_response: false, last_comment_at: "2025-01-01T00:00:00Z" }, // before open → not
      ],
    };
    expect(threadsNeedingResponse(slice, pr)).toHaveLength(2);
  });

  it("failedChecksSummary + reviewFixMessage format lists", () => {
    expect(failedChecksSummary({ failed_checks: [{ name: "ci", url: "u" }] })).toBe("- ci: u");
    expect(failedChecksSummary({ failed_checks: [] })).toContain("No failed-check");
    expect(reviewFixMessage({ number: 3 }, [{ path: "a.ts", line: 4, author: "x", body_preview: "fix" }])).toContain(
      "- a.ts:4 by x: fix",
    );
  });

  it("commentsNeedingResponse returns only un-acknowledged conversation comments (author-independent)", () => {
    const pr = {
      conversation_comments: [
        { id: 1, author: "rev", reacted_eyes: false },
        { id: 2, author: "rev", reacted_eyes: true }, // already :eyes:'d → handled
        { id: 3, author: "steward", reacted_eyes: false }, // author NOT a filter
      ],
    };
    expect(commentsNeedingResponse({}, pr).map((c: any) => c.id)).toEqual([1, 3]);
    expect(commentsNeedingResponse({}, {})).toEqual([]);
  });

  it("commentsNeedingResponse skips March's own [march-bot] replies (#374, author-independent)", () => {
    const pr = {
      conversation_comments: [
        { id: 1, author: "rev", body_preview: "please reconsider the spec", reacted_eyes: false },
        { id: 2, author: "rev", body_preview: "[march-bot] Fixed in abc123: tightened the gate", reacted_eyes: false },
      ],
    };
    // The steward's own reply (same token as the reviewer) is dropped by the marker,
    // so it can never re-arm a comment-fix dispatch.
    expect(commentsNeedingResponse({}, pr).map((c: any) => c.id)).toEqual([1]);
  });

  it("commentFixMessage tells the steward to prefix its conversation reply with [march-bot]", () => {
    const m = commentFixMessage({ number: 12 }, [{ author: "rev", body_preview: "x", created_at: "2026-06-09T07:00:30Z" }]);
    expect(m).toContain("[march-bot]");
  });

  it("commentFixMessage drives /smithy.fix and blockquotes each comment body", () => {
    const m = commentFixMessage({ number: 12 }, [
      { author: "rev", body_preview: "line one\nline two", created_at: "2026-06-09T07:00:30Z" },
    ]);
    expect(m).toContain("/smithy.fix");
    expect(m).toContain("PR #12");
    expect(m).toContain("> line one\n> line two");
    expect(m).toContain("— rev (2026-06-09T07:00:30Z)");
  });

  it("conversationCommentsSummary appends the permalink and marks a truncated body", () => {
    const m = commentFixMessage({ number: 12 }, [
      { author: "rev", body_preview: "do the thing", truncated: true, url: "https://gh/c/1", created_at: "2026-06-09T07:00:30Z" },
    ]);
    expect(m).toContain("> do the thing…");
    expect(m).toContain("(full comment: https://gh/c/1)");
  });

  it("prDiscoverySince falls back through timestamp fields", () => {
    expect(prDiscoverySince({ created_at: "c" })).toBe("c");
    expect(prDiscoverySince({ last_action: "l", created_at: "c" })).toBe("l");
    expect(prDiscoverySince({})).toBe("");
  });
});
