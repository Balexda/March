import path from "node:path";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { isWorkerSession } from "../pure/session.js";
import { isTerminalSlice } from "../pure/slice.js";
import { dropSession } from "../state/mutations.js";

/**
 * Ghost-steward cleanup: a worker session whose worktree isn't tracked by any
 * non-terminal slice (and is old enough to not be a just-launched race) is an
 * orphan — request Brood teardown. assess() is pure; apply() tears down via
 * Brood (the authority), deferring rather than blindly removing if Brood can't
 * confirm.
 */

const MIN_GHOST_AGE_MS = 5 * 60 * 1000;

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
  const nowMs = Date.parse(state.ts);
  for (const session of state.sessions) {
    if (!session || typeof session !== "object") continue;
    if (!isWorkerSession(session, state.workerGroup)) continue;
    if (typeof session.id === "string" && activeSessionIds.has(session.id)) continue;
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
    const teardown = await ctx.broodTeardown(d.sessionId, { force: true, reason: "ghost-steward" });
    if (teardown.ok) {
      dropSession(state, d.sessionId);
      res.mutated = true;
      res.actions.push({
        action: "ghost-cleanup",
        sessionId: d.sessionId,
        title: d.title,
        detail: `removed ghost steward (worktree ${d.dirName} not tracked by any non-terminal slice)`,
      });
    } else {
      // Defer rather than blindly removing — Brood owns teardown, and an
      // untracked ghost is a registration gap to surface, not prune around.
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
