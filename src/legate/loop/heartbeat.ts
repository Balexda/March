import type { CoordinatorOutput } from "./coordinator.js";
import { formatBabysitActionLine, formatCleanupFailureLine, formatCleanupLine } from "./pure/format.js";

/**
 * The per-tick driver's output stage. The coordinator does the work and returns
 * counts + per-handler results; the heartbeat turns that into the durable
 * record: it builds the heartbeat NDJSON record (the surface /status reads),
 * appends every handler's action/failure events to the processor event + log
 * streams, snapshots the record for the HTTP server, and folds the metrics.
 *
 * All I/O is injected via {@link HeartbeatDeps} so the assembly is unit-testable;
 * the format helpers are the same pure functions the monolith used.
 */

export interface HeartbeatDeps {
  meta: { processor_name: string; paired_legate: string; processor_events_path: string; processor_log_path: string };
  heartbeatEventsPath: string;
  heartbeatLogPath: string;
  append: (path: string, event: any) => void;
  appendText: (path: string, line: string) => void;
  appendTextSilent: (path: string, line: string) => void;
  /** Snapshot the record for the HTTP /status endpoint. */
  setLastHeartbeat?: (record: any) => void;
  /** Fold the record into the OTel heartbeat metrics. */
  recordMetrics?: (record: any) => void;
}

/** Pure: the heartbeat NDJSON record (same field set as the pre-refactor loop). */
export function buildHeartbeatRecord(out: CoordinatorOutput, meta: { processor_name: string; paired_legate: string }): any {
  const t = out.tick;
  return {
    schema_version: 1,
    ts: t.ts,
    processor: meta.processor_name,
    paired_legate: meta.paired_legate,
    kind: "heartbeat",
    mode: "terminal-pr-maintenance",
    state_present: t.statePresent,
    state_error: t.stateError,
    slice_count: t.sliceCount,
    archived_slice_count: t.archivedSliceCount,
    workers: t.workers,
    cleanup_count: t.cleanupCount,
    cleanup_failure_count: t.cleanupFailureCount,
    ghost_cleanup_count: t.ghostCleanupCount,
    relaunch_count: t.relaunchCount,
    babysit_action_count: t.babysitActionCount,
    steward_nudge_count: t.stewardNudgeCount,
    steward_stranded_count: t.stewardStrandedCount,
    processor_request_count: t.processorRequestCount,
    dispatch_action_count: t.dispatchActionCount,
    dispatch_failure_count: t.dispatchFailureCount,
    dispatchable_count: t.queue.dispatchable,
    blocked_count: t.queue.blocked,
    pending_total: t.queue.total,
    slices_by_stage: t.slicesByStage,
    ready_to_merge_count: t.readyToMergeCount,
    escalated_by_reason: t.escalatedByReason,
  };
}

