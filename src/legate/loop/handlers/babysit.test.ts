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

  it("escalates a CI failure for legate judgement", async () => {
    const state = loopState({
      slices: { s: { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } } },
      sessions: [session("w", "idle")],
      perSlice: { s: { recentOutput: { output: "" }, pr: { number: 5, state: "OPEN", mergeable: "MERGEABLE", checks: "FAIL", needs_response_count: 0 } } },
    });
    expect(kindsOf(assess(state))).toEqual(["pr-snapshot", "ci-failure"]);
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

describe("babysit apply", () => {
  it("conflict-fix sends the prompt, advances stage, records the action", async () => {
    const slice = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const c = ctx();
    const d = deps();
    const res = await apply([{ kind: "conflict-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "MSG" }], c, state, d);
    expect(d.sendMessage).toHaveBeenCalledWith("w", "MSG");
    expect(slice.stage).toBe("pr-resolving-conflicts");
    expect((slice as any).last_processor_action_key).toBe("k");
    expect(res.actions[0]).toMatchObject({ action: "conflict-fix" });
    // #175: a Herald slice.stage.changed transition event accompanies the move.
    expect(c.emitTransition).toHaveBeenCalledWith({ type: "slice.stage.changed", sliceId: "s", stage: "pr-resolving-conflicts" });
  });

  it("review-fix that fails to send escalates instead of advancing stage", async () => {
    const slice: any = { worker_session_id: "w", stage: "pr-open", pr: { number: 5 } };
    const state = loopState({ slices: { s: slice } });
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const res = await apply([{ kind: "review-fix", sliceId: "s", sessionId: "w", pr: { number: 5 }, key: "k", message: "M", detail: "x" }], ctx(), state, d);
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
    expect(d.sendMessage).toHaveBeenCalledWith("w", expect.any(String));
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
