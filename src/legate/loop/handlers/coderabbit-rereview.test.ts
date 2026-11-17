/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { apply, REREVIEW_ACTION, REREVIEW_FAILED_ACTION, rereviewVerdict } from "./coderabbit-rereview.js";

/** A PR the steward fixed after CodeRabbit asked for changes on an earlier head. */
function fixedPr(overrides: Record<string, unknown> = {}): any {
  return {
    number: 543,
    url: "https://github.com/o/r/pull/543",
    state: "OPEN",
    head_sha: "d8e383e000",
    head_committed_at: "2026-11-16T15:22:00Z",
    mergeable: "MERGEABLE",
    merge_state_status: "blocked",
    checks: "PASS",
    needs_response_count: 0,
    coderabbit: {
      decision: "CHANGES_REQUESTED",
      decision_commit_sha: "441db76000",
      decision_at: "2026-11-16T09:37:00Z",
      last_request_at: "2026-11-16T09:29:00Z",
    },
    ...overrides,
  };
}
const openSlice = { stage: "pr-open" };

describe("rereviewVerdict", () => {
  it("requests once the steward has pushed past CodeRabbit's changes-requested review", () => {
    expect(rereviewVerdict(openSlice, fixedPr())).toEqual({ request: true, kind: "rereview" });
  });

  it.each([
    ["steward-busy", { stage: "pr-in-fix" }, {}],
    ["no-open-pr", openSlice, { state: "MERGED" }],
    ["not-changes-requested", openSlice, { coderabbit: { decision: "APPROVED", decision_commit_sha: "441db76000" } }],
    ["not-changes-requested", openSlice, { coderabbit: null }],
    ["head-already-reviewed", openSlice, { head_sha: "441db76000" }],
    ["threads-owed", openSlice, { needs_response_count: 2 }],
    ["conflicted", openSlice, { mergeable: "CONFLICTING" }],
    ["ci-failing", openSlice, { checks: "FAIL" }],
  ])("holds off: %s", (reason, slice, overrides) => {
    expect(rereviewVerdict(slice, fixedPr(overrides))).toEqual({ request: false, reason });
  });

  it("does not ask twice for one head: warm memo, or a request on GitHub newer than the head", () => {
    expect(rereviewVerdict(openSlice, fixedPr(), "d8e383e000")).toEqual({ request: false, reason: "already-requested" });
    const asked = fixedPr({ coderabbit: { ...fixedPr().coderabbit, last_request_at: "2026-11-16T15:30:00Z" } });
    expect(rereviewVerdict(openSlice, asked)).toEqual({ request: false, reason: "already-requested" });
    // A later push re-arms it.
    expect(rereviewVerdict(openSlice, fixedPr({ head_sha: "e0e0e0e", head_committed_at: "2026-11-16T16:00:00Z", coderabbit: asked.coderabbit }))).toEqual({ request: true, kind: "rereview" });
  });
});

describe("rereviewVerdict: first review", () => {
  const both = { rereview: true, initialReview: true };
  const fresh = (overrides: Record<string, unknown> = {}) => fixedPr({ coderabbit: null, ...overrides });

  it("asks for a first review when CodeRabbit never reviewed and was never asked", () => {
    expect(rereviewVerdict(openSlice, fresh(), undefined, both)).toEqual({ request: true, kind: "initial" });
    // Asked before an earlier head, never answered: the new head re-arms it.
    const askedEarlier = { decision: null, decision_commit_sha: null, decision_at: null, last_review_commit_sha: null, last_request_at: "2026-11-16T09:00:00Z" };
    expect(rereviewVerdict(openSlice, fresh({ coderabbit: askedEarlier }), undefined, both)).toEqual({ request: true, kind: "initial" });
  });

  it.each([
    ["mode off", fresh(), { rereview: true, initialReview: false }, "not-changes-requested"],
    ["already asked at this head", fresh({ coderabbit: { decision: null, decision_commit_sha: null, decision_at: null, last_review_commit_sha: null, last_request_at: "2026-11-16T15:30:00Z" } }), both, "already-requested"],
    ["reviewed with COMMENTED only", fresh({ coderabbit: { decision: null, decision_commit_sha: null, decision_at: null, last_review_commit_sha: "abc", last_request_at: null } }), both, "not-changes-requested"],
    ["approved", fresh({ coderabbit: { decision: "APPROVED", decision_commit_sha: "abc", decision_at: "x", last_review_commit_sha: "abc", last_request_at: null } }), both, "not-changes-requested"],
    ["standing not sensed (older snapshot or failed query)", fixedPr({ coderabbit: undefined }), both, "not-sensed"],
    ["threads owed", fresh({ needs_response_count: 1 }), both, "threads-owed"],
    ["CI failing", fresh({ checks: "FAIL" }), both, "ci-failing"],
  ])("holds off: %s", (_label, pr, modes, reason) => {
    expect(rereviewVerdict(openSlice, pr, undefined, modes)).toEqual({ request: false, reason });
  });

  it("first-review mode alone does not re-review a changes-requested PR", () => {
    expect(rereviewVerdict(openSlice, fixedPr(), undefined, { rereview: false, initialReview: true })).toEqual({
      request: false,
      reason: "not-changes-requested",
    });
  });
});

