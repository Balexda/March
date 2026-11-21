/**
 * Loop telemetry mapping (#144) — turn the loop's domain records into the
 * OpenTelemetry payloads the SDK consumes: action-log events → spans + structured
 * logs, and the per-tick heartbeat record → the loop-metrics activity. Extracted
 * from runtime.ts so the mapping is tested in isolation and the runtime side is
 * one-liner wiring.
 *
 * The actual OTel emit (SDK tracer / OTLP→Loki logger / meter) lives in
 * src/observability/{loop-spans,logs,loop-metrics}.ts and is a no-op when
 * telemetry is off; the span/log emitters are injectable so this maps cleanly
 * under test without standing up the SDK.
 */
import { emitLoopSpan as defaultEmitLoopSpan } from "../../observability/loop-spans.js";
import { emitLoopLog as defaultEmitLoopLog, type LoopLogSeverity } from "../../observability/logs.js";
import {
  recordDependencyUnblock as defaultRecordDependencyUnblock,
  recordReviewRequest as defaultRecordReviewRequest,
  recordReviewRateLimit as defaultRecordReviewRateLimit,
  recordPrLabel as defaultRecordPrLabel,
  type PrLabelOp,
  type DependencyUnblockOutcome,
  type LoopMetricsSnapshot,
  type LoopTickActivity,
} from "../../observability/loop-metrics.js";

export type LoopSpanEmitter = typeof defaultEmitLoopSpan;
export type LoopLogEmitter = typeof defaultEmitLoopLog;

/** The Dependabot conflict-ladder action → its metric outcome, or null for any other action. */
const DEPENDENCY_UNBLOCK_OUTCOMES: Record<string, DependencyUnblockOutcome> = {
  "dependency-recreate-requested": "recreate_requested",
  "dependency-recreate-failed": "recreate_failed",
  "dependency-unblock-escalated": "escalated",
  "dependency-unblock-escalate-failed": "escalate_failed",
  "dependency-unblock-resolved": "resolved",
};

export function dependencyUnblockOutcome(action: string): DependencyUnblockOutcome | null {
  return Object.prototype.hasOwnProperty.call(DEPENDENCY_UNBLOCK_OUTCOMES, action)
    ? DEPENDENCY_UNBLOCK_OUTCOMES[action]
    : null;
}

/**
 * Fold one action-log event into the event-driven loop counters: the Dependabot
 * conflict ladder's outcome counter (#573) and the review request counter.
 * The per-tick counters come from the heartbeat instead ({@link buildLoopTickActivity}).
 */
export function recordActionEventMetrics(
  event: any,
  record: typeof defaultRecordDependencyUnblock = defaultRecordDependencyUnblock,
  recordReview: typeof defaultRecordReviewRequest = defaultRecordReviewRequest,
  recordRateLimit: typeof defaultRecordReviewRateLimit = defaultRecordReviewRateLimit,
  recordLabel: typeof defaultRecordPrLabel = defaultRecordPrLabel,
): void {
  if (!event || typeof event !== "object") return;
  if (event.kind === "pr_label" || event.kind === "pr_label_failure") {
    const action = typeof event.action === "string" ? event.action : "";
    const op: PrLabelOp = action === "pr-label-added" ? "add" : action === "pr-label-removed" ? "remove" : "unknown";
    // Failure detail is "label: message"; success detail is the bare label.
    const known = String(event.detail ?? "").split(": ")[0];
    recordLabel(known, op, event.kind === "pr_label" ? "ok" : "failed", event.processor ? String(event.processor) : undefined);
    return;
  }
  if (event.kind === "review_request") {
    const reviewer = event.reviewer === "copilot" ? "copilot" : "coderabbit";
    recordReview(reviewer, event.outcome);
    if (event.rate_limit_hit === true) recordRateLimit(reviewer);
    return;
  }
  if (event.kind !== "dependency_merge" && event.kind !== "dependency_merge_failure") return;
  const outcome = dependencyUnblockOutcome(typeof event.action === "string" ? event.action : "");
  if (outcome) record(outcome, event.processor ? String(event.processor) : undefined);
}

/**
 * Classify one action-log event into a dispatch-lifecycle span. Each dispatched
 * unit of work is its own trace (trace id = hash(slice id)) so these loop spans
 * share a trace with the orchestrator's hatchery.spawn / spawn.* spans (same
 * deterministic ids). `legate.dispatch` is the root and claims the deterministic
 * span id so the orchestrator spans nest beneath it; babysit/cleanup nest as
 * children of that same parent. loop-spans.ts derives those ids from the slice id
 * via the shared trace-ids.ts helpers (CLAUDE.md cross-process contract), so this
 * layer only classifies events into spans.
 */
