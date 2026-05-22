import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { sessionMatchesSlice } from "../pure/session.js";
import { archiveSlice, dropSession, dropSlice } from "../state/mutations.js";

/**
 * Terminal-PR cleanup. A slice whose PR has MERGED/CLOSED is done — request
 * Brood teardown (Brood owns removing the steward/worktree/branch; the loop no
 * longer prunes), then archive the slice. assess() is pure over the sensed
 * snapshot; apply() does the teardown + archive.
 *
 * The hazard this handler must NOT regress (#155): never archive over an
 * orphaned steward/worktree, and never blanket-prune. But a *missing Brood
 * record* must not deadlock cleanup forever (#225): when Brood 404s on a
 * still-live steward it never tracked, reconcile it into the registry (from the
 * Castra observation: exact worktree/branch path) so Brood's own exact-path
 * teardown can reap it; when the session is genuinely gone, there is nothing to
 * tear down, so archive idempotently. A teardown that still can't be confirmed
 * after {@link MAX_CLEANUP_ATTEMPTS} escalates to the operator instead of
 * silently retrying every tick.
 */

/** Defer + retry up to this many ticks before escalating a stuck teardown. */
export const MAX_CLEANUP_ATTEMPTS = 5;

export interface CleanupDecision {
  readonly sliceId: string;
  readonly sessionId: string;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly terminalState: "MERGED" | "CLOSED";
}

/** Pure: which active slices have a terminal PR and should be torn down. */
export function assess(state: LoopState): CleanupDecision[] {
  const out: CleanupDecision[] = [];
  if (!state.statePresent) return out;
  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    if (!state.sessions.some((s) => sessionMatchesSlice(s, slice))) continue;
    const pr = state.perSlice[sliceId]?.pr;
    if (!pr || pr.skipped) continue;
    const terminalState = pr.state;
    if (terminalState !== "MERGED" && terminalState !== "CLOSED") continue;
    out.push({
      sliceId,
      sessionId,
      prNumber: pr.number ?? slice?.pr?.number ?? null,
      prUrl: pr.url ?? slice?.pr?.url ?? null,
      terminalState,
    });
  }
  return out;
}

export async function apply(decisions: CleanupDecision[], ctx: HandlerContext, state: LoopState): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  for (const d of decisions) {
    const slice = state.slices[d.sliceId];
    if (!slice) continue;
    const reason = `pr-${d.terminalState.toLowerCase()}`;

    // traceKey = slice id: brood.teardown's spans nest under this slice's trace
    // (the same anchor as the legate.cleanup action span) instead of orphaning (#234).
    let teardown = await ctx.broodTeardown(d.sessionId, { reason, traceKey: d.sliceId });

    // 404 not-tracked: Brood has no record of this session. Distinguish a
    // live-but-untracked steward from one that's genuinely gone (#225) — a
    // missing registry record must not block cleanup forever.
    if (!teardown.ok && teardown.notTracked) {
      const live = liveSession(state, d.sessionId);
      if (live) {
        // Address the steward by its CANONICAL id: the slice may have matched it
        // by a title/name alias (assess() allows that), so reconciling/tearing
        // down under the alias would have Brood ask Castra to remove the wrong
        // session id — leaving the real steward live while the slice archives.
        const canonicalId = String(live.id || d.sessionId);
        const worktreePath = live.worktree_path ? String(live.worktree_path) : "";
        if (!worktreePath || !state.repoPath) {
          // Without the exact worktree path (+ repo root) Brood's teardown would
          // skip worktree/branch removal yet still return ok, so cleanup would
          // archive over a leaked workspace (#155). Treat as a real teardown
          // failure: defer + escalate rather than register an incomplete record.
          teardown = {
            ok: false,
            notTracked: false,
            detail: `cannot reconcile ${canonicalId}: observation lacks an exact worktree path for #155-safe teardown`,
          };
        } else {
          // Reconcile: back-fill the orphan into Brood from the Castra observation
          // so Brood owns its teardown by EXACT worktree/branch path (#155 — never
          // a blanket prune), then re-request teardown so the reap runs there.
          const reg = ctx.broodRegister
            ? await ctx.broodRegister(reconcileInput(canonicalId, live, worktreePath, state.repoPath, ctx))
            : { ok: false, detail: "broodRegister unavailable" };
          if (reg.ok) {
            ctx.log(`cleanup reconciled untracked steward ${canonicalId} into Brood (${d.sliceId}); retrying teardown`);
            teardown = await ctx.broodTeardown(canonicalId, { force: true, reason, traceKey: d.sliceId });
          } else {
            teardown = { ok: false, notTracked: false, detail: `reconcile failed: ${reg.detail}` };
          }
        }
      } else {
        // Genuinely gone: Castra has no such session, so there is nothing to
        // tear down. Archive as an idempotent success — the steward and its
        // worktree are already absent, so no orphan can be left behind.
        ctx.log(`cleanup: session ${d.sessionId} untracked by Brood and absent in Castra — archiving ${d.sliceId} (nothing to tear down)`);
        archiveAndDrop(d, slice, state, ctx);
        res.mutated = true;
        res.actions.push(cleanupAction(d, ctx, { removed: false, note: "untracked-and-absent" }));
        continue;
      }
    }

    if (!teardown.ok) {
      // A genuine teardown failure (Castra unreachable, worktree removal failed,
      // or reconcile/retry failed). DEFER + retry — never archive over an orphan
      // (#155) — but don't retry silently forever (#225): after N attempts,
      // escalate to the operator.
      const attempts = (slice.cleanup_attempts = Number(slice.cleanup_attempts || 0) + 1);
      slice.last_action = ctx.ts;
      slice.last_action_note = `cleanup deferred (attempt ${attempts}/${MAX_CLEANUP_ATTEMPTS}): ${teardown.detail}`;
      res.mutated = true;
      const failure: any = {
        slice_id: d.sliceId,
        session_id: d.sessionId,
        pr_number: d.prNumber,
        pr_state: d.terminalState,
        attempts,
        error: teardown.detail || "brood teardown did not confirm",
      };
      if (attempts >= MAX_CLEANUP_ATTEMPTS && ctx.requestJudgement) {
        const event = await ctx.requestJudgement({
          ts: ctx.ts,
          slice,
          requestKey: `cleanup-stuck:${d.sliceId}`,
          sliceId: d.sliceId,
          sessionId: d.sessionId,
          prNumber: d.prNumber,
          reason: "cleanup-stuck",
          detail: `PR ${d.terminalState} teardown unconfirmed after ${attempts} attempts: ${teardown.detail}`,
        });
        // requestJudgement dedups per requestKey and returns null on a repeat —
        // only record the escalation (and count the request) when it actually
        // fired, mirroring babysit/dispatch.
        if (event) {
          failure.escalated = true;
          res.requests.push(event);
        }
      }
      res.failures.push(failure);
      continue;
    }

    archiveAndDrop(d, slice, state, ctx);
    res.mutated = true;
    res.actions.push(cleanupAction(d, ctx, { removed: true }));
  }
  return res;
}

