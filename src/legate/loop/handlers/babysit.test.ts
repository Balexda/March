import { describe, expect, it, vi } from "vitest";
import { apply, assess, type BabysitDeps, type BabysitDecision } from "./babysit.js";
import type { HandlerContext, LoopState } from "../state/types.js";

const NOW = "2026-05-20T01:00:00Z";
const T_30M_AGO = "2026-05-20T00:30:00Z"; // 30min before NOW

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    ts: NOW,
    statePresent: true,
    stateError: null,
    raw: { slices: {}, repo: { default_branch: "main" } },
    slices: {},
    archived: {},
    repoPath: "/repo",
    workerGroup: "legate-workers",
    sessions: [],
    sessionsById: new Map(),
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice: {},
    ...over,
  };
}

function ctx(): HandlerContext {
  return {
    meta: { processor_name: "loop", paired_legate: "legate", profile: "p" } as any,
    ts: NOW,
    castra: {} as any,
    broodTeardown: vi.fn(),
    emit: vi.fn(),
    emitTransition: vi.fn(),
    log: vi.fn(),
  };
}

function deps(over: Partial<BabysitDeps> = {}): BabysitDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    requestJudgement: vi.fn(async (input) => ({ kind: "processor_request", ...input })),
    ...over,
  };
}

const session = (id: string, status: string) => ({ id, group: "legate-workers", status });
const kindsOf = (ds: BabysitDecision[]) => ds.map((d) => d.kind);

describe("babysit assess", () => {
  it("flags a login block from recent output", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "implementing" } },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "API Error: 401 Invalid authentication credentials" } } },
    });
    expect(kindsOf(assess(state))).toEqual(["login-block"]);
  });

  it("escalates a worker in error state", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 1 } } },
      sessions: [session("w", "error")],
      perSlice: { s: { recentOutput: { output: "boom" } } },
    });
    expect(kindsOf(assess(state))).toEqual(["worker-error"]);
  });

  it("skips running workers and clears stale worker-error markers", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 1 }, worker_error_last_seen_at: "x" } },
      sessions: [session("w", "running")],
      perSlice: { s: { recentOutput: { output: "" } } },
    });
    expect(kindsOf(assess(state))).toEqual(["clear-worker-error"]);
  });

  it("nudges a stranded steward stuck implementing with no PR", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "implementing", implementing_started_at: T_30M_AGO } },
      sessions: [session("w", "waiting")],
      perSlice: { s: { recentOutput: { output: "" } } },
    });
    // First nudge fires immediately at the threshold; the operator alert only
    // fires on a later re-nudge once steward_nudge_sent_at is set.
    const ds = assess(state);
    expect(ds[0]).toMatchObject({ kind: "steward-nudge", nudge: true, alert: false, nextCount: 1 });

    // Re-nudge past the 25-min alert budget → alert fires alongside the nudge.
    (state.slices.s as any).steward_nudge_sent_at = "2026-05-20T00:50:00Z"; // 10min ago > repeat interval
    (state.slices.s as any).steward_nudge_count = 1;
    expect(assess(state)[0]).toMatchObject({ kind: "steward-nudge", nudge: true, alert: true, nextCount: 2 });
  });

  it("snapshots then sends conflict-fix for a CONFLICTING PR", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } } },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: { number: 5, state: "OPEN", mergeable: "CONFLICTING", checks: "PASS" } } },
    });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "conflict-fix"]);
  });

  it("sends review-fix when threads need response", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 }, pr_open_at: T_30M_AGO } },
      sessions: [session("w", "idle")],
      perSlice: {
        s: {
          recentOutput: { output: "" },
          pr: { number: 5, state: "OPEN", mergeable: "MERGEABLE", checks: "PASS", unresolved_threads: [{ id: "t1", needs_response: true }] },
        },
      },
    });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "review-fix"]);
  });

  it("dispatches a steward ci-fix on the first failing CI, before any legate judgement (#303)", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } } },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: { number: 5, state: "OPEN", mergeable: "MERGEABLE", checks: "FAIL", needs_response_count: 0, head_sha: "sha1" } } },
    });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "ci-fix"]);
  });

  it("escalates failing CI to legate judgement only after the bounded steward rounds are spent (#303)", async () => {
    // Two rounds already spent, and this is a fresh failing head SHA (not the
    // one last dispatched against) → no more steward attempts, escalate once.
    const state = loopState({
      slices: {
        s: {
          worker_session_id: "w",
          stage: "pr-in-rerun",
          pr: { number: 5 },
          ci_fix_rounds: 2,
          last_processor_action: "ci-fix",
          last_processor_action_key: ["ci-fix", 5, "OPEN", "MERGEABLE", "FAIL", "", "shaPREV"].join(":"),
        },
      },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: { number: 5, state: "OPEN", mergeable: "MERGEABLE", checks: "FAIL", needs_response_count: 0, head_sha: "shaNEW" } } },
    });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "ci-failure"]);

    // Once the escalation latch is set, it does not fire again (escalate once).
    (state.slices.s as any).ci_fix_escalated_at = NOW;
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("re-nudges a parked worker on the same failing head SHA instead of burning a fresh ci-fix round (#303)", async () => {
    const key = ["ci-fix", 5, "OPEN", "MERGEABLE", "FAIL", "", "sha1"].join(":");
    const state = loopState({
      slices: {
        s: {
          worker_session_id: "w",
          stage: "pr-in-rerun",
          pr: { number: 5 },
          ci_fix_rounds: 1,
          last_processor_action: "ci-fix",
          last_processor_action_key: key,
          last_processor_action_at: T_30M_AGO,
        },
      },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: { number: 5, state: "OPEN", mergeable: "MERGEABLE", checks: "FAIL", needs_response_count: 0, head_sha: "sha1" } } },
    });
    const ds = assess(state);
    expect(ds.find((d) => d.kind === "post-dispatch-nudge")).toMatchObject({ count: 1 });
    expect(ds.find((d) => d.kind === "ci-fix")).toBeUndefined();
    expect(ds.find((d) => d.kind === "ci-failure")).toBeUndefined();
  });

  it("post-dispatch nudges a parked worker on a re-dispatch of the same key", async () => {
    const key = ["conflict-fix", 5, "OPEN", "CONFLICTING", "PASS", "", ""].join(":");
    const state = loopState({
      slices: {
        s: {
          worker_session_id: "w",
          stage: "pr-open",
          pr: { number: 5 },
          last_processor_action_key: key,
          last_processor_action_at: T_30M_AGO,
        },
      },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: { number: 5, state: "OPEN", mergeable: "CONFLICTING", checks: "PASS" } } },
    });
    const ds = assess(state);
    expect(ds.find((d) => d.kind === "post-dispatch-nudge")).toMatchObject({ count: 1 });
  });
});

