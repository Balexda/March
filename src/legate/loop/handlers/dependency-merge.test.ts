/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  apply,
  CHECK_INTERVAL_MS,
  conflictedEligible,
  dependencyChecks,
  dependencyPrVerdict,
  isDependencyFile,
  MAX_RECREATES,
  NEEDS_HUMAN_LABEL,
  recreateRetryKey,
  UNBLOCK_WAIT_MS,
  unblockDecision,
  type DependencyPr,
  type UnblockInput,
} from "./dependency-merge.js";

const ok = (over: Partial<DependencyPr> = {}): DependencyPr => ({
  number: 7,
  title: "bump vite",
  author: { login: "app/dependabot", is_bot: true },
  isDraft: false,
  headRefOid: "abc123",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  files: [{ path: "package.json" }, { path: "package-lock.json" }],
  ...over,
});

describe("isDependencyFile", () => {
  it("accepts manifests, lockfiles and workflow files at any depth", () => {
    for (const p of ["package.json", "apps/web/package-lock.json", "go.sum", ".github/workflows/ci.yml", "docker/hatchery.Dockerfile"]) {
      expect(isDependencyFile(p)).toBe(true);
    }
  });
  it("rejects source, docs and other .github files", () => {
    for (const p of ["src/cli.ts", "README.md", ".github/copilot-instructions.md", ".github/workflows/scripts/run.sh", "package.json.bak"]) {
      expect(isDependencyFile(p)).toBe(false);
    }
  });
});

describe("dependencyChecks", () => {
  it("NONE without checks, PASS when all succeeded/skipped", () => {
    expect(dependencyChecks([])).toBe("NONE");
    expect(dependencyChecks(undefined)).toBe("NONE");
    expect(dependencyChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }])).toBe("PASS");
  });
  it("FAIL on any failed/cancelled check, PENDING while one is running", () => {
    expect(dependencyChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "CANCELLED" }])).toBe("FAIL");
    expect(dependencyChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS", conclusion: "" }])).toBe("FAIL");
    expect(dependencyChecks([{ status: "IN_PROGRESS", conclusion: "" }])).toBe("PENDING");
    expect(dependencyChecks([{ state: "PENDING" }])).toBe("PENDING");
  });
});

