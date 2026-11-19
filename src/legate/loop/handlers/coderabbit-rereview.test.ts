/** @l0 @deterministic @ci */
import { describe, expect, it, vi } from "vitest";
import { emptyMultiProfileState, reduceMulti, type HeraldEvent, type ReviewRequestRecord } from "../../../herald/events.js";
import { validateEvent } from "../../../herald/service/routes.js";
import { reviewRequestBody } from "../../../observe/coderabbit-review.js";
import { classifyReviewerComment } from "../../../observe/review-bot-comments.js";
import { apply, reviewRequestLimits, type ReviewRequestHistory } from "./coderabbit-rereview.js";
import type { HandlerContext, LoopState } from "../state/types.js";

const head = "a".repeat(40);
const oldHead = "b".repeat(40);
const at = "2026-11-16T23:00:00Z";
const expired = "2026-11-16T23:30:00Z";
const githubAt = "2026-11-16T22:59:59Z";
const intent = { sliceId: "s", pr: 42, reviewer: "coderabbit", headSha: head, at, reason: "initial" } as const;

function fixture({
  pr = {},
  command = "smithy.forge",
  mode = "comment-trigger" as "auto" | "comment-trigger",
  history = { byProfile: {} } as ReviewRequestHistory,
  cap = Infinity,
  time = at,
} = {}) {
  const ctx = { ts: time, meta: { profile: "p" } } as HandlerContext;
  const state = {
    repoPath: "/repo",
    mergePolicy: { reviewRequests: { byTaskType: { forge: { reviewers: [{ id: "coderabbit", mode }] } } } },
    slices: { s: { stage: "pr-open", command } },
    perSlice: { s: { pr: {
      number: 42, head_sha: head, state: "OPEN", is_draft: false, checks: "PASS",
      reviews_complete: true, reviews: [], coderabbit: null, thread_count: 0,
      mergeable: "MERGEABLE", merge_state_status: "clean", ...pr,
    } } },
  } as unknown as LoopState;
  const deps = {
    history, limits: { dailyCap: cap, waitMs: 30 * 60_000 },
    appendIntent: vi.fn<(record: ReviewRequestRecord) => Promise<void>>().mockResolvedValue(undefined),
    findTrigger: vi.fn().mockResolvedValue(undefined),
    commentOnPr: vi.fn().mockResolvedValue(undefined),
  };
  return { tick: () => apply(ctx, state, deps), ctx, deps, state };
}