describe("babysit auto-merge gate", () => {
  const clearPr = (over: Record<string, unknown> = {}) => ({
    number: 5,
    url: "u",
    state: "OPEN",
    mergeable: "MERGEABLE",
    checks: "PASS",
    needs_response_count: 0,
    head_sha: "abc123",
    merge_state_status: "clean",
    human_approval_count: 0,
    changes_requested_count: 0,
    ...over,
  });
  const allClearState = (over: Record<string, unknown> = {}, sliceOver: Record<string, unknown> = {}) =>
    loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 }, command: "smithy.forge", ...sliceOver } },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: clearPr(over) } },
    });

  it("auto-merges an all-clear PR that has a human approval (default policy)", () => {
    const state = allClearState({ human_approval_count: 1 });
    const ds = assess(state);
    expect(kindsOf(ds)).toEqual(["pr-snapshot", "pr-auto-merge"]);
  });

  it("does NOT auto-merge an all-clear PR with zero approvals (default requires approval)", () => {
    const state = allClearState({ human_approval_count: 0 });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("does NOT auto-merge when an approval exists but a change is requested (default)", () => {
    const state = allClearState({ human_approval_count: 1, changes_requested_count: 1 });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("auto-merges a cut PR with zero approvals when the policy relaxes approval for cut", () => {
    const state = allClearState(
      { human_approval_count: 0 },
      { command: "smithy.cut" },
    );
    state.mergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "pr-auto-merge"]);
  });

  it("derives the cut verb from the branch when command is absent (cold-start fold)", () => {
    // The Herald fold is thin and drops `command`; the gate must still relax via
    // the fold-durable branch `smithy/cut/…`.
    const state = allClearState(
      { human_approval_count: 0 },
      { command: undefined, branch: "smithy/cut/01-spawn-f3-s6" },
    );
    state.mergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "pr-auto-merge"]);
  });

  it("derives the cut verb from the sliceId suffix when command and branch are absent", () => {
    const state = loopState({
      slices: { "01-spawn-f3-s6-cut": { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } } },
      sessions: [session("w", "idle")],
      perSlice: { "01-spawn-f3-s6-cut": { recentOutput: { output: "" }, pr: clearPr({ human_approval_count: 0 }) } },
    });
    state.mergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "pr-auto-merge"]);
  });

  it("does NOT relax a non-cut PR under a cut-only policy", () => {
    const state = allClearState({ human_approval_count: 0 }, { command: "smithy.forge" });
    state.mergePolicy = { byTaskType: { cut: { approval: false } } };
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("does NOT auto-merge without a head_sha to pin", () => {
    const state = allClearState({ human_approval_count: 1, head_sha: null });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("does NOT auto-merge unless GitHub's merge state is clean", () => {
    for (const mss of ["blocked", "behind", "draft", "unstable", "unknown", null]) {
      const state = allClearState({ human_approval_count: 1, merge_state_status: mss });
      expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
    }
  });

  it("apply pr-auto-merge calls mergePr with the pinned head SHA and marks the slice merged", async () => {
    const slice = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 }, command: "smithy.cut" };
    const state = loopState({ slices: { s: slice } });
    const mergePr = vi.fn(async () => ({ merged: true, mergeSha: "deadbeef" }));
    const d: BabysitDecision = { kind: "pr-auto-merge", sliceId: "s", sessionId: "w", pr: { number: 5, url: "u", head_sha: "abc123" }, key: "k" };
    const res = await apply([d], ctx(), state, deps({ mergePr }));
    expect(mergePr).toHaveBeenCalledWith({ prNumber: 5, headSha: "abc123", repoPath: "/repo" });
    expect((state.slices.s as any).stage).toBe("merged");
    expect((state.slices.s as any).pr.state).toBe("MERGED");
    expect(res.actions.map((a) => a.action)).toContain("pr-auto-merge");
  });

  it("apply pr-auto-merge escalates and does not advance stage when the merge fails", async () => {
    const slice = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 }, command: "smithy.cut" };
    const state = loopState({ slices: { s: slice } });
    const mergePr = vi.fn(async () => ({ merged: false, error: "head sha mismatch" }));
    const requestJudgement = vi.fn(async (input) => ({ kind: "processor_request", ...input }));
    const d: BabysitDecision = { kind: "pr-auto-merge", sliceId: "s", sessionId: "w", pr: { number: 5, url: "u", head_sha: "abc123" }, key: "k" };
    await apply([d], ctx(), state, deps({ mergePr, requestJudgement }));
    expect((state.slices.s as any).stage).toBe("pr-open");
    expect(requestJudgement).toHaveBeenCalledWith(expect.objectContaining({ reason: "auto_merge_failed" }));
  });

  it("apply pr-auto-merge escalates when no merge seam is configured", async () => {
    const slice = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const requestJudgement = vi.fn(async (input) => ({ kind: "processor_request", ...input }));
    const d: BabysitDecision = { kind: "pr-auto-merge", sliceId: "s", sessionId: "w", pr: { number: 5, url: "u", head_sha: "abc123" }, key: "k" };
    await apply([d], ctx(), state, deps({ mergePr: undefined, requestJudgement }));
    expect(requestJudgement).toHaveBeenCalledWith(expect.objectContaining({ reason: "auto_merge_unconfigured" }));
  });
});

