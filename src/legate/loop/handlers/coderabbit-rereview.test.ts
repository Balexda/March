/** @l0 @deterministic @ci */
import { describe, expect, it, vi } from "vitest";
import { emptyMultiProfileState, reduceMulti, type HeraldEvent, type ReviewRequestRecord, type ReviewBackoffRecord } from "../../../herald/events.js";
import { approvalSatisfied, resolveMergePolicyRow } from "../../../herald/profiles/merge-policy.js";
import { backoffMs } from "../pure/self-heal.js";
import { validateEvent } from "../../../herald/service/routes.js";
import { reviewRequestBody } from "../../../observe/coderabbit-review.js";
import { classifyReviewerComment } from "../../../observe/review-bot-comments.js";
import { apply, reviewRequestLimits, type ReviewRequestHistory } from "./coderabbit-rereview.js";
import { CodeRabbitBackoff, reviewSignals, verifyStartupIntent } from "./review-backoff.js";
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
  history = { byProfile: {} } as Pick<ReviewRequestHistory, "byProfile"> & Partial<ReviewRequestHistory>,
  cap = Infinity,
  time = at,
  profile = "p",
} = {}) {
  const ctx = { ts: time, meta: { profile } } as HandlerContext;
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
    history: { backoff: new CodeRabbitBackoff(vi.fn().mockResolvedValue({ seq: 1, ts: time })), ...history }, limits: { dailyCap: cap, waitMs: 30 * 60_000 },
    appendIntent: vi.fn<(record: ReviewRequestRecord) => Promise<void>>().mockResolvedValue(undefined),
    findTrigger: vi.fn().mockResolvedValue(undefined),
    commentOnPr: vi.fn().mockResolvedValue({ ok: true }),
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
    const backoff = new CodeRabbitBackoff(vi.fn());
    await backoff.beginTick({
      ...emptyMultiProfileState(),
      reviewBackoffs: { coderabbit: { reviewer: "coderabbit", until: expired, attempts: 1, cause: "http_429", seq: 1, ts: at } },
    }, [], Date.parse(at), vi.fn(), vi.fn());
    const backedOff = fixture({ history: { byProfile: {}, backoff } });
    const deferred = await backedOff.tick();
    expect(deferred.failures).toHaveLength(0);
    expect(deferred.actions[0]).toEqual(expect.objectContaining({ action: "review-request-deferred", outcome: "backoff" }));
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

describe("CodeRabbit account-wide back-off", () => {
  function ledger() {
    const fold = emptyMultiProfileState();
    const append = vi.fn(async (profile: string, record: ReviewBackoffRecord, id: string) => {
      const event = { ...record, id, profile, seq: fold.seq + 1, ts: at, source: "legate", type: "review.backoff" } as const;
      reduceMulti(fold, event);
      return event;
    });
    return { fold, append, backoff: new CodeRabbitBackoff(append) };
  }

  it("validates transitions and folds by stream sequence across profiles", async () => {
    const { fold, append } = ledger();
    const record = { reviewer: "coderabbit", until: expired, attempts: 1, cause: "http_429" } as const;
    const event = { ...record, type: "review.backoff" };
    expect(validateEvent(event).ok).toBe(true);
    for (const invalid of [
      { reviewer: "codex" }, { cause: "unknown" }, { attempts: -1 }, { attempts: 1.5 },
      { attempts: 0 }, { cause: "reset" }, { until: "2026-11-31T12:00:00Z" },
      { until: expired.replace("Z", "+01:00") },
    ]) expect(validateEvent({ ...event, ...invalid }).ok).toBe(false);
    expect(fold.reviewBackoffs).toBeUndefined();
    await append("p", record, "limited");
    await append("q", { ...record, cause: "reset", attempts: 0, until: at }, "reset");
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ seq: 2, attempts: 0, until: at });
  });

  it("honours a 429 reset across profiles and replay, then applies bounded exponential delay without a fallback", async () => {
    const { backoff, fold, append } = ledger();
    const report = vi.fn();
    await backoff.beginTick(fold, [], Date.parse(at), vi.fn(), report);
    const from = fixture({ history: { byProfile: {}, backoff } });
    from.deps.commentOnPr.mockResolvedValueOnce({ ok: false, kind: "rate_limited", resetAt: expired });
    expect((await from.tick()).actions).toMatchObject([{ outcome: "backoff", rateLimitHit: true }]);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ until: new Date(expired).toISOString(), attempts: 1, cause: "http_429" });

    const other = fixture({ profile: "q", history: { byProfile: {}, backoff } });
    other.state.mergePolicy = { reviewRequests: { byTaskType: { forge: { reviewers: [
      { id: "coderabbit", mode: "comment-trigger" }, { id: "copilot", mode: "api", identity: "user" },
    ] } } } } as typeof other.state.mergePolicy;
    expect((await other.tick()).actions).toMatchObject([{ outcome: "backoff" }]);
    expect(other.deps.appendIntent).not.toHaveBeenCalled();
    expect(other.deps.commentOnPr).not.toHaveBeenCalled();

    const restarted = new CodeRabbitBackoff(append);
    await restarted.beginTick(fold, [], Date.parse(expired) - 1, vi.fn(), report);
    expect(restarted.blocked(Date.parse(expired) - 1)).toBe(true);
    let time = expired;
    for (let attempts = 2; attempts <= 10; attempts++) {
      await restarted.beginTick(fold, [], Date.parse(time), vi.fn(), report);
      const next = fixture({ time, profile: "q", history: { byProfile: {}, backoff: restarted } });
      next.deps.commentOnPr.mockResolvedValueOnce({ ok: false, kind: "rate_limited" });
      await next.tick();
      time = new Date(Date.parse(time) + backoffMs(attempts, "coderabbit")).toISOString();
      expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ until: time, attempts, cause: "http_429" });
    }
    expect(backoffMs(10, "coderabbit")).toBe(backoffMs(9, "coderabbit"));
  });

  it("processes another profile's notices before requests, deduplicates replay, and resets on fresh review", async () => {
    const { backoff, fold, append } = ledger();
    const report = vi.fn();
    const fresh = "2026-11-16T23:01:00Z";
    const pr = {
      number: 42, head_sha: head, reviews_complete: true,
      reviewer_notices: [
        { reviewer: "coderabbit", kind: "paused", created_at: at, comment_id: 12 },
        { reviewer: "coderabbit", kind: "rate_limited", created_at: at, reset_at: expired, comment_id: 13 },
        { reviewer: "coderabbit", kind: "rate_limited", created_at: "2026-11-16T20:00:00Z", comment_id: 14 },
      ],
      reviews: [{ login: "coderabbitai", author_kind: "bot" as const, state: "APPROVED" as const, commit_sha: head, submitted_at: fresh }],
      coderabbit: { decision: "APPROVED", review_times_by_head: { [head]: "2026-11-16T22:59:00Z", [oldHead]: fresh } },
    };
    const observations = () => reviewSignals("q", "owner/repo", "s", pr);
    await backoff.beginTick(fold, observations(), Date.parse(at), vi.fn(), report);
    expect(append.mock.calls.map(([, update]) => update.cause)).toEqual(["paused_comment", "rate_limited_comment"]);
    expect(append.mock.calls[1][1]).toMatchObject({ until: new Date(expired).toISOString(), attempts: 2 });
    const other = fixture({ history: { byProfile: {}, backoff } });
    expect((await other.tick()).actions).toMatchObject([{ outcome: "backoff" }]);
    expect(other.deps.appendIntent).not.toHaveBeenCalled();

    const restarted = new CodeRabbitBackoff(append);
    await restarted.beginTick(fold, observations(), Date.parse(fresh), vi.fn(), report);
    expect(append).toHaveBeenCalledTimes(2);
    expect(restarted.blocked(Date.parse(fresh))).toBe(true);
    expect(approvalSatisfied(resolveMergePolicyRow(undefined, "forge").requirements, pr)).toBe(true);
    pr.coderabbit.review_times_by_head[head] = fresh;
    await restarted.beginTick(fold, observations(), Date.parse(fresh), vi.fn(), report);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ cause: "reset", attempts: 0 });
    const afterReset = new CodeRabbitBackoff(append);
    await afterReset.beginTick(fold, observations(), Date.parse(expired), vi.fn(), report);
    expect(append).toHaveBeenCalledTimes(3);
    expect(afterReset.blocked(Date.parse(expired))).toBe(false);
  });

  it("retains the intent and blocks other profiles if a failed post cannot be recorded", async () => {
    const { backoff, fold, append } = ledger();
    const report = vi.fn();
    await backoff.beginTick(fold, [], Date.parse(at), vi.fn(), report);
    const history = { byProfile: {}, backoff };
    const from = fixture({ history });
    const other = fixture({ profile: "q", history });
    from.deps.commentOnPr.mockResolvedValueOnce({ ok: false, kind: "failed", detail: "timeout" });
    append.mockRejectedValueOnce(new Error("Herald unavailable"));
    expect((await from.tick()).failures).toMatchObject([{ outcome: "failed" }, { outcome: "failed" }]);
    expect(from.deps.history.byProfile.p).toHaveLength(1);
    expect((await other.tick()).actions).toMatchObject([{ outcome: "backoff" }]);
    expect(other.deps.appendIntent).not.toHaveBeenCalled();
    await backoff.beginTick(fold, [], Date.parse(at) + 1, vi.fn(), report);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ cause: "post_failed", attempts: 1 });
    expect(backoff.blocked(Date.parse(at) + 1)).toBe(true);
  });

  it("holds all posts until lookup and pending back-off persistence succeed on startup", async () => {
    const { backoff, fold, append } = ledger();
    reduceMulti(fold, {
      reviewer: "coderabbit", until: at, attempts: 2, cause: "http_429",
      profile: "q", seq: 1, ts: at, id: "prior", source: "legate", type: "review.backoff",
    });
    reduceMulti(fold, { ...intent, profile: "p", seq: 2, ts: at, id: "intent", source: "legate", type: "review.requested" });
    const report = vi.fn();
    const verify = vi.fn().mockRejectedValueOnce(new Error("missing page")).mockResolvedValue(false);
    append.mockRejectedValueOnce(new Error("Herald unavailable"));
    const other = fixture({ time: expired, profile: "q", history: { byProfile: {}, backoff } });
    const tick = () => backoff.beginTick(fold, [], Date.parse(expired), verify, report);
    await tick();
    expect(append).not.toHaveBeenCalled();
    await other.tick();
    expect(other.deps.appendIntent).not.toHaveBeenCalled();
    await tick();
    await other.tick();
    expect(other.deps.commentOnPr).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ profile: "p" }), "failed", expect.stringContaining("persist"));
    await tick();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]).toEqual(append.mock.calls[1]);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({
      attempts: 3, signalAt: at, until: new Date(Date.parse(at) + backoffMs(3, "coderabbit")).toISOString(),
    });
    expect((await other.tick()).actions).toMatchObject([{ outcome: "requested" }]);
  });

  it("reconciles a startup intent from a removed profile instead of wedging other profiles", async () => {
    const { backoff, fold, append } = ledger();
    reduceMulti(fold, { ...intent, profile: "gone", seq: 1, ts: at, id: "intent", source: "legate", type: "review.requested" });
    const findTrigger = vi.fn();
    const active = new Map([["p", { repoPath: "/repo/p" }]]);
    const verify = (i: Parameters<typeof verifyStartupIntent>[0]) => verifyStartupIntent(i, fold, active, findTrigger);
    const report = vi.fn();
    await backoff.beginTick(fold, [], Date.parse(expired), verify, report);
    expect(findTrigger).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith("gone", expect.objectContaining({ cause: "post_failed", attempts: 1 }), expect.any(String));
    const after = Date.parse(at) + backoffMs(1, "coderabbit") + 1;
    expect(backoff.blocked(after)).toBe(false);
    const other = fixture({ time: new Date(after).toISOString(), profile: "p", history: { byProfile: {}, backoff } });
    await other.tick();
    expect(other.deps.commentOnPr).toHaveBeenCalled();
  });

  it("still looks up triggers for intents of active profiles", async () => {
    const fold = emptyMultiProfileState();
    const record = { ...intent, profile: "p", seq: 1 };
    const findTrigger = vi.fn().mockResolvedValue(githubAt);
    expect(await verifyStartupIntent(record, fold, new Map([["p", { repoPath: "/repo/p" }]]), findTrigger)).toBe(true);
    expect(findTrigger).toHaveBeenCalledWith("/repo/p", 42, head, "s", Date.parse(at));
  });

  it("applies a late-delivered notice's later stated reset after a newer 429", async () => {
    const { backoff, fold, append } = ledger();
    const report = vi.fn();
    const later = "2026-11-17T01:00:00Z";
    await backoff.record({ profile: "p", sliceId: "s", pr: 42, at: "2026-11-16T23:00:01Z", cause: "http_429" }, Date.parse(at) + 1000, report);
    const pr = { number: 42, reviewer_notices: [
      { reviewer: "coderabbit", kind: "rate_limited", created_at: at, reset_at: later, comment_id: 21 },
    ] };
    await backoff.beginTick(fold, reviewSignals("p", "owner/repo", "s", pr), Date.parse(at) + 2000, vi.fn(), report);
    expect(append).toHaveBeenCalledTimes(2);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ until: new Date(later).toISOString(), noticeId: "coderabbit:21" });
    await backoff.beginTick(fold, reviewSignals("p", "owner/repo", "s", pr), Date.parse(at) + 3000, vi.fn(), report);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("never shortens an active deadline with a later throttle signal", async () => {
    const { backoff, fold } = ledger();
    const report = vi.fn();
    const t = Date.parse(at);
    const stated = new Date(t + backoffMs(2, "coderabbit") + 120_000).toISOString();
    await backoff.record({ profile: "p", sliceId: "s", pr: 42, at, cause: "http_429", resetAt: stated }, t, report);
    const pausedAt = new Date(t + 60_000).toISOString();
    await backoff.record({ profile: "p", sliceId: "s", pr: 42, at: pausedAt, cause: "paused_comment", noticeId: "coderabbit:9" }, t + 60_000, report);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ cause: "paused_comment", attempts: 2, until: stated });
    await backoff.record({ profile: "p", sliceId: "s", pr: 42, at: pausedAt, cause: "reset" }, t + 60_000, report);
    expect(fold.reviewBackoffs?.coderabbit).toMatchObject({ cause: "reset", attempts: 0, until: pausedAt });
  });

  it("settles a startup intent as unknown on a permanent lookup failure but retries transient ones", async () => {
    const fold = emptyMultiProfileState();
    const record = { ...intent, profile: "p", seq: 1 };
    const active = new Map([["p", { repoPath: "/repo/p" }]]);
    const gone = Object.assign(new Error("HTTP 404"), { status: 404 });
    expect(await verifyStartupIntent(record, fold, active, vi.fn().mockRejectedValue(gone))).toBe(false);
    const flaky = Object.assign(new Error("HTTP 502"), { status: 502 });
    await expect(verifyStartupIntent(record, fold, active, vi.fn().mockRejectedValue(flaky))).rejects.toBe(flaky);
    await expect(verifyStartupIntent(record, fold, active, vi.fn().mockRejectedValue(new Error("Incomplete PR comment history"))))
      .rejects.toThrow("Incomplete");
  });
});
