/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import type { ReviewObservation } from "../../observe/sense-io.js";
import type { MultiProfileState, ReviewRequestRecord } from "../events.js";
import { resolveMergePolicyRow } from "./merge-policy.js";
import { deriveReviewState, type ReviewSnapshot } from "./review-state.js";

const now = new Date("2026-11-19T12:00:00Z");
const recent = "2026-11-19T11:45:00Z";
const expired = "2026-11-19T11:30:00Z";
const head = "a".repeat(40);
const oldHead = "b".repeat(40);
const pr = { number: 42, head_sha: head };
const policy = {
  ...resolveMergePolicyRow({ reviewRequests: { byTaskType: {
    forge: { reviewers: [{ id: "coderabbit" }, { id: "copilot" }] },
  } } }, "forge"),
  selfLogin: "march-bot",
  waitMs: 30 * 60_000,
};
const request: ReviewRequestRecord = {
  sliceId: "slice-forge", pr: pr.number, headSha: head, reviewer: "coderabbit", at: recent, reason: "initial",
};
const backoffs: NonNullable<MultiProfileState["reviewBackoffs"]> = {
  coderabbit: { reviewer: "coderabbit", until: "2026-11-19T12:15:00Z", attempts: 1, cause: "http_429", seq: 1, ts: recent },
};
const notice = { kind: "in_progress", reviewer: "coderabbit", head_sha: head, created_at: recent } as const;
const approval: ReviewObservation = {
  login: "CodeRabbitAI[bot]", author_kind: "bot", state: "APPROVED", commit_sha: head, submitted_at: recent,
};

function derive(snapshot: ReviewSnapshot = pr, ledger: ReviewRequestRecord[] = [], backoff?: MultiProfileState["reviewBackoffs"]) {
  return deriveReviewState(snapshot, ledger, backoff, policy, now);
}

describe("deriveReviewState", () => {
  it("uses the first of all six states whose conditions are met", () => {
    const progress = { ...pr, reviewer_notices: [notice] };
    const approved = { ...progress, reviews: [approval] };
    const blocker = { ...approval, state: "CHANGES_REQUESTED", commit_sha: oldHead } as const;
    expect(derive()).toBe("none");
    expect(derive(pr, [request])).toBe("requested");
    expect(derive(progress, [request])).toBe("in_progress");
    expect(derive(progress, [request], backoffs)).toBe("rate_limited");
    expect(derive(approved, [request], backoffs)).toBe("approved_by_bot");
    expect(derive({ ...approved, reviews: [approval, { ...blocker, login: "alice", author_kind: "human" }] }, [request], backoffs)).toBe("changes_requested");
    expect(derive({ ...progress, reviews: [blocker] }, [request], backoffs)).toBe("changes_requested");
    expect(derive({ ...approved, head_sha: null, reviews: [blocker] }, [request], backoffs)).toBe("none");
  });

  it("ignores stale approvals, requests and notices, and expires waits and back-off at the deadline", () => {
    expect(derive({
      ...pr,
      reviews: [{ ...approval, commit_sha: oldHead }],
      reviewer_notices: [{ ...notice, head_sha: oldHead }, { ...notice, created_at: expired }],
    }, [{ ...request, headSha: oldHead }, { ...request, at: expired }, { ...request, pr: 99 }], {
      coderabbit: { ...backoffs.coderabbit!, until: now.toISOString() },
    })).toBe("none");
    expect(derive({ ...pr, reviews: [approval], reviews_complete: false })).toBe("none");
  });

  it("attributes a SHA-less notice only when its trigger or other head evidence supports it", () => {
    const snapshot = { ...pr, reviewer_notices: [{ ...notice, head_sha: undefined }] };
    expect(derive(snapshot, [request])).toBe("in_progress");
    expect(derive(snapshot, [{ ...request, headSha: oldHead }])).toBe("none");
    const standing = {
      decision: null, decision_commit_sha: null, decision_at: null,
      last_review_commit_sha: null, last_request_at: null, last_request_sha: null,
      trigger_times_by_head: { [oldHead]: expired, [head]: now.toISOString() },
    };
    expect(derive({ ...snapshot, coderabbit: standing }, [request])).toBe("requested");
  });

  it("requires an allowlisted bot for approval and a configured reviewer for back-off", () => {
    const lookalike = { ...approval, author_kind: "human" } as const;
    const copilot = { ...approval, login: "copilot-pull-request-reviewer[bot]" };
    expect(derive({ ...pr, reviews: [lookalike, copilot, { ...approval, login: "march-bot" }] })).toBe("none");
    expect(derive({ ...pr, reviews: [{ ...copilot, state: "CHANGES_REQUESTED" }] })).toBe("none");
    expect(derive({ ...pr, reviews: [lookalike] }, [], backoffs)).toBe("rate_limited");
    expect(derive({ ...pr, reviews: [{ ...approval, state: "COMMENTED" }] }, [], backoffs)).toBe("none");
    expect(deriveReviewState(pr, [request], backoffs, { ...policy, reviewers: [{ id: "copilot" }] }, now)).toBe("requested");
  });
});
