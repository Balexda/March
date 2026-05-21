/**
 * Loop telemetry mapping (#144) — classify the action-log events the loop writes
 * into OpenTelemetry spans and structured logs. Extracted from runtime.ts so the
 * mapping is tested in isolation and the runtime's append() is one-liner wiring.
 *
 * The actual OTel emit (SDK tracer / OTLP→Loki logger) lives in
 * src/observability/loop-spans.ts and src/observability/logs.ts and is a no-op
 * when telemetry is off; the emitters are injectable so this maps cleanly under
 * test without standing up the SDK.
 */
import { emitLoopSpan as defaultEmitLoopSpan } from "../../observability/loop-spans.js";
import { emitLoopLog as defaultEmitLoopLog, type LoopLogSeverity } from "../../observability/logs.js";

export type LoopSpanEmitter = typeof defaultEmitLoopSpan;
export type LoopLogEmitter = typeof defaultEmitLoopLog;

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
  } else if (event.kind === "cleanup") {
    emit({ name: "legate.cleanup", traceKey: sliceId, root: false, attributes: { "march.slice_id": sliceId, "march.pr_state": event.pr_state || "" } });
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
    kind.endsWith("_failure") || kind === "sync_warning" ? "ERROR" : "INFO";
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