describe("dependencyPrVerdict", () => {
  it("accepts a green, clean Dependabot version bump", () => {
    expect(dependencyPrVerdict(ok())).toEqual({ eligible: true });
  });
  it.each([
    ["a human author", { author: { login: "alice" } }, "not opened by Dependabot"],
    ["a draft", { isDraft: true }, "draft"],
    ["a source file in the diff", { files: [{ path: "package.json" }, { path: "src/index.ts" }] }, "non-dependency file"],
    ["an unknown file list", { files: [] }, "changed files unknown"],
    ["no CI at all", { statusCheckRollup: [] }, "checks NONE"],
    ["failing CI", { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, "checks FAIL"],
    ["running CI", { statusCheckRollup: [{ status: "QUEUED" }] }, "checks PENDING"],
    ["a conflict", { mergeable: "CONFLICTING" }, "mergeable CONFLICTING"],
    ["a non-clean merge state", { mergeStateStatus: "BEHIND" }, "merge state BEHIND"],
    ["a missing head SHA", { headRefOid: undefined }, "head SHA unknown"],
  ])("rejects %s", (_name, over, reason) => {
    const verdict = dependencyPrVerdict(ok(over as Partial<DependencyPr>));
    expect(verdict.eligible).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(reason);
  });
});

describe("apply", () => {
  const ctx = {} as any;
  const state = (autoMerge: boolean | undefined, raw: any = {}): any => ({
    repoPath: "/repo",
    raw,
    mergePolicy: autoMerge === undefined ? undefined : { dependencyUpdates: { autoMerge } },
  });
  const deps = (prs: DependencyPr[], merged = true, now = 1_000_000) => ({
    listDependencyPrs: vi.fn(async () => prs),
    mergePr: vi.fn(async () => (merged ? { merged: true } : { merged: false, error: "boom" })),
    now: () => now,
  });

  it("is inert unless the profile opts in (no GitHub call)", async () => {
    for (const s of [state(undefined), state(false)]) {
      const d = deps([ok()]);
      const res = await apply(ctx, s, d);
      expect(res.actions).toEqual([]);
      expect(d.listDependencyPrs).not.toHaveBeenCalled();
    }
  });

  it("merges the oldest eligible PR, pinned to its head SHA, and only one per check", async () => {
    const d = deps([ok({ number: 9, headRefOid: "s9" }), ok({ number: 5, headRefOid: "s5" }), ok({ number: 3, isDraft: true })]);
    const res = await apply(ctx, state(true), d);
    expect(d.mergePr).toHaveBeenCalledTimes(1);
    expect(d.mergePr).toHaveBeenCalledWith({ prNumber: 5, headSha: "s5", repoPath: "/repo" });
    expect(res.actions.map((a) => a.action)).toEqual(["dependency-auto-merge"]);
  });

  it("throttles GitHub queries to one per interval", async () => {
    const s = state(true);
    const first = deps([], true, 1_000_000);
    await apply(ctx, s, first);
    const soon = deps([ok()], true, 1_000_000 + CHECK_INTERVAL_MS - 1);
    await apply(ctx, s, soon);
    expect(soon.listDependencyPrs).not.toHaveBeenCalled();
    const later = deps([ok()], true, 1_000_000 + CHECK_INTERVAL_MS);
    await apply(ctx, s, later);
    expect(later.mergePr).toHaveBeenCalledTimes(1);
  });

  it("records a failed merge and does not retry the same head; a new head retries", async () => {
    const s = state(true);
    const fail = deps([ok()], false, 1_000_000);
    const res = await apply(ctx, s, fail);
    expect(res.failures.map((f) => f.action)).toEqual(["dependency-auto-merge-failed"]);
    const same = deps([ok()], true, 2_000_000);
    await apply(ctx, s, same);
    expect(same.mergePr).not.toHaveBeenCalled();
    const pushed = deps([ok({ headRefOid: "new" })], true, 3_000_000);
    await apply(ctx, s, pushed);
    expect(pushed.mergePr).toHaveBeenCalledTimes(1);
  });

  it("reports a listing failure without throwing", async () => {
    const d = deps([]);
    d.listDependencyPrs.mockRejectedValueOnce(new Error("gh down"));
    const res = await apply(ctx, state(true), d);
    expect(res.failures).toEqual([{ action: "dependency-merge-list-failed", detail: "gh down" }]);
  });
});

// ---------------------------------------------------------------------------
// Conflict ladder (#573)
// ---------------------------------------------------------------------------

const conflicted = (over: Partial<DependencyPr> = {}): DependencyPr =>
  ok({
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    // Stale CI on a conflicted head must not matter.
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    ...over,
  });

describe("conflictedEligible", () => {
  it("accepts a conflicted Dependabot bump regardless of its stale CI", () => {
    expect(conflictedEligible(conflicted())).toBe(true);
    expect(conflictedEligible(conflicted({ mergeable: "UNKNOWN" }))).toBe(true); // DIRTY suffices
  });
  it.each([
    ["a clean PR", { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }],
    ["unknown mergeability", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }],
    ["a human author", { author: { login: "alice" } }],
    ["a draft", { isDraft: true }],
    ["a source file", { files: [{ path: "src/index.ts" }] }],
    ["a missing head SHA", { headRefOid: undefined }],
  ])("rejects %s", (_name, over) => {
    expect(conflictedEligible(conflicted(over as Partial<DependencyPr>))).toBe(false);
  });
});

describe("unblockDecision", () => {
  const T = 10_000_000;
  const input = (over: Partial<UnblockInput> = {}): UnblockInput => ({
    labels: [],
    sha: "h1",
    conflictSince: T,
    recreates: 0,
    foreign: false,
    now: T,
    ...over,
  });

  it("skips an escalated (labelled) PR", () => {
    expect(unblockDecision(input({ labels: [NEEDS_HUMAN_LABEL], foreign: true }))).toEqual({ kind: "skip" });
  });
  it("waits for Dependabot's own rebase on a pure branch, then recreates", () => {
    expect(unblockDecision(input({ now: T + UNBLOCK_WAIT_MS - 1 })).kind).toBe("wait");
    expect(unblockDecision(input({ now: T + UNBLOCK_WAIT_MS })).kind).toBe("recreate");
  });
  it("recreates at once when the branch has a foreign commit", () => {
    const d = unblockDecision(input({ foreign: true }));
    expect(d).toEqual({ kind: "recreate", reason: expect.stringContaining("not authored by Dependabot") });
  });
  it("escalates when Dependabot ignores the recreate for the wait window", () => {
    const last = { sha: "h1", at: T };
    expect(unblockDecision(input({ recreates: 1, lastRecreate: last, now: T + UNBLOCK_WAIT_MS - 1 })).kind).toBe("wait");
    const d = unblockDecision(input({ recreates: 1, lastRecreate: last, now: T + UNBLOCK_WAIT_MS }));
    expect(d).toEqual({ kind: "escalate", reason: expect.stringContaining("did not act") });
  });
  it("waits (never escalates) after a recreate with no warm timestamp", () => {
    expect(unblockDecision(input({ recreates: 1, now: T + 10 * UNBLOCK_WAIT_MS })).kind).toBe("wait");
  });
  it("re-recreates a branch conflicted again after Dependabot rebuilt it, then escalates at the cap", () => {
    const last = { sha: "h0", at: T - UNBLOCK_WAIT_MS };
    expect(unblockDecision(input({ recreates: 1, lastRecreate: last })).kind).toBe("wait");
    expect(unblockDecision(input({ recreates: 1, lastRecreate: last, now: T + UNBLOCK_WAIT_MS })).kind).toBe("recreate");
    expect(unblockDecision(input({ recreates: MAX_RECREATES, lastRecreate: last })).kind).toBe("wait");
    const d = unblockDecision(input({ recreates: MAX_RECREATES, lastRecreate: last, now: T + UNBLOCK_WAIT_MS }));
    expect(d).toEqual({ kind: "escalate", reason: expect.stringContaining("still conflicted") });
  });
});

