import {
  formatBabysitActionLine,
  formatCleanupFailureLine,
  formatCleanupLine,
  formatProcessorRequestLine,
} from "./format.js";

/**
 * Pure formatting for the startup action-event replay (#144, extracted from
 * runtime.ts). On boot the loop echoes the last few action events to stdout so a
 * revived conductor session shows recent context. This carries the parse + kind
 * filter + per-kind formatting; the runtime keeps only the file read, the
 * (now()-stamped) header, and the printing.
 */

/** Action-event kinds replayed to stdout on startup, in no particular order. */
const REPLAY_KINDS: ReadonlySet<string> = new Set([
  "cleanup",
  "cleanup_failure",
  "babysit_action",
  "dispatch_action",
  "recovery_dispatch",
  "slice_recovery",
  "processor_request",
]);

/**
 * Parse the JSONL action-event log, keep the last `limit` replayable events, and
 * format each into its stdout line. Malformed lines and unknown kinds are
 * dropped. Returns the formatted lines in log order (oldest → newest); the caller
 * prints the header + lines (and skips both when the result is empty).
 */
export function recentActionEventLines(rawJsonl: string, limit = 10): string[] {
  return rawJsonl
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && REPLAY_KINDS.has(event.kind))
    .slice(-limit)
    .map(formatReplayLine);
}

function formatReplayLine(event: any): string {
  if (event.kind === "cleanup") {
    return formatCleanupLine(event, "recent action: ");
  }
  if (event.kind === "cleanup_failure") {
    return formatCleanupFailureLine(event, "recent action: ");
  }
  if (event.kind === "babysit_action") {
    return formatBabysitActionLine(event, "recent action: ");
  }
  if (event.kind === "dispatch_action") {
    return "[" + event.ts + "] recent action: dispatch " + event.slice_id + ": " + event.detail;
  }
  if (event.kind === "recovery_dispatch") {
    return "[" + event.ts + "] recent action: recovery-dispatch " + event.slice_id + ": " + event.detail;
  }
  if (event.kind === "slice_recovery") {
    return "[" + event.ts + "] recent action: slice-recovery " + event.slice_id + ": " + event.detail;
  }
  return formatProcessorRequestLine(event, "recent action: ");
}
