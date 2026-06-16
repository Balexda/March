import path from "node:path";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { isWorkerSession } from "../pure/session.js";
import { isTerminalSlice } from "../pure/slice.js";
import { dropSession, ensureRetryCounts } from "../state/mutations.js";

/**
 * Ghost-steward cleanup: a worker session whose worktree isn't tracked by any
 * non-terminal slice (and is old enough to not be a just-launched race) is an
 * orphan — request Brood teardown. assess() is pure; apply() tears down via
 * Brood (the authority), deferring rather than blindly removing if Brood can't
 * confirm.
 *
 * Not-tracked is TERMINAL for the legate, not retryable: if Brood replies 404
 * (`notTracked`), the session is outside Brood's registry — a reconciliation gap
 * Brood owns (adopt the open-PR steward, or reap the dead orphan; #304/#368), not
 * a teardown the legate should re-issue every tick. Re-issuing it is pure churn —
 * the 404 verdict is deterministic — and it was driving a Brood 404 storm
 * (~half of Brood's traffic) for untracked profiles like gatecli. So the first
 * `notTracked` TOMBSTONES the session (via the #211 retry-count budget) and emits
 * a benign `ghost-cleanup-deferred` (NOT `-failed`, so it never counts toward the
 * loop failure ratio); a transient failure (Brood unreachable) still defers + retries.
 */

const MIN_GHOST_AGE_MS = 5 * 60 * 1000;

/** Retry-budget key tombstoning a session the legate has deferred to Brood. */
const ghostCleanupKey = (sessionId: string): string => "ghost-cleanup:" + sessionId;

export interface GhostDecision {
  readonly sessionId: string;
  readonly title: string;
  readonly dirName: string;
}

/** Pure: which worker sessions are orphaned ghosts safe to tear down. */
export function assess(state: LoopState): GhostDecision[] {
  const out: GhostDecision[] = [];
  if (!Array.isArray(state.sessions)) return out;
  const activeDirs = new Set<string>();
  const activeSessionIds = new Set<string>();
  for (const slice of Object.values(state.slices) as any[]) {
    if (!slice || typeof slice !== "object") continue;
    if (isTerminalSlice(slice)) continue;
    const sessId = slice.worker_session_id;
    if (typeof sessId === "string" && sessId.length > 0) activeSessionIds.add(sessId);
    const br = typeof slice.branch === "string" ? slice.branch : "";
    if (!br) continue;
    const stripped = br.replace(/^feature\//, "");
    activeDirs.add("feature-" + stripped.replace(/\//g, "-"));
  }
  const counts =
    state.raw?.transient_retry_counts && typeof state.raw.transient_retry_counts === "object"
      ? (state.raw.transient_retry_counts as Record<string, number>)
      : {};
  const nowMs = Date.parse(state.ts);
  for (const session of state.sessions) {
    if (!session || typeof session !== "object") continue;
    if (!isWorkerSession(session, state.workerGroup)) continue;
    if (typeof session.id === "string" && activeSessionIds.has(session.id)) continue;
    // Already deferred to Brood (a prior tick got a not-tracked 404) — don't
    // re-attempt the deterministic 404 every tick.
    if (typeof session.id === "string" && counts[ghostCleanupKey(session.id)]) continue;
    const worktreePath = session.worktree_path || session.worktreePath || session.path;
    if (typeof worktreePath !== "string" || worktreePath.length === 0) continue;
    const dirName = path.basename(worktreePath);
    if (activeDirs.has(dirName)) continue;
    const createdAt = Date.parse(session.created_at || session.createdAt || "");
    if (Number.isFinite(createdAt) && Number.isFinite(nowMs) && nowMs - createdAt < MIN_GHOST_AGE_MS) continue;
    out.push({ sessionId: String(session.id), title: session.title || "", dirName });
  }
  return out;
}

export async function apply(decisions: GhostDecision[], ctx: HandlerContext, state: LoopState): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  for (const d of decisions) {
    // A ghost steward has no slice, so it keys its trace off the session id — the
    // same key the legate.ghost-cleanup action span uses — so brood.teardown shares
    // that trace (sibling under the deterministic session anchor) instead of
    // orphaning a separate root (#234).
    const teardown = await ctx.broodTeardown(d.sessionId, { force: true, reason: "ghost-steward", traceKey: d.sessionId });
    if (teardown.ok) {
      dropSession(state, d.sessionId);
      res.mutated = true;
      res.actions.push({
        action: "ghost-cleanup",
        sessionId: d.sessionId,
        title: d.title,
        detail: `removed ghost steward (worktree ${d.dirName} not tracked by any non-terminal slice)`,
      });
    } else if (teardown.notTracked) {
      // Brood has no record of this session (404) — it's a reconciliation gap
      // Brood owns (adopt the open-PR steward, or reap the dead orphan), NOT a
      // teardown the legate should re-issue. Tombstone it so we surface ONCE and
      // defer, instead of re-firing the same 404 every tick (the gatecli ghost
      // wedge). Durable via retry.counted so the tombstone survives a cold start.
      ensureRetryCounts(state.raw)[ghostCleanupKey(d.sessionId)] = 1;
      ctx.emitTransition?.({ type: "retry.counted", key: ghostCleanupKey(d.sessionId), count: 1 });
      res.mutated = true;
      res.actions.push({
        action: "ghost-cleanup-deferred",
        sessionId: d.sessionId,
        title: d.title,
        detail: `brood does not track ghost steward (worktree ${d.dirName}); deferred to Brood reconciliation, not retrying: ${teardown.detail}`,
      });
    } else {
      // Transient failure (Brood unreachable / 5xx) — defer and retry next tick;
      // do NOT tombstone, the next tick may reach Brood.
      res.actions.push({
        action: "ghost-cleanup-failed",
        sessionId: d.sessionId,
        title: d.title,
        detail: `brood teardown did not confirm for ${d.dirName}: ${teardown.detail}`,
      });
    }
  }
  return res;
}