describe("CodeRabbit review requests", () => {
  it("appends before posting and excludes the incremental trigger from fix work", async () => {
    const { tick, deps } = fixture();
    expect((await tick()).actions).toEqual([expect.objectContaining({ action: "review-request", reason: "initial" })]);
    expect(deps.appendIntent).toHaveBeenCalledWith({ ...intent, at: new Date(at).toISOString() });
    expect(deps.appendIntent.mock.invocationCallOrder[0]).toBeLessThan(deps.commentOnPr.mock.invocationCallOrder[0]);
    const body = reviewRequestBody(head);
    expect(body).toBe(`@coderabbitai review\n\n<!-- march-coderabbit-request:${head} -->`);
    expect(deps.commentOnPr).toHaveBeenCalledWith("/repo", 42, body, "s");
    expect(classifyReviewerComment({ body }).kind).toBe("trigger");
    await tick();
    expect(deps.commentOnPr).toHaveBeenCalledTimes(1);
  });

  it.each([
    { checks: "NONE" }, { checks: "FAIL" }, { checks: "PENDING" }, { is_draft: true },
    { state: "CLOSED" }, { reviews_complete: false }, { error: "stale" },
    { coderabbit: { decision: "APPROVED", decision_commit_sha: head } },
    { coderabbit: { decision: "CHANGES_REQUESTED", decision_commit_sha: head } },
    { reviewer_notices: [{ reviewer: "coderabbit", kind: "in_progress", head_sha: head, created_at: at }] },
  ])("holds for %j", async (pr) => {
    const { tick, deps } = fixture({ pr });
    await tick();
    expect(deps.appendIntent).not.toHaveBeenCalled();
  });

  it("holds on non-forge and auto-mode PRs", async () => {
    for (const options of [{ command: "smithy.cut" }, { mode: "auto" as const }]) {
      const { tick, deps } = fixture(options);
      await tick();
      expect(deps.commentOnPr).not.toHaveBeenCalled();
    }
  });

  it("fails closed when append fails and retains intent after an ambiguous post", async () => {
    const { tick, deps } = fixture();
    deps.appendIntent.mockRejectedValueOnce(new Error("Herald down"));
    expect((await tick()).failures[0].action).toBe("review-request-failed");
    expect(deps.commentOnPr).not.toHaveBeenCalled();
    deps.commentOnPr.mockRejectedValueOnce(new Error("timeout"));
    expect((await tick()).failures[0].outcome).toBe("failed");
    await tick();
    expect(deps.commentOnPr).toHaveBeenCalledTimes(1);
  });

  it("rebuilds attempts from the fold, retries after the wait and stops at the global cap", async () => {
    const events = [
      { ...intent, profile: "other" },
      { ...intent, profile: "p" },
    ];
    const fold = emptyMultiProfileState();
    for (const [index, record] of events.entries()) {
      reduceMulti(fold, { ...record, type: "review.requested", seq: index + 1 } as HeraldEvent);
    }
    const history = { byProfile: Object.fromEntries(Object.entries(fold.byProfile)
      .map(([profile, state]) => [profile, state.reviewRequests!])) };
    const fresh = fixture({ history, time: "2026-11-16T23:29:59Z" });
    await fresh.tick();
    expect(fresh.deps.commentOnPr).not.toHaveBeenCalled();

    const retry = fixture({ history, time: expired, cap: 3 });
    expect((await retry.tick()).actions[0].reason).toBe("timeout_retry");
    await retry.tick();
    expect(retry.deps.commentOnPr).toHaveBeenCalledTimes(1);
    const capped = fixture({ history, pr: { number: 43 }, time: expired, cap: 3 });
    expect((await capped.tick()).failures[0].outcome).toBe("cap_exhausted");
    expect(capped.deps.commentOnPr).not.toHaveBeenCalled();
    const tomorrow = fixture({ history, pr: { number: 43 }, cap: 3, time: "2026-11-17T00:00:00Z" });
    expect((await tomorrow.tick()).actions).toHaveLength(1);
  });

  it("re-requests an unanswered intent superseded by a push, even with a thread reply on the new head", async () => {
    const history = { byProfile: { p: [{ ...intent, headSha: oldHead }] } };
    const coderabbit = { review_times_by_head: { [head]: githubAt }, trigger_times_by_head: { [oldHead]: githubAt } };
    const pr = { coderabbit, reviewer_notices: [{ reviewer: "coderabbit", kind: "in_progress", head_sha: oldHead, created_at: at }] };
    const blocked = fixture({ history, pr: { ...pr, thread_count: 1 } });
    await blocked.tick();
    expect(blocked.deps.commentOnPr).not.toHaveBeenCalled();
    expect((await fixture({ history, pr }).tick()).actions[0].reason).toBe("initial");
  });

  it("bases a new-head request on the latest superseded request, not an older late answer", async () => {
    const midHead = "c".repeat(40);
    const history = { byProfile: { p: [
      { ...intent, headSha: oldHead, at: "2026-11-16T21:00:00Z" },
      { ...intent, headSha: midHead, at: "2026-11-16T22:00:00Z" },
    ] } };
    const triggers = { [oldHead]: "2026-11-16T21:00:00Z", [midHead]: "2026-11-16T22:00:00Z" };
    const lateOldAnswer = { review_times_by_head: { [oldHead]: "2026-11-16T22:30:00Z" }, trigger_times_by_head: triggers };
    expect((await fixture({ history, pr: { coderabbit: lateOldAnswer } }).tick()).actions[0].reason).toBe("initial");
    const midAnswered = { review_times_by_head: { [midHead]: "2026-11-16T22:30:00Z" }, trigger_times_by_head: triggers };
    const run = fixture({ history, pr: { coderabbit: midAnswered } });
    await run.tick();
    expect(run.deps.commentOnPr).not.toHaveBeenCalled();
  });

  it.each([
    { decision: "CHANGES_REQUESTED", expected: "stale_changes_requested" },
    { decision: "APPROVED", expected: "stale_approval" },
    { decision: "DISMISSED", expected: "stale_approval" },
  ])("requests for a qualifying $decision after a push", async ({ decision, expected }) => {
    const coderabbit = { decision, decision_commit_sha: oldHead, decision_is_bot: true, review_times_by_head: { [head]: githubAt } };
    const pr = { coderabbit };
    expect((await fixture({ pr }).tick()).actions[0].reason).toBe(expected);
    expect((await fixture({ pr: { ...pr, mergeable: "CONFLICTING" } }).tick()).actions).toHaveLength(0);
  });

  it.each([
    { reviewedAt: githubAt, posts: false },
    { reviewedAt: "2026-11-16T22:59:58Z", posts: true },
    { reviewedAt: undefined, posts: true },
  ])("checks raw review time against the full GitHub trigger lookup: %j", async ({ reviewedAt, posts }) => {
    const run = fixture({
      history: { byProfile: { p: [intent] } }, time: expired,
      pr: { coderabbit: { review_times_by_head: { [head]: reviewedAt } } },
    });
    run.deps.findTrigger.mockResolvedValueOnce(githubAt);
    await run.tick();
    expect(run.deps.findTrigger).toHaveBeenCalledWith("/repo", 42, head, "s");
    expect(run.deps.commentOnPr).toHaveBeenCalledTimes(Number(posts));
  });

  it("holds when the missing trigger lookup is incomplete", async () => {
    const run = fixture({ history: { byProfile: { p: [intent] } }, time: expired });
    run.deps.findTrigger.mockRejectedValueOnce(new Error("page failed"));
    expect((await run.tick()).failures[0].outcome).toBe("failed");
    expect(run.deps.commentOnPr).not.toHaveBeenCalled();
  });

  it("observes back-off and refuses a zero cap", async () => {
    const backedOff = fixture({ history: { byProfile: {}, backoffUntil: expired } });
    expect((await backedOff.tick()).failures[0].outcome).toBe("backoff");
    const disabled = fixture({ cap: 0 });
    expect((await disabled.tick()).failures[0].outcome).toBe("cap_exhausted");
    expect(disabled.deps.appendIntent).not.toHaveBeenCalled();
  });

  it("validates the ledger payload and falls back for invalid settings", () => {
    const body = { ...intent, type: "review.requested" };
    expect(validateEvent(body).ok).toBe(true);
    for (const change of [{ reviewer: "other" }, { reason: "unknown" }, { headSha: "abc123" },
      { at: "2026-02-30T10:00:00Z" }, { at: "2026-11-16" }, { pr: -1 }]) {
      expect(validateEvent({ ...body, ...change }).ok).toBe(false);
    }
    const warn = vi.fn();
    expect(reviewRequestLimits({ MARCH_CODERABBIT_REVIEWS_PER_DAY: "-1", MARCH_REVIEW_WAIT_MINUTES: "0" }, warn))
      .toEqual({ waitMs: 1_800_000, dailyCap: Infinity });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
