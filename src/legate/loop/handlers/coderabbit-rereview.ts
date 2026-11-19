import type { CodeRabbitBackoff, ReviewPostOutcome } from "./review-backoff.js";
import type { ReviewRequestRecord } from "../../../herald/events.js";
import { approvalSatisfied, changesRequestedSatisfied, resolveMergePolicyRow } from "../../../herald/profiles/merge-policy.js";
import { reviewRequestBody } from "../../../observe/coderabbit-review.js";
import type { ReviewerNotice } from "../../../observe/review-bot-comments.js";
import { remainingReviewCap, type ReviewRequestLimits } from "../pure/review-budget.js";
import { mergeBlocker, taskTypeForSlice } from "../pure/slice.js";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";

export interface ReviewRequestHistory {
  byProfile: Record<string, ReviewRequestRecord[]>;
  backoff: CodeRabbitBackoff;
}

export interface CodeRabbitRereviewDeps {
  history: ReviewRequestHistory;
  limits: ReviewRequestLimits;
  now?: () => string;
  appendIntent(record: ReviewRequestRecord): Promise<unknown>;
  findTrigger(repoPath: string, prNumber: number, head: string, sliceId: string): Promise<string | undefined>;
  commentOnPr(repoPath: string, prNumber: number, body: string, sliceId: string): Promise<ReviewPostOutcome>;
}

type Outcome = "requested" | "failed" | "cap_exhausted" | "backoff";
const REVIEWER = "coderabbit";

