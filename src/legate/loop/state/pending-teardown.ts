import { ensureRetryCounts } from "./mutations.js";
import type { HandlerContext, LoopState } from "./types.js";

type Caller = "cleanup" | "ghost-cleanup" | "relaunch";

const prefix = (caller: Caller): string => `pending-teardown:${caller}:`;

export function pendingTeardowns(state: LoopState, caller: Caller): { sessionId: string; traceKey: string }[] {
  const start = prefix(caller);
  const pending = [];
  for (const [key, count] of Object.entries(state.raw?.transient_retry_counts ?? {})) {
    if (count !== 1 || !key.startsWith(start)) continue;
    const params = new URLSearchParams(key.slice(start.length));
    const sessionId = params.get("session");
    const traceKey = params.get("trace");
    if (sessionId && traceKey) {
      pending.push({ sessionId, traceKey });
    }
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
  const key = prefix(caller) + new URLSearchParams({ session: sessionId, trace: traceKey }).toString();
  const counts = ensureRetryCounts(state.raw);
  const count = pending ? 1 : 0;
  if ((counts[key] ?? 0) === count) return;
  counts[key] = count;
  ctx.emitTransition?.({ type: "retry.counted", key, count });
}
