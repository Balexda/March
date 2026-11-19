import type { CodeRabbitStanding } from "../../observe/coderabbit-review.js";
import { reviewerIdForBot, type ReviewerNotice } from "../../observe/review-bot-comments.js";
import type { ReviewObservation } from "../../observe/sense-io.js";
import type { MultiProfileState, ReviewRequestRecord } from "../events.js";
import { normalizeBotLogin, type ResolvedMergeRequirements, type ReviewerConfig } from "./merge-policy.js";

export type ReviewState = "none" | "requested" | "in_progress" | "approved_by_bot" | "changes_requested" | "rate_limited";

export interface ReviewSnapshot {
  number: number;
  head_sha?: string | null;
  reviews?: readonly ReviewObservation[];
  reviews_complete?: boolean;
  reviewer_notices?: readonly ReviewerNotice[];
  coderabbit?: CodeRabbitStanding | null;
}

interface ReviewPolicy {
  requirements: ResolvedMergeRequirements;
  reviewers: readonly ReviewerConfig[];
  selfLogin: string;
  waitMs: number;
}

function noticeOnHead(
  notice: ReviewerNotice,
  head: string,
  requests: readonly ReviewRequestRecord[],
  standing: CodeRabbitStanding | null | undefined,
): boolean {
  if (notice.head_sha) return notice.head_sha.toLowerCase() === head;

  // As in the request handler, a marked CodeRabbit trigger preceding the notice
  // identifies its head. Without a marker, conflicting head evidence makes
  // attribution unsafe.
  const preceding = Object.entries(standing?.trigger_times_by_head ?? {})
    .filter(([, time]) => Date.parse(time) <= Date.parse(notice.created_at))
    .sort(([, left], [, right]) => Date.parse(right) - Date.parse(left))[0];
  const verdictHead = standing?.decision_commit_sha?.toLowerCase();
  return preceding ? preceding[0] === head
    : requests.every((record) => record.headSha === head) && (!verdictHead || verdictHead === head);
}

/** Derive the operator-facing state from one PR's evidence, in precedence order. */
export function deriveReviewState(
  pr: ReviewSnapshot,
  ledger: readonly ReviewRequestRecord[],
  backoffs: MultiProfileState["reviewBackoffs"],
  policy: ReviewPolicy,
  now: Date,
): ReviewState {
  const head = pr.head_sha?.toLowerCase();
  if (!head) return "none";

  const reviews = (pr.reviews ?? []).filter((review) => normalizeBotLogin(review.login) !== policy.selfLogin);
  const allowedBot = (review: ReviewObservation) => review.author_kind === "bot" &&
    policy.requirements.botApprovers.includes(normalizeBotLogin(review.login));
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED" &&
      (review.author_kind === "human" || allowedBot(review)))) return "changes_requested";

  const onHead = reviews.filter((review) => review.commit_sha?.toLowerCase() === head);
  if (pr.reviews_complete !== false && onHead.some((review) => review.state === "APPROVED" && allowedBot(review))) {
    return "approved_by_bot";
  }

  const nowMs = now.getTime();
  const reviewedBy = new Set(onHead.filter((review) => review.author_kind === "bot")
    .map((review) => reviewerIdForBot(normalizeBotLogin(review.login))));
  if (policy.reviewers.some(({ id }) => {
    const backoff = backoffs?.[id];
    return backoff && backoff.cause !== "reset" && Date.parse(backoff.until) > nowMs && !reviewedBy.has(id);
  })) return "rate_limited";

  const recent = (time: string) => {
    const age = nowMs - Date.parse(time);
    return age >= 0 && age < policy.waitMs;
  };
  const requests = ledger.filter((record) => record.pr === pr.number);
  if (pr.reviewer_notices?.some((notice) =>
    notice.kind === "in_progress" && recent(notice.created_at) &&
    noticeOnHead(notice, head, requests.filter((record) => record.reviewer === notice.reviewer),
      notice.reviewer === "coderabbit" ? pr.coderabbit : undefined),
  )) return "in_progress";

  return requests.some((record) => record.headSha === head && recent(record.at)) ? "requested" : "none";
}
