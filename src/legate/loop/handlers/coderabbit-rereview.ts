import type { ReviewerBackoff, ReviewPostOutcome } from "./review-backoff.js";
import type { ReviewRequestRecord } from "../../../herald/events.js";
import { approvalSatisfied, changesRequestedSatisfied, resolveMergePolicyRow, normalizeBotLogin } from "../../../herald/profiles/merge-policy.js";
import { COPILOT_LOGIN, type ReviewerNotice } from "../../../observe/review-bot-comments.js";
import type { ReviewObservation } from "../../../observe/sense-io.js";
import { reviewRequestBody } from "../../../observe/coderabbit-review.js";
import { remainingReviewCap, type ReviewRequestLimits } from "../pure/review-budget.js";
import { mergeBlocker, taskTypeForSlice } from "../pure/slice.js";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";

export interface ReviewRequestHistory {
  byProfile: Record<string, ReviewRequestRecord[]>;
  backoff: ReviewerBackoff;
}

export interface ReviewRequestDeps {
  history: ReviewRequestHistory;
  limits: ReviewRequestLimits;
  copilot?: {
    backoff: ReviewerBackoff;
    request(repoPath: string, prNumber: number, sliceId: string): Promise<ReviewPostOutcome>;
  };
  now?: () => string;
  appendIntent(record: ReviewRequestRecord): Promise<unknown>;
  findTrigger(repoPath: string, prNumber: number, head: string, sliceId: string): Promise<string | undefined>;
  commentOnPr(repoPath: string, prNumber: number, body: string, sliceId: string): Promise<ReviewPostOutcome>;
}

type Outcome = "requested" | "failed" | "cap_exhausted" | "backoff" | "identity_unavailable";
type Reviewer = ReviewRequestRecord["reviewer"];

function exhaustedWindow(history: ReviewRequestHistory, reviewer: Reviewer, at: string, limits: ReviewRequestLimits) {
  const windows = reviewer === "coderabbit"
    ? [{ window: "day", limit: limits.dailyCap }] as const
    : [{ window: "day", limit: limits.copilotDailyCap }, { window: "month", limit: limits.copilotMonthlyCap }] as const;
  return windows.find(({ window, limit }) => remainingReviewCap(history.byProfile, reviewer, window, limit, at) === 0)?.window;
}

export async function apply(ctx: HandlerContext, state: LoopState, deps?: ReviewRequestDeps): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!deps || !state.repoPath) return res;
  await applyReviewer(ctx, state, state.repoPath, deps, "coderabbit", deps.history.backoff, res,
    (repoPath, prNumber, sliceId, head) => deps.commentOnPr(repoPath, prNumber, reviewRequestBody(head), sliceId));
  if (deps.copilot) {
    await applyReviewer(ctx, state, state.repoPath, deps, "copilot", deps.copilot.backoff, res, deps.copilot.request);
  }
  return res;
}

