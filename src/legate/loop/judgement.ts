import { formatProcessorRequestLine } from "./pure/format.js";

/**
 * Legate-judgement requests (#144, extracted from runtime.ts). When a handler
 * can't proceed deterministically it asks the legate agent to look: this builds
 * the `processor_request` event, records it to the action logs, rings the
 * doorbell, and dedups so the same request fires once per distinct failure.
 * The I/O (log appends, doorbell) is injected so the logic is unit-testable;
 * runtime.ts supplies the concrete sinks.
 */

export interface JudgementInput {
  ts: string;
  /** The slice this request is about; mutated to record the dedup key (optional). */
  slice?: any;
  /** Dedup key — when it matches the slice's last request key, this is a no-op. */
  requestKey?: string;
  sliceId?: string;
  sessionId?: string | null;
  pr?: { number?: number | null } | null;
  prNumber?: number | null;
  reason: string;
  detail: string;
}

export interface JudgementDeps {
  processorName: string;
  pairedLegate: string;
  /** Append the event to the durable processor-requests log. */
  appendRequest: (event: any) => void;
  /** Append the event to the action-event log (drives OTel span/log side-effects). */
  appendEvent: (event: any) => void;
  /** Ring the legate doorbell; resolves true when delivered. */
  sendDoorbell: () => Promise<boolean>;
  /** Append a human-readable line to the processor log. */
  log: (line: string) => void;
}

/**
 * Request a legate judgement. Returns the emitted event, or `null` when the
 * request is a duplicate (the slice already carries this `requestKey`). On a
 * fresh request it records the event to both logs, rings the doorbell (noting a
 * delivery failure in the log line), and stamps the dedup key on the slice.
 */
export async function requestJudgement(input: JudgementInput, deps: JudgementDeps): Promise<any | null> {
  if (input.slice && input.requestKey && input.slice.last_processor_request_key === input.requestKey) {
    return null;
  }
  const event = {
    schema_version: 1,
    ts: input.ts,
    processor: deps.processorName,
    paired_legate: deps.pairedLegate,
    kind: "processor_request",
    slice_id: input.sliceId,
    session_id: input.sessionId || null,
    pr_number: input.pr?.number ?? input.prNumber ?? null,
    reason: input.reason,
    detail: input.detail,
  };
  deps.appendRequest(event);
  deps.appendEvent(event);
  const delivered = await deps.sendDoorbell();
  deps.log(`${formatProcessorRequestLine(event)}${delivered ? "" : " (doorbell delivery failed)"}`);
  if (input.slice && input.requestKey) {
    input.slice.last_processor_request_key = input.requestKey;
    input.slice.last_processor_request_at = input.ts;
  }
  return event;
}
