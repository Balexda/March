import { ensureRetryCounts } from "./mutations.js";
import type { HandlerContext, LoopState } from "./types.js";

type Caller = "cleanup" | "ghost-cleanup" | "relaunch";

const prefix = (caller: Caller): string => `pending-teardown:${caller}:`;

/**
 * Key shape: `pending-teardown:<caller>:<encoded session id>:<trace key>`.
 * The trace key (the slice id for cleanup/relaunch) is the raw suffix so every
 * slice reset that clears `endsWith(":" + sliceId)` retry keys (requeue,
 * recovery, the `slice.recovery.requested` reducer) also retires a stale
 * pending teardown from the slice's prior incarnation.
 */
function pendingKey(caller: Caller, sessionId: string, traceKey: string): string {
  return `${prefix(caller)}${encodeURIComponent(sessionId)}:${traceKey}`;
}

export function pendingTeardowns(state: LoopState, caller: Caller): { sessionId: string; traceKey: string }[] {
  const start = prefix(caller);
  const pending = [];
  for (const [key, count] of Object.entries(state.raw?.transient_retry_counts ?? {})) {
    if (count !== 1 || !key.startsWith(start)) continue;
    const rest = key.slice(start.length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) continue;
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(rest.slice(0, sep));
    } catch {
      continue;
    }
    pending.push({ sessionId, traceKey: rest.slice(sep + 1) });
  }
  return pending;
}

/** Persist the identity independently of the Castra observation and worker binding. */
export function setTeardownPending(
  state: LoopState,
  ctx: HandlerContext,
  caller: Caller,
  sessionId: string,
  traceKey: string,
  pending: boolean,
): void {
  const key = pendingKey(caller, sessionId, traceKey);
  const counts = ensureRetryCounts(state.raw);
  const count = pending ? 1 : 0;
  if ((counts[key] ?? 0) === count) return;
  counts[key] = count;
  ctx.emitTransition?.({ type: "retry.counted", key, count });
}

/**
 * Record a Brood teardown outcome. Only a confirmed non-terminal response
 * (`deferred`: Brood tracks the session and retained `tearing-down`) marks the
 * identity pending; `ok` retires it. A transport failure proves nothing about
 * tracking, so it leaves any existing entry unchanged and never disables the
 * caller's not-tracked reconciliation path.
 */
export function recordTeardownOutcome(
  state: LoopState,
  ctx: HandlerContext,
  caller: Caller,
  sessionId: string,
  traceKey: string,
  outcome: { ok: boolean; notTracked: boolean; deferred?: true },
): void {
  if (outcome.ok) setTeardownPending(state, ctx, caller, sessionId, traceKey, false);
  else if (outcome.deferred) setTeardownPending(state, ctx, caller, sessionId, traceKey, true);
}