export async function apply(ctx: HandlerContext, state: LoopState, deps?: CodeRabbitRereviewDeps): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  const repoPath = state.repoPath;
  if (!deps || !repoPath) return res;
  const profile = ctx.meta.profile;
  const records = deps.history.byProfile[profile] ??= [];
  const { dailyCap, waitMs } = deps.limits;
  const { reviewers, requirements } = resolveMergePolicyRow(state.mergePolicy, "forge");
  if (!reviewers.some((reviewer) => reviewer.id === REVIEWER && reviewer.mode === "comment-trigger")) return res;

  for (const [sliceId, slice] of Object.entries(state.slices)) {
    if (taskTypeForSlice(sliceId, slice) !== "forge" || slice.stage !== "pr-open") continue;
    const pr = state.perSlice?.[sliceId]?.pr ?? slice.pr;
    if (!pr || pr.error || pr.skipped || pr.state !== "OPEN" || pr.is_draft !== false || pr.checks !== "PASS" ||
        pr.reviews_complete !== true || pr.coderabbit === undefined ||
        !Number.isSafeInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/i.test(pr.head_sha ?? "")) continue;

    const now = Date.parse(deps.now?.() ?? ctx.ts);
    if (!Number.isFinite(now)) continue;
    const head = pr.head_sha.toLowerCase();
    const cr = pr.coderabbit;
    const verdictHead = cr?.decision_commit_sha?.toLowerCase();
    if (verdictHead === head && (cr.decision === "APPROVED" || cr.decision === "CHANGES_REQUESTED")) continue;

    const prior = records.filter((record) => record.pr === pr.number && record.reviewer === REVIEWER);
    const onHead = prior.filter((record) => record.headSha === head);
    const triggerTimes = cr?.trigger_times_by_head ?? {};
    const trigger = triggerTimes[head];
    const recent = (time: string) => now - Date.parse(time) < waitMs;
    if (onHead.some((record) => recent(record.at)) || (trigger && recent(trigger))) continue;
    const notices: ReviewerNotice[] = pr.reviewer_notices ?? [];
    if (notices.some((notice) => {
      if (notice.reviewer !== REVIEWER || notice.kind !== "in_progress" || !recent(notice.created_at)) return false;
      if (notice.head_sha) return notice.head_sha === head;
      const preceding = Object.entries(triggerTimes as Record<string, string>)
        .filter(([, time]) => Date.parse(time) <= Date.parse(notice.created_at))
        .sort(([, left], [, right]) => Date.parse(right) - Date.parse(left))[0];
      return preceding ? preceding[0] === head : prior.every((record) => record.headSha === head) && (!verdictHead || verdictHead === head);
    })) continue;

    const newHead = prior.some((record) => record.headSha !== head) || !!(verdictHead && verdictHead !== head);
    const clear = pr.thread_count === 0 && pr.mergeable === "MERGEABLE" && pr.merge_state_status !== "dirty";
    if (newHead && !clear) continue;
    if (!newHead && !onHead.length && !trigger && cr?.review_times_by_head?.[head]) continue;

    let reason: ReviewRequestRecord["reason"] = "initial";
    if (onHead.length || trigger) {
      reason = "timeout_retry";
    } else if (cr?.decision === "CHANGES_REQUESTED") {
      if (!verdictHead || !clear) continue;
      reason = "stale_changes_requested";
    } else if (cr?.decision === "APPROVED" || cr?.decision === "DISMISSED") {
      if (!clear || approvalSatisfied(requirements, pr) || !changesRequestedSatisfied(requirements, pr) ||
          mergeBlocker(slice, pr) !== "none" ||
          !(pr.merge_state_status === "clean" || (pr.merge_state_status === "blocked" && pr.review_decision === "REVIEW_REQUIRED")) ||
          !requirements.botApprovers.includes("coderabbitai") || cr.decision_is_bot !== true) continue;
      reason = "stale_approval";
    }

    const report = (outcome: Outcome, detail: string, rateLimitHit?: boolean) => {
      // Back-off defers the request; it is not a failure.
      const deferred = outcome === "backoff";
      const action = outcome === "requested" ? "review-request" : deferred ? "review-request-deferred" : "review-request-failed";
      const entry = { action, sliceId, pr: { number: pr.number, url: pr.url }, detail, outcome, reason, rateLimitHit };
      (outcome === "requested" || deferred ? res.actions : res.failures).push(entry);
    };
    if (deps.history.backoff.blocked(now)) {
      report("backoff", "CodeRabbit is in back-off or awaiting outcome verification");
      continue;
    }
    try {
      if (reason === "timeout_retry") {
        const markedAt = trigger ?? await deps.findTrigger(repoPath, pr.number, head, sliceId);
        if (markedAt && (recent(markedAt) || Date.parse(cr?.review_times_by_head?.[head] ?? "") >= Date.parse(markedAt))) continue;
      }
      if (reason === "initial" && newHead) {
        // A push supersedes an unanswered request. Only the latest superseded
        // request decides: an older head's late answer must not hide it. A
        // COMMENTED review can answer a trigger, but a thread reply from before it cannot.
        const latest = prior.filter((record) => record.headSha !== head)
          .reduce<ReviewRequestRecord | undefined>((best, record) => (!best || Date.parse(record.at) >= Date.parse(best.at) ? record : best), undefined);
        const reviewAt = latest && cr?.review_times_by_head?.[latest.headSha];
        if (latest && reviewAt) {
          const markedAt = triggerTimes[latest.headSha] ?? await deps.findTrigger(repoPath, pr.number, latest.headSha, sliceId);
          if (markedAt && Date.parse(reviewAt) >= Date.parse(markedAt)) continue;
        }
      }
    } catch (error) {
      report("failed", `Could not verify prior CodeRabbit trigger: ${String(error)}`);
      continue;
    }
    const at = new Date(Date.parse(deps.now?.() ?? ctx.ts)).toISOString();
    if (remainingReviewCap(deps.history.byProfile, REVIEWER, "day", dailyCap, at) === 0) {
      report("cap_exhausted", "CodeRabbit UTC daily cap exhausted");
      continue;
    }

    const record = { sliceId, pr: pr.number, reviewer: REVIEWER, headSha: head, at, reason } as const;
    try {
      await deps.appendIntent(record);
      records.push(record);
    } catch (error) {
      report("failed", `Could not record CodeRabbit intent: ${String(error)}`);
      continue;
    }
    const outcome = await deps.commentOnPr(repoPath, pr.number, reviewRequestBody(head), sliceId)
      .catch((error): ReviewPostOutcome => ({ ok: false, kind: "failed", detail: String(error) }));
    if (outcome.ok) {
      report("requested", `Requested CodeRabbit review at ${head}`);
      continue;
    }
    if (outcome.kind === "failed") report("failed", `Could not post CodeRabbit trigger: ${outcome.detail}`);
    const signalAt = deps.now?.() ?? at;
    await deps.history.backoff.record({
      profile, sliceId, pr: pr.number, at: signalAt,
      ...(outcome.kind === "rate_limited"
        ? { cause: "http_429", resetAt: outcome.resetAt }
        : { cause: "post_failed" }),
    }, Date.parse(signalAt), (_target, decision, detail, hit) => report(decision, detail, hit));
  }
  return res;
}
