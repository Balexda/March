import { describe, expect, it, vi } from "vitest";
import { apply, assess, MAX_RECOVER_ATTEMPTS } from "./castra-recover.js";
import type { HandlerContext, LoopState } from "../state/types.js";
import type { RecoverReport, SessionRecoveryResult } from "../../../castra/types.js";

function sess(id: string, status: string, group = "legate-workers") {
  return { id, title: id, group, status };
}

function loopState(sessions: any[], over: Partial<LoopState> = {}): LoopState {
  const raw = { slices: {}, archived_slices: {}, repo: { path: "/repo" }, ...((over as any).raw || {}) };
  return {
    ts: "T",
    statePresent: true,
    stateError: null,
    raw,
    slices: raw.slices,
    archived: raw.archived_slices,
    repoPath: "/repo",
    workerGroup: "legate-workers",
    sessions,
    sessionsById: new Map(sessions.map((s) => [s.id, s])),
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    perSlice: {},
    ...over,
  };
}

function result(over: Partial<SessionRecoveryResult> & { sessionId: string }): SessionRecoveryResult {
  return {
    title: over.sessionId,
    group: "legate-workers",
    outcome: "recovered",
    pickerResolved: false,
    finalStatus: "waiting",
    ...over,
  };
}

function ctx(recoverSessions: (...a: any[]) => Promise<RecoverReport>): HandlerContext & { log: any } {
  return {
    meta: { profile: "march" } as any,
    ts: "T",
    castra: { recoverSessions: vi.fn(recoverSessions) } as any,
    broodTeardown: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  };
}

describe("castra-recover assess", () => {
  it("returns null when no worker sessions are errored", () => {
    expect(assess(loopState([sess("w1", "waiting")]))).toBeNull();
    expect(assess(loopState([]))).toBeNull();
  });

  it("targets errored worker-group sessions, ignoring other groups", () => {
    const state = loopState([
      sess("w1", "error"),
      sess("w2", "idle"),
      sess("c1", "error", "conductor"),
    ]);
    expect(assess(state)).toEqual({ group: "legate-workers", sessionIds: ["w1"] });
  });

  it("returns null once every errored session is at the attempt cap", () => {
    const state = loopState([sess("w1", "error")], {
      raw: { castra_recover_attempts: { w1: MAX_RECOVER_ATTEMPTS } },
    });
    expect(assess(state)).toBeNull();
  });

  it("still targets a session below the cap even when another is exhausted", () => {
    const state = loopState([sess("w1", "error"), sess("w2", "error")], {
      raw: { castra_recover_attempts: { w1: MAX_RECOVER_ATTEMPTS, w2: 1 } },
    });
    expect(assess(state)).toEqual({ group: "legate-workers", sessionIds: ["w2"] });
  });
});

describe("castra-recover apply", () => {
  it("is a no-op for a null decision (no Castra call)", async () => {
    const c = ctx(async () => ({ recovered: [] }));
    const res = await apply(null, c, loopState([]));
    expect(c.castra.recoverSessions).not.toHaveBeenCalled();
    expect(res).toEqual({ actions: [], failures: [], requests: [], mutated: false });
  });

  it("recovers errored workers and reflects status back into the snapshot", async () => {
    const sessions = [sess("w1", "error")];
    const state = loopState(sessions);
    const c = ctx(async () => ({ recovered: [result({ sessionId: "w1", finalStatus: "waiting" })] }));

    const res = await apply(assess(state), c, state);

    expect(c.castra.recoverSessions).toHaveBeenCalledWith("march", "legate-workers");
    // Snapshot mutated so relaunch/babysit (later) see a live session this tick.
    expect(state.sessions[0].status).toBe("waiting");
    expect(state.sessionsById.get("w1").status).toBe("waiting");
    expect(res.actions).toEqual([
      { action: "castra-recover", sessionId: "w1", detail: "recovered → waiting" },
    ]);
    // A recovered session clears its attempt budget for future re-errors.
    expect(state.raw.castra_recover_attempts.w1).toBeUndefined();
  });

  it("records the resume-from-summary path on a picker_resolved outcome", async () => {
    const state = loopState([sess("w1", "error")]);
    const c = ctx(async () => ({
      recovered: [result({ sessionId: "w1", outcome: "picker_resolved", pickerResolved: true, finalStatus: "running" })],
    }));
    const res = await apply(assess(state), c, state);
    expect(res.actions[0].detail).toBe("picker_resolved (resume-from-summary) → running");
    expect(state.sessions[0].status).toBe("running");
  });

  it("counts a still_error attempt and leaves the snapshot errored", async () => {
    const state = loopState([sess("w1", "error")]);
    const c = ctx(async () => ({
      recovered: [result({ sessionId: "w1", outcome: "still_error", finalStatus: "error" })],
    }));
    await apply(assess(state), c, state);
    expect(state.raw.castra_recover_attempts.w1).toBe(1);
    expect(state.sessions[0].status).toBe("error");
  });

  it("reports a restart_failed session as a failure", async () => {
    const state = loopState([sess("w1", "error")]);
    const c = ctx(async () => ({
      recovered: [result({ sessionId: "w1", outcome: "restart_failed", finalStatus: "error", error: "boom" })],
    }));
    const res = await apply(assess(state), c, state);
    expect(res.failures).toEqual([
      { action: "castra-recover-failed", sessionId: "w1", detail: "boom" },
    ]);
    expect(res.actions[0].detail).toBe("restart_failed → error");
  });

  it("never throws when the recovery call fails — records a sweep failure", async () => {
    const state = loopState([sess("w1", "error")]);
    const c = ctx(async () => {
      throw new Error("castra unreachable");
    });
    const res = await apply(assess(state), c, state);
    expect(res.failures).toEqual([
      { action: "castra-recover-failed", detail: "castra unreachable" },
    ]);
    expect(res.actions).toEqual([]);
  });
});