function state(prBySlice: Record<string, any>, policy: any = { codeRabbit: { rereview: true } }): any {
  const slices: Record<string, any> = {};
  const perSlice: Record<string, any> = {};
  for (const [id, pr] of Object.entries(prBySlice)) {
    slices[id] = { stage: "pr-open" };
    perSlice[id] = { pr };
  }
  return { raw: {}, slices, perSlice, repoPath: "/repo", mergePolicy: policy };
}
const ctx: any = { ts: "2026-11-16T16:00:00Z" };

describe("apply", () => {
  it("is inert unless the profile opts in", async () => {
    const commentOnPr = vi.fn();
    const res = await apply(ctx, state({ s: fixedPr() }, { dependencyUpdates: { autoMerge: true } }), { commentOnPr });
    expect(commentOnPr).not.toHaveBeenCalled();
    expect(res.actions).toEqual([]);
    expect((await apply(ctx, state({ s: fixedPr() }), undefined)).actions).toEqual([]);
  });

  it("comments `@coderabbitai review` once per head and records the action", async () => {
    const commentOnPr = vi.fn().mockResolvedValue(undefined);
    const st = state({ s: fixedPr(), done: fixedPr({ number: 7, head_sha: "441db76000" }) });
    const res = await apply(ctx, st, { commentOnPr });
    expect(commentOnPr).toHaveBeenCalledTimes(1);
    expect(commentOnPr).toHaveBeenCalledWith("/repo", 543, "@coderabbitai review");
    expect(res.actions).toEqual([expect.objectContaining({ action: REREVIEW_ACTION, sliceId: "s", pr: { number: 543, url: fixedPr().url } })]);
    // Same head on the next tick: no second comment.
    await apply(ctx, st, { commentOnPr });
    expect(commentOnPr).toHaveBeenCalledTimes(1);
  });

  it("makes the first request when only initialReview is on", async () => {
    const commentOnPr = vi.fn().mockResolvedValue(undefined);
    const st = state({ s: fixedPr({ coderabbit: null }), cr: fixedPr({ number: 9 }) }, { codeRabbit: { initialReview: true } });
    const res = await apply(ctx, st, { commentOnPr });
    expect(commentOnPr).toHaveBeenCalledTimes(1);
    expect(commentOnPr).toHaveBeenCalledWith("/repo", 543, "@coderabbitai review");
    expect(res.actions).toEqual([
      expect.objectContaining({ action: REREVIEW_ACTION, sliceId: "s", detail: expect.stringContaining("first review of PR #543") }),
    ]);
  });

  it("records a failed comment and does not retry it for the same head", async () => {
    const commentOnPr = vi.fn().mockRejectedValue(new Error("HTTP 403"));
    const st = state({ s: fixedPr() });
    const res = await apply(ctx, st, { commentOnPr });
    expect(res.failures).toEqual([expect.objectContaining({ action: REREVIEW_FAILED_ACTION, sliceId: "s", detail: expect.stringContaining("HTTP 403") })]);
    await apply(ctx, st, { commentOnPr });
    expect(commentOnPr).toHaveBeenCalledTimes(1);
  });
});