export function runHeartbeat(out: CoordinatorOutput, deps: HeartbeatDeps): any {
  const { meta } = deps;
  const ts = out.tick.ts;
  const base = { schema_version: 1, ts, processor: meta.processor_name, paired_legate: meta.paired_legate };
  const event = (path: string, e: any) => deps.append(path, e);
  const log = (line: string) => deps.appendText(meta.processor_log_path, line);

  const record = buildHeartbeatRecord(out, meta);
  deps.append(deps.heartbeatEventsPath, record);
  deps.setLastHeartbeat?.(record);

  // cleanup actions are already full event objects.
  for (const cleanup of out.results.cleanup.actions) {
    event(meta.processor_events_path, cleanup);
    log(formatCleanupLine(cleanup));
  }
  for (const failure of out.results.cleanup.failures) {
    event(meta.processor_events_path, { ...base, kind: "cleanup_failure", ...failure });
    log(formatCleanupFailureLine({ ts, ...failure }));
  }
  for (const a of out.results.ghost.actions) {
    event(meta.processor_events_path, { ...base, kind: "ghost_cleanup", action: a.action, session_id: a.sessionId, title: a.title, detail: a.detail });
    log("[" + ts + "] " + a.action + " " + a.sessionId + " " + (a.title || "") + ": " + a.detail);
  }
  // castra-recover runs after ghost-cleanup and before relaunch; keep its
  // action-log ordering consistent with the handler order within the tick.
  for (const a of out.results.castraRecover.actions) {
    event(meta.processor_events_path, { ...base, kind: "castra_recover", action: a.action, session_id: a.sessionId, detail: a.detail });
    log("[" + ts + "] " + a.action + " " + (a.sessionId || "") + ": " + a.detail);
  }
  for (const failure of out.results.castraRecover.failures) {
    event(meta.processor_events_path, { ...base, kind: "castra_recover_failure", action: failure.action, session_id: failure.sessionId, detail: failure.detail });
    log("[" + ts + "] castra-recover failed " + (failure.sessionId || "") + ": " + failure.detail);
  }
  for (const a of out.results.relaunch.actions) {
    event(meta.processor_events_path, { ...base, kind: "steward_relaunch", action: a.action, slice_id: a.sliceId, session_id: a.sessionId, detail: a.detail });
    log("[" + ts + "] " + a.action + " " + a.sliceId + ": " + a.detail);
  }
  for (const a of out.results.babysit.actions) {
    const e = { ...base, kind: "babysit_action", action: a.action, slice_id: a.sliceId, session_id: a.sessionId, pr_number: a.pr?.number ?? null, pr_url: a.pr?.url ?? null, detail: a.detail };
    event(meta.processor_events_path, e);
    log(formatBabysitActionLine(e));
  }
  for (const failure of out.results.babysit.failures) {
    event(meta.processor_events_path, { ...base, kind: "babysit_failure", ...failure });
    log(`[${ts}] babysit failed ${failure.slice_id || "unknown"}: ${failure.error}`);
  }
  // recovery runs before dispatch in the pipeline; append its actions here so the
  // action-log ordering matches the handler order within the tick (#238).
  for (const a of out.results.recovery.actions) {
    event(meta.processor_events_path, { ...base, kind: "slice_recovery", action: a.action, slice_id: a.sliceId, detail: a.detail });
    log("[" + ts + "] " + a.action + " " + a.sliceId + ": " + a.detail);
  }
  // #173 adopt-from-fold runs between recovery and dispatch; keep its action-log
  // ordering consistent with the handler order within the tick.
  for (const a of out.results.adoptFromFold.actions) {
    event(meta.processor_events_path, { ...base, kind: "adopt_from_fold", action: a.action, slice_id: a.sliceId, session_id: a.sessionId, detail: a.detail });
    log("[" + ts + "] " + a.action + " " + a.sliceId + ": " + a.detail);
  }
  for (const a of out.results.dispatch.actions) {
    const isRecovery = a.action === "recovery_dispatch" || a.action === "direct_dispatch";
    const prefix = a.action === "recovery_dispatch" ? "recovery-dispatch" : a.action === "direct_dispatch" ? "direct-dispatch" : "dispatch";
    event(meta.processor_events_path, { ...base, kind: isRecovery ? "recovery_dispatch" : "dispatch_action", action: a.action, slice_id: a.sliceId, session_id: a.sessionId, detail: a.detail });
    log("[" + ts + "] " + prefix + " " + a.sliceId + ": " + a.detail);
  }

  deps.appendTextSilent(
    deps.heartbeatLogPath,
    `[${ts}] heartbeat slice_count=${record.slice_count} archived=${record.archived_slice_count} cleanups=${record.cleanup_count} ghost_cleanups=${record.ghost_cleanup_count} relaunches=${record.relaunch_count} babysit_actions=${record.babysit_action_count} steward_nudges=${record.steward_nudge_count} steward_stranded=${record.steward_stranded_count} dispatches=${record.dispatch_action_count} processor_requests=${record.processor_request_count} workers=${JSON.stringify(record.workers)}${record.state_error ? " state_error=" + record.state_error : ""}`,
  );

  deps.recordMetrics?.(record);
  return record;
}