export function emitActionEventSpan(event: any, emit: LoopSpanEmitter = defaultEmitLoopSpan): void {
  if (!event || typeof event !== "object") return;

  // Ghost-steward cleanup isn't tied to a slice, so it keys its trace off the
  // session id — the same key the runtime gives brood.teardown — so the two share
  // one trace (siblings under the deterministic session anchor) instead of each
  // orphaning a separate root. Handled before the slice-id guard since the event
  // carries no slice_id. A `*-failed` action marks the span errored.
  if (event.kind === "ghost_cleanup") {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const failed = typeof event.action === "string" && event.action.endsWith("-failed");
    emit({
      name: "legate.ghost-cleanup",
      traceKey: String(sessionId),
      root: false,
      error: failed,
      attributes: { "march.session_id": String(sessionId), "march.action": event.action || "" },
    });
    return;
  }

  // Dependabot auto-merge is not tied to a slice either (these PRs are never
  // dispatched), so each PR gets its own small trace keyed by repo-loop + PR
  // number. A `*-failed` action marks the span errored; a failed listing has no
  // PR and keys off the loop alone.
  // The conflict ladder's actions (#573) share the PR's trace under their own span
  // name; an escalation (the ladder gave up) is errored like a failure.
  if (event.kind === "dependency_merge" || event.kind === "dependency_merge_failure") {
    const pr = event.pr_number;
    const scope = String(event.processor || "legate");
    const action = typeof event.action === "string" ? event.action : "";
    const unblock = dependencyUnblockOutcome(action) !== null;
    const failed = action.endsWith("-failed") || action === "dependency-unblock-escalated";
    emit({
      name: unblock ? "legate.dependency-unblock" : "legate.dependency-merge",
      traceKey: pr != null ? `${scope}-dependency-pr-${pr}` : `${scope}-dependency-merge`,
      root: true,
      error: failed,
      attributes: { "march.action": event.action || "", ...(pr != null ? { "march.pr_number": Number(pr) } : {}) },
    });
    return;
  }

  // Owned PR-label reconciliation: slice-linked PRs nest on the slice's trace;
  // others get a small per-loop trace. A failed label write marks the span errored.
  if (event.kind === "pr_label" || event.kind === "pr_label_failure") {
    const pr = event.pr_number;
    emit({
      name: "legate.pr-label",
      traceKey: event.slice_id ? String(event.slice_id) : `${String(event.processor || "legate")}-pr-labels`,
      root: false,
      error: event.kind === "pr_label_failure",
      attributes: {
        "march.action": event.action || "",
        ...(event.slice_id ? { "march.slice_id": String(event.slice_id) } : {}),
        ...(pr != null ? { "march.pr_number": Number(pr) } : {}),
      },
    });
    return;
  }

  const sliceId = event.slice_id;
  if (!sliceId) return;
  if (event.kind === "dispatch_action" && event.action === "dispatch") {
    emit({ name: "legate.dispatch", traceKey: sliceId, root: true, attributes: { "march.slice_id": sliceId, "march.action": event.action, "march.dispatch_mode": "spawn" } });
  } else if (event.kind === "recovery_dispatch") {
    // Replay-only since #144 removed the recovery/direct-steward machinery, but
    // kept so a pre-#144 action log still classifies. Each recovery codex spawn
    // and each no-spawn direct-steward dispatch is its own dispatched unit of
    // work, keyed off its recovery-/direct-suffixed slice id; like a normal
    // dispatch it is the root span so its hatchery.spawn / spawn.* spans nest
    // beneath it (direct_dispatch has no spawn but stays uniform as a trace).
    const mode = event.action === "direct_dispatch" ? "direct_steward" : "recovery";
    emit({ name: "legate.dispatch", traceKey: sliceId, root: true, attributes: { "march.slice_id": sliceId, "march.action": event.action || "", "march.dispatch_mode": mode } });
  } else if (event.kind === "dispatch_failure") {
    // launchDispatch threw, so the spawn never ran and the orchestrator never
    // emits hatchery.spawn / the spawn metrics. Record the failed launch as an
    // errored root span so the dispatch still surfaces — as a failed trace.
    emit({ name: "legate.dispatch", traceKey: sliceId, root: true, error: true, attributes: { "march.slice_id": sliceId, "march.action": "dispatch", "march.dispatch_mode": "spawn", "march.error": event.error || "dispatch launch failed" } });
  } else if (event.kind === "babysit_action") {
    emit({ name: "legate.babysit", traceKey: sliceId, root: false, attributes: { "march.slice_id": sliceId, "march.action": event.action || "", "march.pr_number": event.pr_number || "" } });
  } else if (event.kind === "review_request") {
    emit({
      name: "legate.review.request",
      traceKey: sliceId,
      root: false,
      error: event.outcome === "failed" || event.outcome === "cap_exhausted" || event.outcome === "identity_unavailable",
      attributes: {
        "march.slice_id": sliceId,
        "march.task_type": event.task_type ?? "forge",
        "march.review.reviewer": event.reviewer === "copilot" ? "copilot" : "coderabbit",
        "march.review.outcome": event.outcome,
        "march.review.reason": event.reason,
      },
    });
  } else if (event.kind === "cleanup") {
    emit({ name: "legate.cleanup", traceKey: sliceId, root: false, attributes: { "march.slice_id": sliceId, "march.pr_state": event.pr_state || "" } });
  } else if (event.kind === "requeue") {
    // Operator requeue (#588/#593) is a lifecycle action on the slice's dispatch,
    // nested under its deterministic parent; a refused or failed requeue marks
    // the span errored so the slice trace shows where it stalled.
    const action = typeof event.action === "string" ? event.action : "";
    emit({
      name: "legate.requeue",
      traceKey: sliceId,
      root: false,
      error: action !== "requeue-done",
      attributes: {
        "march.slice_id": sliceId,
        "march.action": action,
        ...(event.session_id ? { "march.session_id": String(event.session_id) } : {}),
        ...(event.operator ? { "march.operator": String(event.operator) } : {}),
        ...(event.archived ? { "march.requeue.archived": true, "march.pr_state": String(event.terminal ?? "") } : {}),
      },
    });
  } else if (event.kind === "operator-merge") {
    // Operator merge-now execution (#593), nested under the slice's dispatch. The
    // API's legate.operator.merge span only records acceptance; this records what
    // the tick actually did — a refusal or failed merge marks it errored.
    const action = typeof event.action === "string" ? event.action : "";
    emit({
      name: "legate.operator-merge",
      traceKey: sliceId,
      root: false,
      error: action !== "operator-merge",
      attributes: {
        "march.slice_id": sliceId,
        "march.action": action,
        ...(event.pr_number != null ? { "march.pr_number": Number(event.pr_number) } : {}),
        ...(action !== "operator-merge" && event.detail ? { "march.error": String(event.detail) } : {}),
      },
    });
  } else if (event.kind === "steward_relaunch") {
    // Re-launching a steward is a lifecycle action on the slice's existing
    // dispatch, so it nests under that same deterministic parent. relaunch-failed
    // marks the span errored.
    const failed = typeof event.action === "string" && event.action.endsWith("-failed");
    emit({
      name: "legate.relaunch",
      traceKey: sliceId,
      root: false,
      error: failed,
      attributes: {
        "march.slice_id": sliceId,
        "march.action": event.action || "",
        ...(event.session_id ? { "march.session_id": String(event.session_id) } : {}),
      },
    });
  }
}