describe("babysit apply", () => {
  it("conflict-fix sends the prompt, advances stage, records the action", async () => {
    const slice = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const c = ctx();
    const d = deps();
    const res = await apply([{ kind: "conflict-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "MSG" }], c, state, d);
    expect(d.sendMessage).toHaveBeenCalledWith("w", "MSG", "s");
    expect(slice.stage).toBe("pr-resolving-conflicts");
    expect((slice as any).last_processor_action_key).toBe("k");
    expect(res.actions[0]).toMatchObject({ action: "conflict-fix" });
    // #175: a Herald slice.stage.changed transition event accompanies the move.
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "pr-resolving-conflicts" });
  });

  it("ci-fix sends the prompt, advances stage, counts the round (#303)", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const c = ctx();
    const d = deps();
    const res = await apply([{ kind: "ci-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "MSG", detail: "x" }], c, state, d);
    expect(d.sendMessage).toHaveBeenCalledWith("w", "MSG", "s");
    expect(slice.stage).toBe("pr-in-rerun");
    expect(slice.ci_fix_rounds).toBe(1);
    expect(slice.last_processor_action_key).toBe("k");
    expect(res.actions[0]).toMatchObject({ action: "ci-fix" });
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "pr-in-rerun" });
  });

  it("ci-fix that fails to send escalates instead of advancing stage or counting a round (#303)", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const res = await apply([{ kind: "ci-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "M", detail: "x" }], ctx(), state, d);
    expect(slice.stage).toBe("pr-open"); // not advanced
    expect(slice.ci_fix_rounds).toBeUndefined(); // round not counted
    expect(res.requests).toHaveLength(1);
    expect(res.actions).toHaveLength(0);
  });

  it("ci-failure escalation latches ci_fix_escalated_at so it fires once (#303)", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-in-rerun", pr: { number: 5 }, ci_fix_rounds: 2 };
    const state = loopState({ slices: { s: slice } });
    const res = await apply([{ kind: "ci-failure", sliceId: "s", sessionId: "w", pr: { number: 5 }, requestKey: "rk", detail: "d" }], ctx(), state, deps());
    expect(slice.ci_fix_escalated_at).toBe(NOW);
    expect(res.requests).toHaveLength(1);
  });

  it("review-fix that fails to send escalates instead of advancing stage", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const res = await apply([{ kind: "review-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "M", detail: "x", threadIds: ["t1"], commentIds: ["c1"] }], ctx(), state, d);
    expect(slice.stage).toBe("pr-open"); // not advanced
    expect(res.requests).toHaveLength(1);
    expect(res.actions).toHaveLength(0);
  });

  it("worker-error sets markers and fires a deduped judgement request", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open" };
    const state = loopState({ slices: { s: slice } });
    const d = deps();
    const res = await apply([{ kind: "worker-error", sliceId: "s", sessionId: "w", requestKey: "rk", detail: "d" }], ctx(), state, d);
    expect(slice.worker_error_detected_at).toBe(NOW);
    expect(d.requestJudgement).toHaveBeenCalled();
    expect(res.requests).toHaveLength(1);
  });

  it("steward-nudge (no alert) sends the prod and records only a steward-nudge action", async () => {
    const slice: any = { worker_session_id: "w", stage: "implementing" };
    const state = loopState({ slices: { s: slice } });
    const d = deps();
    const res = await apply(
      [{ kind: "steward-nudge", sliceId: "s", sessionId: "w", nudge: true, alert: false, nextCount: 1, detail: "n", alertRequestKey: "ak", alertDetail: "ad" }],
      ctx(),
      state,
      d,
    );
    expect(d.sendMessage).toHaveBeenCalledWith("w", expect.any(String), "s");
    expect(slice.steward_nudge_count).toBe(1);
    expect(res.actions.map((a) => a.action)).toEqual(["steward-nudge"]);
    expect(res.requests).toHaveLength(0);
  });

  it("steward-nudge does NOT record an action when the send fails (no phantom nudges)", async () => {
    const slice: any = { worker_session_id: "w", stage: "implementing" };
    const state = loopState({ slices: { s: slice } });
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error("castra down");
      }),
    });
    const res = await apply(
      [{ kind: "steward-nudge", sliceId: "s", sessionId: "w", nudge: true, alert: false, nextCount: 1, detail: "n", alertRequestKey: "ak", alertDetail: "ad" }],
      ctx(),
      state,
      d,
    );
    // Send threw → no nudge counted, counters untouched; the next tick retries.
    expect(res.actions).toHaveLength(0);
    expect(slice.steward_nudge_count).toBeUndefined();
    expect(slice.steward_nudge_sent_at).toBeUndefined();
  });

  it("steward-nudge with alert records nudge + a distinct steward-stranded escalation", async () => {
    const slice: any = { worker_session_id: "w", stage: "implementing" };
    const state = loopState({ slices: { s: slice } });
    const d = deps();
    const res = await apply(
      [{ kind: "steward-nudge", sliceId: "s", sessionId: "w", nudge: true, alert: true, nextCount: 2, detail: "n", alertRequestKey: "ak", alertDetail: "ad" }],
      ctx(),
      state,
      d,
    );
    expect(slice.steward_stranded_escalated_at).toBe(NOW);
    expect(res.actions.map((a) => a.action)).toEqual(["steward-nudge", "steward-stranded"]);
    // The escalation fires a deduped judgement request for the operator.
    expect(d.requestJudgement).toHaveBeenCalled();
    expect(res.requests).toHaveLength(1);
  });
});