describe("apply — conflict ladder", () => {
  const T0 = 50_000_000;
  const policyState = (raw: any = {}): any => ({
    repoPath: "/repo",
    raw,
    mergePolicy: { dependencyUpdates: { autoMerge: true } },
  });
  const makeCtx = () => {
    const transitions: any[] = [];
    return { ctx: { emitTransition: (e: any) => transitions.push(e) } as any, transitions };
  };
  const ladderDeps = (prs: DependencyPr[], now: number, authors: string[] = ["dependabot[bot]"]) => ({
    listDependencyPrs: vi.fn(async () => prs),
    mergePr: vi.fn(async () => ({ merged: true })),
    listCommitAuthors: vi.fn(async () => authors),
    commentOnPr: vi.fn(async () => {}),
    labelPr: vi.fn(async () => {}),
    now: () => now,
  });
  const actions = (res: any) => [...res.actions, ...res.failures].map((a: any) => a.action);

  it("waits on a pure Dependabot branch, then asks for one recreate and counts it durably", async () => {
    const s = policyState();
    const { ctx, transitions } = makeCtx();
    const first = ladderDeps([conflicted()], T0);
    expect(actions(await apply(ctx, s, first))).toEqual([]);
    expect(first.commentOnPr).not.toHaveBeenCalled();

    const later = ladderDeps([conflicted()], T0 + UNBLOCK_WAIT_MS);
    const res = await apply(ctx, s, later);
    expect(later.commentOnPr).toHaveBeenCalledWith("/repo", 7, "@dependabot recreate");
    expect(actions(res)).toEqual(["dependency-recreate-requested"]);
    expect(s.raw.transient_retry_counts[recreateRetryKey(7)]).toBe(1);
    expect(transitions).toContainEqual({ type: "retry.counted", key: recreateRetryKey(7), count: 1 });
    // The authorship of one head is fetched once.
    expect(first.listCommitAuthors).toHaveBeenCalledTimes(1);
    expect(later.listCommitAuthors).not.toHaveBeenCalled();
  });

  it("recreates on the first check when the branch carries a foreign commit", async () => {
    const d = ladderDeps([conflicted()], T0, ["dependabot[bot]", "jmb"]);
    const res = await apply(makeCtx().ctx, policyState(), d);
    expect(actions(res)).toEqual(["dependency-recreate-requested"]);
  });

  it("escalates once (label, then comment) when Dependabot ignores the recreate", async () => {
    const s = policyState();
    const { ctx } = makeCtx();
    await apply(ctx, s, ladderDeps([conflicted()], T0, ["jmb"]));
    const ignored = ladderDeps([conflicted()], T0 + UNBLOCK_WAIT_MS, ["jmb"]);
    const res = await apply(ctx, s, ignored);
    expect(actions(res)).toEqual(["dependency-unblock-escalated"]);
    expect(ignored.labelPr).toHaveBeenCalledWith("/repo", 7, NEEDS_HUMAN_LABEL);
    expect(ignored.commentOnPr).toHaveBeenCalledWith("/repo", 7, expect.stringContaining("did not act"));
    // Next check: the label is on the PR, so the ladder leaves it alone (no GitHub calls).
    const labelled = ladderDeps([conflicted({ labels: [{ name: NEEDS_HUMAN_LABEL }] })], T0 + 3 * UNBLOCK_WAIT_MS, ["jmb"]);
    expect(actions(await apply(ctx, s, labelled))).toEqual([]);
    expect(labelled.listCommitAuthors).not.toHaveBeenCalled();
    expect(labelled.commentOnPr).not.toHaveBeenCalled();
  });

  it("re-recreates after Dependabot rebuilt a branch that conflicted again, then escalates at the cap", async () => {
    const s = policyState();
    const { ctx } = makeCtx();
    let t = T0;
    await apply(ctx, s, ladderDeps([conflicted({ headRefOid: "a" })], t, ["jmb"])); // recreate 1
    t += CHECK_INTERVAL_MS;
    expect(actions(await apply(ctx, s, ladderDeps([conflicted({ headRefOid: "b" })], t)))).toEqual([]); // rebuilt; wait
    t += UNBLOCK_WAIT_MS;
    expect(actions(await apply(ctx, s, ladderDeps([conflicted({ headRefOid: "b" })], t)))).toEqual(["dependency-recreate-requested"]);
    expect(s.raw.transient_retry_counts[recreateRetryKey(7)]).toBe(MAX_RECREATES);
    t += CHECK_INTERVAL_MS;
    await apply(ctx, s, ladderDeps([conflicted({ headRefOid: "c" })], t)); // rebuilt again; wait
    t += UNBLOCK_WAIT_MS;
    const res = await apply(ctx, s, ladderDeps([conflicted({ headRefOid: "c" })], t));
    expect(actions(res)).toEqual(["dependency-unblock-escalated"]);
  });

  it("does not count a recreate whose comment failed, and retries it next check", async () => {
    const s = policyState();
    const { ctx } = makeCtx();
    const d = ladderDeps([conflicted()], T0, ["jmb"]);
    d.commentOnPr.mockRejectedValueOnce(new Error("gh 502"));
    expect(actions(await apply(ctx, s, d))).toEqual(["dependency-recreate-failed"]);
    expect(s.raw.transient_retry_counts?.[recreateRetryKey(7)] ?? 0).toBe(0);
    const retry = ladderDeps([conflicted()], T0 + CHECK_INTERVAL_MS, ["jmb"]);
    expect(actions(await apply(ctx, s, retry))).toEqual(["dependency-recreate-requested"]);
  });

  it("reports a failed escalation label and posts no comment", async () => {
    const s = policyState({ transient_retry_counts: { [recreateRetryKey(7)]: MAX_RECREATES } });
    const { ctx } = makeCtx();
    await apply(ctx, s, ladderDeps([conflicted()], T0)); // cold start seeds the warm timestamp
    const d = ladderDeps([conflicted()], T0 + UNBLOCK_WAIT_MS);
    d.labelPr.mockRejectedValueOnce(new Error("no perms"));
    expect(actions(await apply(ctx, s, d))).toEqual(["dependency-unblock-escalate-failed"]);
    expect(d.commentOnPr).not.toHaveBeenCalled();
  });

  it("after a cold start, restarts the wait rather than re-posting the first recreate", async () => {
    const s = policyState({ transient_retry_counts: { [recreateRetryKey(7)]: 1 } });
    const { ctx } = makeCtx();
    const d = ladderDeps([conflicted()], T0, ["jmb"]);
    expect(actions(await apply(ctx, s, d))).toEqual([]);
    expect(d.commentOnPr).not.toHaveBeenCalled();
  });

  it("zeroes the durable count and drops warm state once the PR is no longer open", async () => {
    const s = policyState();
    const { ctx, transitions } = makeCtx();
    await apply(ctx, s, ladderDeps([conflicted()], T0, ["jmb"]));
    await apply(ctx, s, ladderDeps([], T0 + CHECK_INTERVAL_MS));
    expect(s.raw.transient_retry_counts[recreateRetryKey(7)]).toBe(0);
    expect(transitions).toContainEqual({ type: "retry.counted", key: recreateRetryKey(7), count: 0 });
    expect(s.raw.dependency_merge.conflict).toEqual({});
    expect(s.raw.dependency_merge.recreate).toEqual({});
    expect(s.raw.dependency_merge.foreign).toEqual({});
  });

  it("reports resolved when a PR that went through the ladder merges", async () => {
    const s = policyState({ transient_retry_counts: { [recreateRetryKey(7)]: 1 } });
    const res = await apply(makeCtx().ctx, s, ladderDeps([ok({ headRefOid: "fresh" })], T0));
    expect(actions(res)).toEqual(["dependency-auto-merge", "dependency-unblock-resolved"]);
  });

  it("leaves non-candidates alone (unknown mergeability, human PRs)", async () => {
    const d = ladderDeps(
      [conflicted({ number: 1, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), conflicted({ number: 2, author: { login: "alice" } })],
      T0 + 10 * UNBLOCK_WAIT_MS,
      ["jmb"],
    );
    expect(actions(await apply(makeCtx().ctx, policyState(), d))).toEqual([]);
    expect(d.listCommitAuthors).not.toHaveBeenCalled();
  });

  it("is inert when the policy is off", async () => {
    const d = ladderDeps([conflicted()], T0, ["jmb"]);
    await apply(makeCtx().ctx, { repoPath: "/repo", raw: {}, mergePolicy: undefined } as any, d);
    expect(d.listDependencyPrs).not.toHaveBeenCalled();
    expect(d.commentOnPr).not.toHaveBeenCalled();
  });
});