/**
 * Forward one action-log event as a structured log record (OTLP → Loki). Failures
 * map to ERROR; everything else to INFO. Events with a slice_id are
 * trace-correlated to their dispatch in Grafana (see logs.ts). The per-tick
 * heartbeat is intentionally NOT logged here — it is captured by the loop metrics
 * instead — and lands on heartbeatEventsPath, not the action-log path.
 */
export function emitActionEventLog(event: any, emit: LoopLogEmitter = defaultEmitLoopLog): void {
  if (!event || typeof event !== "object" || !event.kind) return;
  const kind = String(event.kind);
  const severity: LoopLogSeverity =
    kind.endsWith("_failure") || kind === "sync_warning" || (kind === "operator-merge" && event.action !== "operator-merge") || (kind === "review_request" && ["failed", "cap_exhausted"].includes(event.outcome)) ? "ERROR" : "INFO";
  const detail =
    event.detail || event.error || event.action || event.title || "";
  emit({
    severity,
    body: detail ? kind + ": " + detail : kind,
    eventKind: kind,
    sliceId: event.slice_id || undefined,
    attributes: {
      ...(event.action ? { "march.action": String(event.action) } : {}),
      ...(event.pr_number != null
        ? { "march.pr_number": String(event.pr_number) }
        : {}),
      ...(event.session_id ? { "march.session_id": String(event.session_id) } : {}),
    },
  });
}

