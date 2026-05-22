/** Pure formatters for the human-readable action-log lines. */

export function formatCleanupLine(event: any, prefix = ""): string {
  const head = `[${event.ts}] ${prefix}cleaned up ${event.slice_id} PR #${event.pr_number} ${event.pr_state}:`;
  // The #225 idempotent-archive path emits removed:false (the steward/worktree
  // were already gone) — don't claim a teardown that didn't happen.
  if (event.removed === false) {
    return `${head} archived ${event.session_id}${event.note ? " (" + event.note + ")" : ""}, nothing to tear down`;
  }
  return `${head} removed session ${event.session_id}, pruned worktree`;
}

export function formatCleanupFailureLine(event: any, prefix = ""): string {
  return `[${event.ts}] ${prefix}cleanup failed ${event.slice_id || "unknown"}${event.pr_state ? " PR " + event.pr_state : ""}: ${event.error}`;
}

export function formatBabysitActionLine(event: any, prefix = ""): string {
  return `[${event.ts}] ${prefix}babysit ${event.action} ${event.slice_id} PR #${event.pr_number}: ${event.detail}`;
}

export function formatProcessorRequestLine(event: any, prefix = ""): string {
  return `[${event.ts}] ${prefix}requested legate judgement for ${event.slice_id || "unknown"}${event.pr_number ? " PR #" + event.pr_number : ""}: ${event.reason}`;
}