/** Find the live Castra-observed session for a decision's session id. */
function liveSession(state: LoopState, sessionId: string): any | undefined {
  return state.sessionsById.get(sessionId);
}

/**
 * Build the registry back-fill for an orphaned steward from the live Castra
 * observation. `canonicalId` (the session's real id) keys both the registry row
 * and `agentDeckSessionId` so teardown addresses the real session, not an alias.
 * `worktreePath`/`repoPath` are validated present by the caller — the EXACT
 * paths needed for #155-safe reclamation; `branch` is the exact branch when
 * observed; profile comes from the loop meta (Castra teardown needs a concrete
 * profile).
 */
function reconcileInput(canonicalId: string, live: any, worktreePath: string, repoPath: string, ctx: HandlerContext) {
  return {
    id: canonicalId,
    kind: "steward" as const,
    status: "running" as const,
    agentDeckSessionId: canonicalId,
    profile: ctx.meta.profile,
    repoPath,
    worktreePath,
    ...(live.group ? { group: String(live.group) } : {}),
    ...(live.branch ? { branch: String(live.branch) } : {}),
  };
}

/** Archive the slice + drop it and its session from the snapshot. */
function archiveAndDrop(d: CleanupDecision, slice: any, state: LoopState, ctx: HandlerContext): void {
  archiveSlice(state.raw, d.sliceId, slice, { number: d.prNumber, url: d.prUrl }, d.terminalState, ctx.ts);
  dropSlice(state, d.sliceId);
  dropSession(state, d.sessionId);
  ctx.emitTransition?.({ type: "slice.archived", sliceId: d.sliceId });
}

/** The action-log record for a completed cleanup. */
function cleanupAction(d: CleanupDecision, ctx: HandlerContext, extra: { removed: boolean; note?: string }) {
  return {
    schema_version: 1,
    ts: ctx.ts,
    processor: ctx.meta.processor_name,
    paired_legate: ctx.meta.paired_legate,
    kind: "cleanup",
    slice_id: d.sliceId,
    session_id: d.sessionId,
    pr_number: d.prNumber,
    pr_url: d.prUrl,
    pr_state: d.terminalState,
    removed: extra.removed,
    ...(extra.note ? { note: extra.note } : {}),
  };
}