async function applyReviewer(
  ctx: HandlerContext, state: LoopState, repoPath: string, deps: ReviewRequestDeps,
  reviewer: Reviewer, backoff: ReviewerBackoff, res: HandlerResult,
  post: (repoPath: string, prNumber: number, sliceId: string, head: string) => Promise<ReviewPostOutcome>,
): Promise<void> {
  const profile = ctx.meta.profile;
  const records = deps.history.byProfile[profile] ??= [];
  const { waitMs } = deps.limits;
  const isCodeRabbit = reviewer === "coderabbit";
  const name = isCodeRabbit ? "CodeRabbit" : "Copilot";
  const login = isCodeRabbit ? "coderabbitai" : COPILOT_LOGIN;
  for (const [sliceId, slice] of Object.entries(state.slices)) {
    const taskType = taskTypeForSlice(sliceId, slice);
    if (!taskType || slice.stage !== "pr-open" || (isCodeRabbit && taskType !== "forge")) continue;
    const { reviewers, requirements } = resolveMergePolicyRow(state.mergePolicy, taskType);
    if (!reviewers.some((entry) => entry.id === reviewer && (entry.id === "copilot" || entry.mode === "comment-trigger"))) continue;
    const pr = state.perSlice?.[sliceId]?.pr ?? slice.pr;
    if (!pr || pr.error || pr.skipped || pr.state !== "OPEN" || pr.is_draft !== false || pr.checks !== "PASS" ||
        pr.reviews_complete !== true || (isCodeRabbit ? pr.coderabbit === undefined : !Array.isArray(pr.reviews)) ||
        !Number.isSafeInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/i.test(pr.head_sha ?? "")) continue;

    const now = Date.parse(deps.now?.() ?? ctx.ts);
    if (!Number.isFinite(now)) continue;
    const head = pr.head_sha.toLowerCase();
    const copilotReview = isCodeRabbit ? undefined : pr.reviews.find((review: ReviewObservation) =>
      review.author_kind === "bot" && normalizeBotLogin(review.login) === COPILOT_LOGIN);
    // Older snapshots lack the per-head history. A verdict on an older
    // commit can hide a newer COMMENTED review until Herald refreshes the PR.
    if (copilotReview && !pr.copilot_review_times && copilotReview.commit_sha?.toLowerCase() !== head) continue;
    const standing = isCodeRabbit ? pr.coderabbit : {
      decision: copilotReview?.state,
      decision_commit_sha: copilotReview?.commit_sha,
      decision_is_bot: !!copilotReview,
      review_times_by_head: pr.copilot_review_times ?? (copilotReview?.commit_sha
        ? { [copilotReview.commit_sha.toLowerCase()]: copilotReview.submitted_at } : {}),
    };
    // Copilot emits COMMENTED reviews as well as formal verdicts. A submitted
    // review on the current head answers the request in either case.
    if (!isCodeRabbit && (standing.review_times_by_head[head] || standing.decision === "COMMENTED" ||
        (!standing.decision && Object.keys(standing.review_times_by_head).length > 0))) continue;
    const verdictHead = standing?.decision_commit_sha?.toLowerCase();
    if (verdictHead === head && (standing.decision === "APPROVED" || standing.decision === "CHANGES_REQUESTED")) continue;

    const prior = records.filter((record) => record.pr === pr.number && record.reviewer === reviewer);
    const onHead = prior.filter((record) => record.headSha === head);
    const triggerTimes = standing?.trigger_times_by_head ?? {};
    const trigger = triggerTimes[head];
    const recent = (time: string) => now - Date.parse(time) < waitMs;
    if (onHead.some((record) => recent(record.at)) || (trigger && recent(trigger))) continue;
    const notices: ReviewerNotice[] = pr.reviewer_notices ?? [];
    if (notices.some((notice) => {
      if (notice.reviewer !== reviewer || notice.kind !== "in_progress" || !recent(notice.created_at)) return false;
      if (notice.head_sha) return notice.head_sha === head;
      const requestTimes = isCodeRabbit ? Object.entries(triggerTimes as Record<string, string>)
        : prior.map((record) => [record.headSha, record.at] as const);
      const preceding = requestTimes
        .filter(([, time]) => Date.parse(time) <= Date.parse(notice.created_at))
        .sort(([, left], [, right]) => Date.parse(right) - Date.parse(left))[0];
      return preceding ? preceding[0] === head : prior.every((record) => record.headSha === head) && (!verdictHead || verdictHead === head);
    })) continue;

    const newHead = prior.some((record) => record.headSha !== head) || !!(verdictHead && verdictHead !== head);
    const clear = pr.thread_count === 0 && pr.mergeable === "MERGEABLE" && pr.merge_state_status !== "dirty";
    if (newHead && !clear) continue;
    if (!newHead && !onHead.length && !trigger && standing?.review_times_by_head?.[head]) continue;

    let reason: ReviewRequestRecord["reason"] = "initial";
    if (onHead.length || trigger) {
      reason = "timeout_retry";
    } else if (standing?.decision === "CHANGES_REQUESTED") {
      if (!verdictHead || !clear) continue;
      reason = "stale_changes_requested";
    } else if (standing?.decision === "APPROVED" || standing?.decision === "DISMISSED") {
      if (!clear || approvalSatisfied(requirements, pr) || !changesRequestedSatisfied(requirements, pr) ||
          mergeBlocker(slice, pr) !== "none" ||
          !(pr.merge_state_status === "clean" || (pr.merge_state_status === "blocked" && pr.review_decision === "REVIEW_REQUIRED")) ||
          !requirements.botApprovers.includes(login) || standing.decision_is_bot !== true) continue;
      reason = "stale_approval";
    }

    const report = (outcome: Outcome, detail: string, rateLimitHit?: boolean) => {
      // Back-off defers the request; it is not a failure.
      const deferred = outcome === "backoff";
      const action = outcome === "requested" ? "review-request" : deferred ? "review-request-deferred" : "review-request-failed";
      const entry = { action, sliceId, pr: { number: pr.number, url: pr.url }, detail, outcome, reason, rateLimitHit, reviewer, taskType };
      (outcome === "requested" || deferred ? res.actions : res.failures).push(entry);
    };
    if (backoff.blocked(now)) {
      report("backoff", `${name} is in back-off or awaiting outcome verification`);
      continue;
    }
    try {
      if (isCodeRabbit && reason === "timeout_retry") {
        const markedAt = trigger ?? await deps.findTrigger(repoPath, pr.number, head, sliceId);
        if (markedAt && (recent(markedAt) || Date.parse(standing?.review_times_by_head?.[head] ?? "") >= Date.parse(markedAt))) continue;
      }
      if (isCodeRabbit && reason === "initial" && newHead) {
        // A push supersedes an unanswered request. Only the latest superseded
        // request decides: an older head's late answer must not hide it. A
        // COMMENTED review can answer a trigger, but a thread reply from before it cannot.
        const latest = prior.filter((record) => record.headSha !== head)
          .reduce<ReviewRequestRecord | undefined>((best, record) => (!best || Date.parse(record.at) >= Date.parse(best.at) ? record : best), undefined);
        const reviewAt = latest && standing?.review_times_by_head?.[latest.headSha];
        if (latest && reviewAt) {
          const markedAt = triggerTimes[latest.headSha] ?? await deps.findTrigger(repoPath, pr.number, latest.headSha, sliceId);
          if (markedAt && Date.parse(reviewAt) >= Date.parse(markedAt)) continue;
        }
      }
    } catch (error) {
      report("failed", `Could not verify prior CodeRabbit trigger: ${String(error)}`);
      continue;
    }
    const decisionTime = Date.parse(deps.now?.() ?? ctx.ts);
    if (!Number.isFinite(decisionTime)) continue;
    const at = new Date(decisionTime).toISOString();
    const window = exhaustedWindow(deps.history, reviewer, at, deps.limits);
    if (window) {
      report("cap_exhausted", `${name} UTC ${window === "day" ? "daily" : "monthly"} cap exhausted`);
      continue;
    }

    const record = { sliceId, pr: pr.number, reviewer, headSha: head, at, reason } as const;
    try {
      await deps.appendIntent(record);
      records.push(record);
    } catch (error) {
      report("failed", isCodeRabbit ? `Could not record CodeRabbit intent: ${String(error)}` : "Could not record Copilot intent");
      continue;
    }
    let outcome: ReviewPostOutcome;
    try {
      outcome = await post(repoPath, pr.number, sliceId, head);
    } catch (error) {
      outcome = { ok: false, kind: "failed", detail: isCodeRabbit ? String(error) : "GitHub request failed" };
    }
    if (outcome.ok) {
      report("requested", `Requested ${name} review at ${head}`);
      continue;
    }
    if (outcome.kind === "identity_unavailable") {
      report("identity_unavailable", "Tessera user identity unavailable");
    } else if (outcome.kind === "failed") {
      report("failed", isCodeRabbit ? `Could not post CodeRabbit trigger: ${outcome.detail}` : "GitHub review request failed");
    }
    const signalAt = deps.now?.() ?? at;
    await backoff.record({
      profile, sliceId, pr: pr.number, at: signalAt,
      ...(outcome.kind === "rate_limited"
        ? { cause: "http_429", resetAt: outcome.resetAt }
        : { cause: "post_failed" }),
    }, Date.parse(signalAt), (_target, decision, detail, hit) => report(decision, detail, hit));
  }
}
