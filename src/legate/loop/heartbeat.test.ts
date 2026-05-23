import { describe, expect, it, vi } from "vitest";
import { buildHeartbeatRecord, runHeartbeat, type HeartbeatDeps } from "./heartbeat.js";
import type { CoordinatorOutput } from "./coordinator.js";
import { emptyHandlerResult } from "./state/types.js";

const META = { processor_name: "loop", paired_legate: "legate" };

function out(over: Partial<CoordinatorOutput["results"]> = {}, tickOver: any = {}): CoordinatorOutput {
  return {
    state: {} as any,
    tick: {
      ts: "T",
      statePresent: true,
      stateError: null,
      sliceCount: 2,
      archivedSliceCount: 1,
      workers: { waiting: 0, running: 1, idle: 0, error: 0, stopped: 0, other: 0 },
      queue: { dispatchable: 3, blocked: 2, total: 5 },
      slicesByStage: { implementing: 1, "pr-open": 1 },
      readyToMergeCount: 1,
      cleanupCount: 1,
      cleanupFailureCount: 0,
      ghostCleanupCount: 0,
      relaunchCount: 0,
      babysitActionCount: 1,
      stewardNudgeCount: 0,
      stewardStrandedCount: 0,
      processorRequestCount: 2,
      dispatchActionCount: 1,
      dispatchFailureCount: 0,
      ...tickOver,
    },
    results: {
      cleanup: emptyHandlerResult(),
      ghost: emptyHandlerResult(),
      relaunch: emptyHandlerResult(),
      babysit: emptyHandlerResult(),
      recovery: emptyHandlerResult(),
      dispatch: emptyHandlerResult(),
      ...over,
    },
  };
}

function deps(): HeartbeatDeps & { events: any[]; logs: string[] } {
  const events: any[] = [];
  const logs: string[] = [];
  return {
    meta: { ...META, processor_events_path: "/ev", processor_log_path: "/log" },
    heartbeatEventsPath: "/hb",
    heartbeatLogPath: "/hblog",
    append: vi.fn((_p, e) => events.push(e)),
    appendText: vi.fn((_p, l) => logs.push(l)),
    appendTextSilent: vi.fn(),
    setLastHeartbeat: vi.fn(),
    recordMetrics: vi.fn(),
    events,
    logs,
  };
}

describe("buildHeartbeatRecord", () => {
  it("maps the TickResult into the durable record shape", () => {
    const record = buildHeartbeatRecord(out({}, { stewardNudgeCount: 4, stewardStrandedCount: 1 }), META);
    expect(record).toMatchObject({
      kind: "heartbeat",
      mode: "terminal-pr-maintenance",
      slice_count: 2,
      archived_slice_count: 1,
      babysit_action_count: 1,
      steward_nudge_count: 4,
      steward_stranded_count: 1,
      processor_request_count: 2,
      dispatchable_count: 3,
      blocked_count: 2,
      pending_total: 5,
      slices_by_stage: { implementing: 1, "pr-open": 1 },
      ready_to_merge_count: 1,
    });
  });
});

describe("runHeartbeat", () => {
  it("writes the record, snapshots it, and folds metrics", () => {
    const d = deps();
    const record = runHeartbeat(out(), d);
    expect(d.append).toHaveBeenCalledWith("/hb", record);
    expect(d.setLastHeartbeat).toHaveBeenCalledWith(record);
    expect(d.recordMetrics).toHaveBeenCalledWith(record);
    expect(d.appendTextSilent).toHaveBeenCalled();
  });

  it("emits per-handler events for each action", () => {
    const cleanup = emptyHandlerResult();
    cleanup.actions.push({ ts: "T", kind: "cleanup", slice_id: "s", session_id: "x", pr_number: 9, pr_state: "MERGED" });
    const babysit = emptyHandlerResult();
    babysit.actions.push({ action: "review-fix", sliceId: "s", sessionId: "x", pr: { number: 9 }, detail: "d" });
    const dispatch = emptyHandlerResult();
    dispatch.actions.push({ action: "recovery_dispatch", sliceId: "r", sessionId: null, detail: "rd" });

    const d = deps();
    runHeartbeat(out({ cleanup, babysit, dispatch }), d);

    const kinds = d.events.map((e) => e.kind);
    expect(kinds).toContain("heartbeat");
    expect(kinds).toContain("cleanup");
    expect(kinds).toContain("babysit_action");
    expect(kinds).toContain("recovery_dispatch");
  });

  it("appends recovery actions in pipeline order: after babysit, before dispatch (#238)", () => {
    const babysit = emptyHandlerResult();
    babysit.actions.push({ action: "review-fix", sliceId: "b", sessionId: "x", pr: { number: 9 }, detail: "d" });
    const recovery = emptyHandlerResult();
    recovery.actions.push({ action: "slice-recovery", sliceId: "r", detail: "operator recovery: cleared escalated slice for fresh re-dispatch" });
    const dispatch = emptyHandlerResult();
    dispatch.actions.push({ action: "dispatch", sliceId: "d", sessionId: null, detail: "queued" });

    const d = deps();
    runHeartbeat(out({ babysit, recovery, dispatch }), d);

    const slice = d.events.find((e) => e.kind === "slice_recovery");
    expect(slice).toMatchObject({ kind: "slice_recovery", action: "slice-recovery", slice_id: "r", detail: expect.stringContaining("cleared escalated slice") });
    // Ordering: babysit_action < slice_recovery < dispatch_action in the event stream.
    const kinds = d.events.map((e) => e.kind);
    expect(kinds.indexOf("babysit_action")).toBeLessThan(kinds.indexOf("slice_recovery"));
    expect(kinds.indexOf("slice_recovery")).toBeLessThan(kinds.indexOf("dispatch_action"));
  });
});