// #224: review-fix must dedup by review-comment id, not last_comment_at, so a
// steward addressing a thread (push + reply) cannot re-arm /smithy.fix forever.
describe("babysit review-fix comment-id dedup (#224)", () => {
  const prWith = (over: Record<string, any>) => ({
    number: 5,
    state: "OPEN",
    mergeable: "MERGEABLE",
    checks: "PASS",
    ...over,
  });
  const reviewState = (sliceOver: Record<string, any>, threads: any[], status = "idle") =>
    loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 }, pr_open_at: T_30M_AGO, ...sliceOver } },
      sessions: [session("w", status)],
      perSlice: { s: { recentOutput: { output: "" }, pr: prWith({ unresolved_threads: threads }) } },
    });

  it("does not re-fire when every needed-thread comment id is already seen", () => {
    // The thread is still unresolved + needs_response, but its only comment was
    // already dispatched for (the steward fixed/declined + replied, no new id).
    const state = reviewState(
      { review_fix_seen_comment_ids: ["c1"] },
      [{ id: "t1", needs_response: true, comment_ids: ["c1"] }],
    );
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("treats the steward's own reply (a seen id) as no new work", () => {
    // c2 is the steward's reply; both ids are already in the seen set, so the
    // reply does not re-arm the dispatch for the thread.
    const state = reviewState(
      { review_fix_seen_comment_ids: ["c1", "c2"] },
      [{ id: "t1", needs_response: true, comment_ids: ["c1", "c2"] }],
    );
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("re-fires only for a genuinely new (unseen) comment id", () => {
    const state = reviewState(
      { review_fix_seen_comment_ids: ["c1"] },
      [{ id: "t1", needs_response: true, comment_ids: ["c1", "c2"] }],
    );
    const ds = assess(state);
    expect(kindsOf(ds)).toEqual(["pr-snapshot", "review-fix"]);
    expect(ds.find((d) => d.kind === "review-fix")).toMatchObject({ threadIds: ["t1"] });
  });

  it("falls back to the thread id as the comment id when comment_ids is absent", () => {
    // First dispatch (nothing seen) still fires for a legacy thread shape.
    const state = reviewState({}, [{ id: "t1", needs_response: true }]);
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "review-fix"]);
  });

  it("pr-snapshot does NOT mark comments seen (only a successful dispatch does)", async () => {
    // Regression for the P1 (#227 review): seen must not be set speculatively in
    // snapshot() before the review-fix send, or a transient send failure drops work.
    const slice: any = { worker_session_id: "w", stage: "pr-open" };
    const state = loopState({ slices: { s: slice } });
    await apply(
      [{ kind: "pr-snapshot", sliceId: "s", pr: { number: 5, unresolved_threads: [{ id: "t1", comment_ids: ["c1", "c2"] }] } }],
      ctx(),
      state,
      deps(),
    );
    expect(slice.review_fix_seen_comment_ids).toBeUndefined();
  });

  it("review-fix folds dispatched comment ids into the seen set on a successful send", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open", review_fix_seen_comment_ids: ["c0"] };
    const state = loopState({ slices: { s: slice } });
    await apply(
      [{ kind: "review-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "M", detail: "x", threadIds: ["t1"], commentIds: ["c1", "c2"] }],
      ctx(),
      state,
      deps(),
    );
    expect(slice.review_fix_seen_comment_ids).toEqual(["c0", "c1", "c2"]);
  });

  it("review-fix does NOT mark comments seen when the send fails (retries next tick)", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open" };
    const state = loopState({ slices: { s: slice } });
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error("castra down");
      }),
    });
    const res = await apply(
      [{ kind: "review-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "M", detail: "x", threadIds: ["t1"], commentIds: ["c1", "c2"] }],
      ctx(),
      state,
      d,
    );
    // Send threw → comments are not "seen", the round is not counted, and the
    // failure is escalated; the next tick can re-dispatch the same comments.
    expect(slice.review_fix_seen_comment_ids).toBeUndefined();
    expect(slice.review_fix_rounds).toBeUndefined();
    expect(res.requests).toHaveLength(1);
  });

  it("review-fix apply counts a distinct round per dispatched thread", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open", review_fix_rounds: { t1: 1 } };
    const state = loopState({ slices: { s: slice } });
    await apply(
      [{ kind: "review-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "M", detail: "x", threadIds: ["t1", "t2"], commentIds: ["c1", "c2"] }],
      ctx(),
      state,
      deps(),
    );
    expect(slice.review_fix_rounds).toEqual({ t1: 2, t2: 1 });
  });

  it("escalates instead of re-dispatching once a thread hits the round cap", () => {
    // c2 is new, but t1 already had 3 rounds → escalate to operator, no dispatch.
    const state = reviewState(
      { review_fix_seen_comment_ids: ["c1"], review_fix_rounds: { t1: 3 } },
      [{ id: "t1", needs_response: true, comment_ids: ["c1", "c2"] }],
    );
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "review-fix-exhausted"]);
  });

  it("review-fix-exhausted fires a judgement request and latches the escalation", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-in-fix" };
    const state = loopState({ slices: { s: slice } });
    const d = deps();
    const res = await apply(
      [{ kind: "review-fix-exhausted", sliceId: "s", sessionId: "w", pr: { number: 5 }, requestKey: "rk", reason: "review_fix_rounds_exhausted", detail: "x", commentIds: ["c1"] }],
      ctx(),
      state,
      d,
    );
    expect(slice.review_fix_escalated_at).toBe(NOW);
    expect(d.requestJudgement).toHaveBeenCalled();
    expect(res.requests).toHaveLength(1);
  });

  it("re-nudges a parked worker after a real review-fix dispatch with no new comments", () => {
    const state = reviewState(
      { stage: "pr-in-fix", review_fix_seen_comment_ids: ["c1"], last_processor_action: "review-fix", last_processor_action_key: "rk", last_processor_action_at: T_30M_AGO },
      [{ id: "t1", needs_response: true, comment_ids: ["c1"] }],
    );
    expect(assess(state).find((d) => d.kind === "post-dispatch-nudge")).toMatchObject({ count: 1 });
  });

  it("does NOT re-nudge when the last action was not a review-fix (fixed+replied steady state)", () => {
    // Worker idle, threads seen, but the loop never dispatched a review-fix for
    // this set — so it must not start poking /smithy.fix.
    const state = reviewState(
      { review_fix_seen_comment_ids: ["c1"], last_processor_action: "pr-open", last_processor_action_at: T_30M_AGO },
      [{ id: "t1", needs_response: true, comment_ids: ["c1"] }],
    );
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("does not babysit review threads on a MERGED PR", () => {
    const state = reviewState(
      {},
      [{ id: "t1", needs_response: true, comment_ids: ["c1"] }],
    );
    (state.perSlice.s.pr as any).state = "MERGED";
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot"]);
  });

  it("pr-open-clear resets the per-thread round budget and clears the escalation latch", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-in-fix", review_fix_rounds: { t1: 3 }, review_fix_escalated_at: T_30M_AGO };
    const state = loopState({ slices: { s: slice } });
    await apply([{ kind: "pr-open-clear", sliceId: "s", sessionId: "w", pr: { number: 5 } }], ctx(), state, deps());
    expect(slice.review_fix_rounds).toBeUndefined();
    expect(slice.review_fix_escalated_at).toBeUndefined();
  });
});
