import {
  context as otelContext,
  trace,
  TraceFlags,
  type Attributes,
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { getActiveOtel } from "./otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "./trace-ids.js";

/**
 * Structured logging for the Legate loop service. Records are emitted via the
 * OTel SDK logger (OTLP -> collector -> Loki) so they sit alongside the loop's
 * traces and metrics. The loop also keeps writing its NDJSON/text files to the
 * mounted conductor dir; this is the forwarded copy.
 *
 * Logs that correspond to a dispatched unit of work (anything with a `sliceId`)
 * carry the SAME deterministic trace/span ids the dispatch span uses
 * ({@link traceIdForDispatch}/{@link spanIdForDispatch}), so Grafana links a log
 * line to its Tempo trace. No-op when telemetry is disabled.
 */

export type LoopLogSeverity = "INFO" | "WARN" | "ERROR";

const SEVERITY: Record<LoopLogSeverity, SeverityNumber> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

export interface LoopLogInput {
  readonly severity: LoopLogSeverity;
  readonly body: string;
  /** The loop event kind (heartbeat, dispatch_action, cleanup, ...). */
  readonly eventKind?: string;
  /** When present, links this log to the dispatch trace for that slice. */
  readonly sliceId?: string;
  /** Extra low-cardinality attributes (action, pr_number, ...). */
  readonly attributes?: Attributes;
}

let defaults: { profile: string; conductor: string } = {
  profile: "unknown",
  conductor: "unknown",
};

/** Set the profile/conductor stamped on every emitted log. Call once at startup. */
export function initLoopLogs(d: { profile: string; conductor: string }): void {
  defaults = { profile: d.profile || "unknown", conductor: d.conductor || "unknown" };
}

export function emitLoopLog(input: LoopLogInput): void {
  const otel = getActiveOtel();
  if (!otel.enabled) return;

  const attributes: Attributes = {
    profile: defaults.profile,
    conductor: defaults.conductor,
    ...(input.eventKind ? { event_kind: input.eventKind } : {}),
    ...(input.sliceId ? { "march.slice_id": input.sliceId } : {}),
    ...(input.attributes ?? {}),
  };

  // Carry the deterministic dispatch ids so the log links to its trace in
  // Grafana. We attach them via a non-recording span context rather than the
  // active context, since the loop has no live span when it logs.
  let context = otelContext.active();
  if (input.sliceId) {
    context = trace.setSpanContext(context, {
      traceId: traceIdForDispatch(input.sliceId),
      spanId: spanIdForDispatch(input.sliceId),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  }

  otel.getLogger().emit({
    severityNumber: SEVERITY[input.severity],
    severityText: input.severity,
    body: input.body,
    attributes,
    context,
  });
}