/** Identity for the loop-metrics series + the timing of the tick being folded. */
export interface HeartbeatMetricsContext {
  /** Deployment profile label (defaults to "unknown" when empty). */
  profile?: string;
  /** Conductor label, pre-resolved by the caller (defaults to "unknown"). */
  conductor?: string;
  /** Epoch ms of the just-completed tick (drives the tick.age gauge). */
  tickAtMs: number;
  /** Tick wall-clock duration in ms (recorded as the duration histogram, in s). */
  durationMs: number;
}

/**
 * Fold a heartbeat record into the loop-metrics {@link LoopTickActivity} payload
 * `recordLoopHeartbeat` consumes: snapshot the gauge values + workers-by-state
 * and read the per-tick counter deltas off the record. Returns `null` when there
 * is no record yet (nothing to fold). Pure — the caller does the emit.
 */
export function buildLoopTickActivity(record: any, ctx: HeartbeatMetricsContext): LoopTickActivity | null {
  if (!record) return null;
  const workersByState: Record<string, number> = {};
  if (record.workers && typeof record.workers === "object") {
    for (const [state, count] of Object.entries(record.workers)) {
      if (typeof count === "number") workersByState[state] = count;
    }
  }
  const slicesByStage: Record<string, number> = {};
  if (record.slices_by_stage && typeof record.slices_by_stage === "object") {
    for (const [stage, count] of Object.entries(record.slices_by_stage)) {
      if (typeof count === "number") slicesByStage[stage] = count;
    }
  }
  const escalatedByReason: Record<string, number> = {};
  if (record.escalated_by_reason && typeof record.escalated_by_reason === "object") {
    for (const [reason, count] of Object.entries(record.escalated_by_reason)) {
      if (typeof count === "number") escalatedByReason[reason] = count;
    }
  }
  const prBlocker: Record<string, number> = {};
  if (record.pr_blocker_counts && typeof record.pr_blocker_counts === "object") {
    for (const [reason, count] of Object.entries(record.pr_blocker_counts)) {
      if (typeof count === "number") prBlocker[reason] = count;
    }
  }
  let dispatchItems: Record<string, number> | undefined;
  if (record.dispatch_decision_counts && typeof record.dispatch_decision_counts === "object") {
    dispatchItems = {};
    for (const [decision, count] of Object.entries(record.dispatch_decision_counts)) {
      if (typeof count === "number") dispatchItems[decision] = count;
    }
  }
  const babysitActionsByKind: Record<string, number> = {};
  if (record.babysit_actions_by_kind && typeof record.babysit_actions_by_kind === "object") {
    for (const [kind, count] of Object.entries(record.babysit_actions_by_kind)) {
      if (typeof count === "number") babysitActionsByKind[kind] = count;
    }
  }
  const snapshot: LoopMetricsSnapshot = {
    profile: ctx.profile || "unknown",
    conductor: ctx.conductor || "unknown",
    up: 1,
    lastTickAtMs: ctx.tickAtMs,
    queueDispatchable: record.dispatchable_count ?? 0,
    queueDispatchableReady: record.dispatchable_ready_count ?? 0,
    queueBlocked: record.blocked_count ?? 0,
    queueTotal: record.pending_total ?? 0,
    workersByState,
    slicesByStage,
    readyToMerge: record.ready_to_merge_count ?? 0,
    waitingOnApproval: record.waiting_on_approval_count ?? 0,
    blockedOnMergeState: record.blocked_on_merge_state_count ?? 0,
    stranded: record.stranded_count ?? 0,
    recoveryRate: record.recovery_rate ?? 1,
    dispatchPaused: record.dispatch_paused ? 1 : 0,
    escalatedByReason,
    prBlocker,
    ...(dispatchItems ? { dispatchItems } : {}),
  };
  return {
    snapshot,
    tickDurationSeconds: ctx.durationMs / 1000,
    babysitActionsByKind,
    dispatchActions: record.dispatch_action_count ?? 0,
    dispatchFailures: record.dispatch_failure_count ?? 0,
    cleanups: record.cleanup_count ?? 0,
    cleanupFailures: record.cleanup_failure_count ?? 0,
    ghostCleanups: record.ghost_cleanup_count ?? 0,
    ghostCleanupFailures: record.ghost_cleanup_failure_count ?? 0,
    ghostCleanupDeferred: record.ghost_cleanup_deferred_count ?? 0,
    relaunches: record.relaunch_count ?? 0,
    relaunchFailures: record.relaunch_failure_count ?? 0,
    babysitActions: record.babysit_action_count ?? 0,
    stewardNudges: record.steward_nudge_count ?? 0,
    stewardStranded: record.steward_stranded_count ?? 0,
  };
}
