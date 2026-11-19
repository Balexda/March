/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { CODERABBIT_REVIEW_COMMAND, isCodeRabbitReviewRequest, reviewRequestBody, summarizeCodeRabbit } from "./coderabbit-review.js";

const review = (state: string, oid: string, at: string, login = "coderabbitai") => ({
  state,
  submittedAt: at,
  commit: { oid },
  author: { login, __typename: "Bot" },
});
const comment = (body: string, at: string) => ({ body, createdAt: at });

describe("summarizeCodeRabbit", () => {
  it("is null when CodeRabbit neither reviewed nor was asked to", () => {
    expect(summarizeCodeRabbit([review("APPROVED", "a", "2026-11-16T09:00:00Z", "reviewer")], [])).toBeNull();
    expect(summarizeCodeRabbit(undefined, undefined)).toBeNull();
  });

  it("withholds merge evidence for an incomplete review list", () => {
    const standing = summarizeCodeRabbit([review("APPROVED", "a", "2026-11-16T09:00:00Z")], [], false);
    expect(standing?.decision).toBe("APPROVED");
    expect(standing?.decision_is_bot).toBeUndefined();
  });

  it("takes the latest decisive review and skips COMMENTED ones (thread replies)", () => {
    // As on Balexda/March#561: CHANGES_REQUESTED on the old head, then a thread
    // reply filed as a COMMENTED review on the new head.
    const standing = summarizeCodeRabbit(
      [review("CHANGES_REQUESTED", "b1661ea", "2026-11-16T09:41:00Z"), review("COMMENTED", "24db731", "2026-11-16T15:25:00Z")],
      [],
    );
    expect(standing).toEqual({
      decision: "CHANGES_REQUESTED",
      decision_commit_sha: "b1661ea",
      decision_is_bot: true,
      decision_at: "2026-11-16T09:41:00Z",
      last_review_commit_sha: "24db731",
      last_request_at: null,
      last_request_sha: null,
    });
    const approved = summarizeCodeRabbit(
      [review("CHANGES_REQUESTED", "a", "2026-11-16T09:00:00Z"), review("APPROVED", "b", "2026-11-16T10:00:00Z")],
      [],
    );
    expect(approved?.decision).toBe("APPROVED");
    expect(approved?.decision_commit_sha).toBe("b");
  });

  it("reports the newest review request by anyone, ignoring other mentions", () => {
    const standing = summarizeCodeRabbit(
      [],
      [
        comment("@coderabbitai review", "2026-11-16T09:30:00Z"),
        comment("@coderabbitai full review", "2026-11-16T11:00:00Z"),
        comment("@coderabbitai resolve", "2026-11-16T12:00:00Z"),
        comment("thanks @coderabbitai review again later", "2026-11-16T13:00:00Z"),
      ],
    );
    expect(standing).toEqual({ decision: null, decision_commit_sha: null, decision_at: null, last_review_commit_sha: null, last_request_at: "2026-11-16T11:00:00Z", last_request_sha: null });
  });

  it("reports the head named by the newest marked request; unmarked requests name none", () => {
    const standing = summarizeCodeRabbit(
      [],
      [
        comment(reviewRequestBody("441db76000"), "2026-11-16T09:30:00Z"),
        comment(reviewRequestBody("d8e383e000"), "2026-11-16T10:00:00Z"),
        comment("@coderabbitai review", "2026-11-16T11:00:00Z"),
      ],
    );
    expect(standing?.last_request_sha).toBe("d8e383e000");
    expect(standing?.last_request_at).toBe("2026-11-16T11:00:00Z");
  });

  it("preserves per-head raw review and marked trigger times from GitHub", () => {
    const head = "a".repeat(40);
    const old = "b".repeat(40);
    const trigger = "2026-11-16T09:30:00Z";
    const answer = "2026-11-16T09:31:00Z";
    const standing = summarizeCodeRabbit(
      [review("CHANGES_REQUESTED", old, trigger), review("COMMENTED", head, answer)],
      [comment(reviewRequestBody(head), answer), comment(reviewRequestBody(head), trigger)],
    );
    expect(standing?.decision_commit_sha).toBe(old);
    expect(standing?.review_times_by_head).toEqual({ [head]: answer, [old]: trigger });
    expect(standing?.trigger_times_by_head).toEqual({ [head]: trigger });
  });

  it("reports a COMMENTED-only history as reviewed, with no decision", () => {
    expect(summarizeCodeRabbit([review("COMMENTED", "c0ffee", "2026-11-16T10:00:00Z")], [])).toEqual({
      decision: null,
      decision_commit_sha: null,
      decision_at: null,
      last_review_commit_sha: "c0ffee",
      last_request_at: null,
      last_request_sha: null,
    });
  });
});

describe("isCodeRabbitReviewRequest", () => {
  it("matches the review commands at the start of a comment only", () => {
    expect(isCodeRabbitReviewRequest("  @CodeRabbitAI review")).toBe(true);
    expect(isCodeRabbitReviewRequest("@coderabbitai full review")).toBe(true);
    expect(isCodeRabbitReviewRequest("@coderabbitai reviewer")).toBe(false);
    expect(isCodeRabbitReviewRequest("@coderabbitai summary")).toBe(false);
    expect(isCodeRabbitReviewRequest(null)).toBe(false);
    // The legate's own request: command first, marker after.
    expect(reviewRequestBody("abc1234")).toBe(`${CODERABBIT_REVIEW_COMMAND}\n\n<!-- march-coderabbit-request:abc1234 -->`);
    expect(isCodeRabbitReviewRequest(reviewRequestBody("abc1234"))).toBe(true);
  });
});
