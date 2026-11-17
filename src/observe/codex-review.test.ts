/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { CODEX_REVIEW_SUMMARY_MARKER, isCodexReviewSummary, parseCodexReviewState } from "./codex-review.js";

/** The state marker's payload, in the shape Codex writes it. */
function reviewState(codeReview: Record<string, unknown>): Record<string, unknown> {
  return {
    code_review: codeReview,
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  };
}

/** A Codex review-summary comment body, as observed on a real pull request: the two
 *  leading HTML comments, then the human-readable status table. */
function summaryBody(state: unknown, stateMarker = "codex-review-state:v1"): string {
  return [
    "<!-- codex-pull-request-review-summary -->",
    `<!-- ${stateMarker} ${typeof state === "string" ? state : JSON.stringify(state)} -->`,
    "",
    "<details>",
    "<summary><strong>Codex Review Summary</strong>: ✅ Completed</summary>",
    "",
    "This comment shows the latest Codex review activity on this pull request.",
    "",
    "| Review | Status | Commit | Review trigger |",
    "| --- | --- | --- | --- |",
    "| 📝 **Code Review** | ✅ **Completed** | `f277786` | PR opened |",
    "",
    "</details>",
  ].join("\n");
}

const COMPLETED = reviewState({
  commit_sha: "f27778624fec227c86013cabef7b7bcc9d5a27bf",
  has_any_findings: false,
  has_unresolved_findings: false,
  status: "completed",
});

describe("isCodexReviewSummary", () => {
  it("exposes the stable summary marker", () => {
    expect(CODEX_REVIEW_SUMMARY_MARKER).toBe("<!-- codex-pull-request-review-summary -->");
  });

  it("recognizes Codex's review-summary comment by its leading marker", () => {
    expect(isCodexReviewSummary(summaryBody(COMPLETED))).toBe(true);
    // Recognition needs only the summary marker — not a readable state after it.
    expect(isCodexReviewSummary("<!-- codex-pull-request-review-summary -->\nReview running…")).toBe(true);
  });

  it("tolerates incidental leading whitespace before the marker", () => {
    expect(isCodexReviewSummary(`\n  ${summaryBody(COMPLETED)}`)).toBe(true);
  });

  it("does not match ordinary feedback, including findings Codex posts as a comment", () => {
    expect(isCodexReviewSummary("please reconsider the spec")).toBe(false);
    expect(isCodexReviewSummary("**Codex Review**: this change drops the retry budget — P1")).toBe(false);
  });

  it("does NOT match a comment that merely quotes or mentions the marker mid-body", () => {
    // The marker is a leading prefix, so a reviewer referring to the status comment
    // is still leaving genuine feedback and must be captured.
    expect(isCodexReviewSummary("why did the bot reply to `<!-- codex-pull-request-review-summary -->`?")).toBe(false);
    expect(isCodexReviewSummary(`> ${summaryBody(COMPLETED)}\n\nthis looks stuck`)).toBe(false);
  });

  it("is robust to a missing / non-string body", () => {
    expect(isCodexReviewSummary(undefined)).toBe(false);
    expect(isCodexReviewSummary(null)).toBe(false);
    expect(isCodexReviewSummary(123)).toBe(false);
    expect(isCodexReviewSummary("")).toBe(false);
  });
});

describe("parseCodexReviewState", () => {
  it("reads the reviewed commit, status, and unresolved-findings flag of a finished review", () => {
    expect(parseCodexReviewState(summaryBody(COMPLETED))).toEqual({
      commit_sha: "f27778624fec227c86013cabef7b7bcc9d5a27bf",
      status: "completed",
      has_unresolved_findings: false,
    });
  });

  it("reports unresolved findings", () => {
    const state = reviewState({ commit_sha: "abc123", has_any_findings: true, has_unresolved_findings: true, status: "completed" });
    expect(parseCodexReviewState(summaryBody(state))).toEqual({
      commit_sha: "abc123",
      status: "completed",
      has_unresolved_findings: true,
    });
  });

  it("passes Codex's status string through verbatim rather than interpreting it", () => {
    // Only "completed" has been observed; any other value is Codex's to define.
    const state = reviewState({ commit_sha: "abc123", has_any_findings: null, has_unresolved_findings: null, status: "in_progress" });
    expect(parseCodexReviewState(summaryBody(state))).toEqual({
      commit_sha: "abc123",
      status: "in_progress",
      has_unresolved_findings: null,
    });
  });

  it("maps values Codex has not reported (null / wrong type) to null", () => {
    const unreported = reviewState({ commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null });
    expect(parseCodexReviewState(summaryBody(unreported))).toEqual({
      commit_sha: null,
      status: null,
      has_unresolved_findings: null,
    });
    const mistyped = reviewState({ commit_sha: 42, has_unresolved_findings: "false", status: "" });
    expect(parseCodexReviewState(summaryBody(mistyped))).toEqual({
      commit_sha: null,
      status: null,
      has_unresolved_findings: null,
    });
  });

  it("returns null when the summary carries no readable v1 state", () => {
    // No state marker at all.
    expect(parseCodexReviewState("<!-- codex-pull-request-review-summary -->\nReview running…")).toBeNull();
    // A later schema version is not guessed at.
    expect(parseCodexReviewState(summaryBody(COMPLETED, "codex-review-state:v2"))).toBeNull();
    // Malformed JSON is swallowed, never thrown.
    expect(parseCodexReviewState(summaryBody('{"code_review": {'))).toBeNull();
    expect(parseCodexReviewState(summaryBody("{not json}"))).toBeNull();
    // No code-review block to read.
    expect(parseCodexReviewState(summaryBody({ security_review: {} }))).toBeNull();
    expect(parseCodexReviewState(summaryBody({ code_review: "completed" }))).toBeNull();
  });

  it("only reads state from the summary comment itself", () => {
    // A state marker quoted in some other comment is not Codex's review state.
    const stateLine = `<!-- codex-review-state:v1 ${JSON.stringify(COMPLETED)} -->`;
    expect(parseCodexReviewState(`looks done to me:\n${stateLine}`)).toBeNull();
    expect(parseCodexReviewState(undefined)).toBeNull();
  });

  it("needs the full body: the state marker outruns the 280-char body_preview", () => {
    // Why the state is parsed at sensing, not from the sensed comment's preview.
    const preview = summaryBody(COMPLETED).slice(0, 280);
    expect(isCodexReviewSummary(preview)).toBe(true);
    expect(parseCodexReviewState(preview)).toBeNull();
  });
});
