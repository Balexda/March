import { formatProcessorRequestLine } from "./pure/format.js";
import { dispatchReasonCode, hatcheryGitHubCode } from "../../hatchery/dispatch-reason.js";

/**
 * The bounded Hatchery error code an escalation carries, for the log line (so
 * the operator reads "tessera:unconfigured", not just "hatchery_dispatch_failed").
 * Only the `Error:` block of a dispatch-failure detail is classified — the rest
 * of the detail is operator guidance whose wording must not match a pattern.
 * An unclassifiable dispatch error yields nothing rather than "other".
 */
export function judgementErrorCode(reason: unknown, detail: unknown): string | undefined {
  if (typeof detail !== "string") return undefined;
  const github = hatcheryGitHubCode(detail);
  if (github) return github;
  if (reason !== "hatchery_dispatch_failed") return undefined;
  const block = /(?:^|\n)Error:\n([\s\S]*?)(?:\n\n|$)/.exec(detail)?.[1];
  if (!block) return undefined;
  const code = dispatchReasonCode(block);
  return code === "other" ? undefined : code;
}

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
  // Surface Hatchery's bounded error code (e.g. tessera:unconfigured) so the log
  // line names the cause, not just the escalation reason.
  const code = judgementErrorCode(input.reason, input.detail);
  deps.log(`${formatProcessorRequestLine(event)}${code ? ` [${code}]` : ""}${delivered ? "" : " (doorbell delivery failed)"}`);
  if (input.slice && input.requestKey) {
    input.slice.last_processor_request_key = input.requestKey;
    input.slice.last_processor_request_at = input.ts;
  }
  return event;
}
