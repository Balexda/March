/**
 * @l0 @deterministic @ci
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apply,
  CHECK_INTERVAL_MS,
  PR_LABEL_ADDED_ACTION,
  PR_LABEL_FAILED_ACTION,
  PR_LABEL_REMOVED_ACTION,
  PR_REASON_POSTED_ACTION,
  PR_REASON_RESOLVED_ACTION,
  PR_REASON_UPDATED_ACTION,
  type PrLabelsDeps,
} from "./pr-labels.js";
import { needsHumanReasonBody, NEEDS_HUMAN_LABEL, OPENED_LABEL, resolvedReasonBody } from "../pure/pr-labels.js";

const ctx: any = {};
function mkState(over: any = {}): any {
  return {
    repoPath: "/repo",
    raw: {},
    slices: { s1: { stage: "escalated" } },
    perSlice: { s1: { pr: { number: 10 } } },
    ...over,
  };
}
function mkDeps(prs: any[], over: Partial<PrLabelsDeps> = {}) {
  let t = 1_000_000;
  const deps = {
    listOpenPrs: vi.fn(async () => prs),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    now: () => t,
    advance: (ms: number) => (t += ms),
    ...over,
  };
  return deps as typeof deps & PrLabelsDeps;
}
const prs = () => [
  { number: 10, headRefName: "smithy/cut/a", author: { login: "me" }, labels: [] },
  { number: 11, headRefName: "tessera/x", author: { login: "me" }, labels: [{ name: OPENED_LABEL }, { name: "bug" }] },
];

afterEach(() => {
  delete process.env.MARCH_LEGATE_PR_LABELS;
});

describe("pr-labels apply", () => {
  it("adds and removes owned labels, reporting actions", async () => {
    const deps = mkDeps(prs());
    const res = await apply(ctx, mkState(), deps);
    expect(deps.addLabel).toHaveBeenCalledWith("/repo", 10, OPENED_LABEL, "s1");
    expect(deps.addLabel).toHaveBeenCalledWith("/repo", 10, NEEDS_HUMAN_LABEL, "s1");
    expect(deps.removeLabel).toHaveBeenCalledWith("/repo", 11, OPENED_LABEL, undefined);
    expect(res.actions).toEqual([
      { action: PR_LABEL_ADDED_ACTION, sliceId: "s1", pr: 10, detail: OPENED_LABEL },
      { action: PR_LABEL_ADDED_ACTION, sliceId: "s1", pr: 10, detail: NEEDS_HUMAN_LABEL },
      { action: PR_LABEL_REMOVED_ACTION, pr: 11, detail: OPENED_LABEL },
    ]);
    expect(res.failures).toEqual([]);
  });

  it("throttles listings to one per interval", async () => {
    const deps = mkDeps(prs());
    const state = mkState();
    await apply(ctx, state, deps);
    await apply(ctx, state, deps);
    expect(deps.listOpenPrs).toHaveBeenCalledTimes(1);
    deps.advance(CHECK_INTERVAL_MS);
    await apply(ctx, state, deps);
    expect(deps.listOpenPrs).toHaveBeenCalledTimes(2);
  });

  it("makes no writes in steady state", async () => {
    const steady = [
      { number: 10, headRefName: "x", labels: [{ name: OPENED_LABEL }, { name: NEEDS_HUMAN_LABEL }] },
      { number: 11, headRefName: "x", labels: [{ name: "bug" }] },
    ];
    const deps = mkDeps(steady);
    const res = await apply(ctx, mkState(), deps);
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(res.actions).toEqual([]);
  });

  it("a per-PR failure is recorded and does not abort the rest", async () => {
    const deps = mkDeps(prs(), {
      addLabel: vi.fn(async (_r: string, n: number) => {
        if (n === 10) throw new Error("boom");
      }),
    });
    const res = await apply(ctx, mkState(), deps);
    expect(res.failures).toEqual([
      { action: PR_LABEL_FAILED_ACTION, sliceId: "s1", pr: 10, detail: `${OPENED_LABEL}: boom` },
      { action: PR_LABEL_FAILED_ACTION, sliceId: "s1", pr: 10, detail: `${NEEDS_HUMAN_LABEL}: boom` },
    ]);
    expect(deps.removeLabel).toHaveBeenCalledWith("/repo", 11, OPENED_LABEL, undefined);
    expect(res.actions).toHaveLength(1);
  });

  it("a list failure becomes a failure", async () => {
    const deps = mkDeps([], { listOpenPrs: vi.fn(async () => { throw new Error("gh down"); }) });
    const res = await apply(ctx, mkState(), deps);
    expect(res.failures).toEqual([{ action: PR_LABEL_FAILED_ACTION, detail: "list: gh down" }]);
  });

  it("MARCH_LEGATE_PR_LABELS=0 disables it", async () => {
    process.env.MARCH_LEGATE_PR_LABELS = "0";
    const deps = mkDeps(prs());
    const res = await apply(ctx, mkState(), deps);
    expect(deps.listOpenPrs).not.toHaveBeenCalled();
    expect(res.actions).toEqual([]);
  });

  it("no deps or no repoPath is a no-op", async () => {
    expect((await apply(ctx, mkState(), undefined)).actions).toEqual([]);
    const deps = mkDeps(prs());
    await apply(ctx, mkState({ repoPath: undefined }), deps);
    expect(deps.listOpenPrs).not.toHaveBeenCalled();
  });
});

describe("pr-labels reason comment", () => {
  const slice = { stage: "pr-open", merge_gate: "waiting-approval", merge_failing: ["approval:missing"] };
  const labelled = () => [{ number: 10, headRefName: "x", labels: [{ name: OPENED_LABEL }, { name: NEEDS_HUMAN_LABEL }] }];
  const st = (sl: any = slice) => mkState({ slices: { s1: sl } });
  function reasonDeps(prList: any[], found: { id: number; body: string } | null) {
    const store = { c: found };
    const deps = mkDeps(prList, {
      findReasonComment: vi.fn(async () => store.c),
      upsertReasonComment: vi.fn(async (_r: string, _n: number, body: string, id?: number) => {
        store.c = { id: id ?? 99, body };
      }),
    });
    return { deps, store };
  }

  it("posts exactly one comment, then nothing on the next tick", async () => {
    const { deps } = reasonDeps(labelled(), null);
    const state = st();
    const r1 = await apply(ctx, state, deps);
    expect(deps.upsertReasonComment).toHaveBeenCalledTimes(1);
    expect(deps.upsertReasonComment).toHaveBeenCalledWith("/repo", 10, needsHumanReasonBody(slice));
    expect(r1.actions.map((a) => a.action)).toEqual([PR_REASON_POSTED_ACTION]);
    deps.advance(CHECK_INTERVAL_MS);
    const r2 = await apply(ctx, state, deps);
    expect(deps.upsertReasonComment).toHaveBeenCalledTimes(1);
    expect(r2.actions).toEqual([]);
  });

  it("edits with existingId when the reason changed", async () => {
    const { deps } = reasonDeps(labelled(), { id: 7, body: "<!-- march:needs-human-reason -->\nold" });
    const res = await apply(ctx, st(), deps);
    expect(deps.upsertReasonComment).toHaveBeenCalledWith("/repo", 10, needsHumanReasonBody(slice), 7);
    expect(res.actions.map((a) => a.action)).toEqual([PR_REASON_UPDATED_ACTION]);
  });

  it("marks resolved once when the label is cleared", async () => {
    const { deps } = reasonDeps(labelled(), { id: 7, body: needsHumanReasonBody(slice)! });
    const state = st({ stage: "pr-open", merge_gate: "ready" });
    const r1 = await apply(ctx, state, deps);
    expect(deps.removeLabel).toHaveBeenCalledWith("/repo", 10, NEEDS_HUMAN_LABEL, "s1");
    expect(deps.upsertReasonComment).toHaveBeenCalledWith("/repo", 10, resolvedReasonBody(), 7);
    expect(r1.actions.map((a) => a.action)).toContain(PR_REASON_RESOLVED_ACTION);
    deps.advance(CHECK_INTERVAL_MS);
    await apply(ctx, state, deps);
    expect(deps.upsertReasonComment).toHaveBeenCalledTimes(1);
  });

  it("clear with no existing comment posts nothing", async () => {
    const { deps } = reasonDeps(labelled(), null);
    await apply(ctx, st({ stage: "pr-open", merge_gate: "ready" }), deps);
    expect(deps.upsertReasonComment).not.toHaveBeenCalled();
  });

  it("a lookup failure posts nothing and records a failure", async () => {
    const { deps } = reasonDeps(labelled(), null);
    (deps.findReasonComment as any).mockRejectedValue(new Error("nope"));
    const res = await apply(ctx, st(), deps);
    expect(deps.upsertReasonComment).not.toHaveBeenCalled();
    expect(res.failures).toEqual([{ action: PR_LABEL_FAILED_ACTION, sliceId: "s1", pr: 10, detail: "reason: nope" }]);
  });

  it("leaves a dependabot PR untouched", async () => {
    const d = [{ number: 10, author: { login: "dependabot[bot]" }, labels: [{ name: NEEDS_HUMAN_LABEL }] }];
    const { deps } = reasonDeps(d, null);
    await apply(ctx, st(), deps);
    expect(deps.findReasonComment).not.toHaveBeenCalled();
    expect(deps.upsertReasonComment).not.toHaveBeenCalled();
  });

  it("only lists comments for entries with a reason", async () => {
    const { deps } = reasonDeps([{ number: 10, headRefName: "x", labels: [{ name: OPENED_LABEL }] }], null);
    await apply(ctx, st({ stage: "pr-open", merge_gate: "ready" }), deps);
    expect(deps.findReasonComment).not.toHaveBeenCalled();
  });

  it("works without the optional deps", async () => {
    const deps = mkDeps(labelled());
    const res = await apply(ctx, st(), deps);
    expect(res.failures).toEqual([]);
  });
});
