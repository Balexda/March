import { describe, expect, it } from "vitest";
import {
  buildDirectStewardMessage,
  buildSmithyRecoverySpawnPrompt,
  buildSmithySpawnPrompt,
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

  it("recovery prompt references the prior merged PR and attempt", () => {
    const p = buildSmithyRecoverySpawnPrompt(item, { pr: { number: 42, url: "u" } }, 2);
    expect(p).toContain("RECOVERY DISPATCH (attempt 2)");
    expect(p).toContain("Prior merged PR: #42 (u)");
  });

  it("direct-steward message drops the prior-PR line when absent", () => {
    expect(buildDirectStewardMessage(item, null)).not.toContain("A prior PR");
    expect(buildDirectStewardMessage(item, { pr: { number: 7 } })).toContain("A prior PR (#7)");
  });

  it("conflictMessage targets the repo default branch + worktree", () => {
    const m = conflictMessage({ worktree_path: "/wt" }, { number: 9 }, { repo: { default_branch: "trunk" } });
    expect(m).toContain("origin/trunk");
    expect(m).toContain('cd "/wt"');
    expect(m).toContain("PR #9");
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

  it("prDiscoverySince falls back through timestamp fields", () => {
    expect(prDiscoverySince({ created_at: "c" })).toBe("c");
    expect(prDiscoverySince({ last_action: "l", created_at: "c" })).toBe("l");
    expect(prDiscoverySince({})).toBe("");
  });
});
