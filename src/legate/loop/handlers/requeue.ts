import type { HandlerContext, HandlerResult, LoopState, RequeueRequest } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { dropRecoveredSlice, dropSession } from "../state/mutations.js";
import { releasableArchive } from "../pure/slice.js";
import { managerWorkspace } from "../pure/session.js";

/**
 * Operator REQUEUE (#588/#593): "throw this slice's output away and put the smithy
 * item back in the queue". An operator appends `slice.requeue.requested` (via the
 * legate's `POST /slices/:sliceId/requeue`); the fold carries it as the slice's
 * pending `requeueRequested` until this handler resolves it. Unlike operator
 * recovery it does NOT walk the graduated ladder and does NOT refuse a steward
 * parked `awaiting_input` — it is precisely the lever for a question that can no
 * longer be answered (dead session) or a steward that went off the rails.
 *
 * For each pending request, in order:
 *   1. Tear down the incarnation through Brood (session, worktree, local branch,
 *      by EXACT path — #155, never a prune). An untracked or dead session is first
 *      registered into Brood from the slice's own worktree/branch facts so its
 *      on-disk workspace is still reclaimed (the dead-session case).
 *   2. With `closePr`, close the open PR with an attribution comment.
 *   3. Delete the remote branch if it was pushed — otherwise the fresh dispatch's
 *      orphan-branch check refuses it (`open-pr` / `pr-lookup-unknown`).
 *   4. Drop the slice from the warm state and append the rung-3 tombstone
 *      (`slice.recovery.requested {rung:3}`), which clears `requeueRequested`, the
 *      stale steward report and PR in the fold. Dispatch re-selects the item fresh.
 *
 * An ARCHIVED slice (#592) has no incarnation left to tear down, but it still
 * holds its plan row back from dispatch (the archive dedup). Requeueing one
 * RELEASES that hold: a CLOSED archive always, a MERGED one only with
 * `releaseMerged` (see {@link releasableArchive}). The handler skips steps 1–2,
 * deletes the archive's leftover remote branch if any (step 3), and appends the
 * same rung-3 tombstone, after which the row dispatches fresh.
 *
 * A slice with an open PR is refused unless the request carries `closePr` (the
 * endpoint refuses up front; this re-check guards a PR that opened in between).
 * A failed step leaves the request pending and retries next tick (teardown is
 * idempotent); after {@link MAX_REQUEUE_ATTEMPTS} the handler gives up, rings the
 * operator, and appends `slice.requeue.refused` so the request stops retrying.
 *
 * Runs FIRST in the pipeline so no other handler (cleanup archiving a just-closed
 * PR, relaunch re-attaching to a just-killed steward, babysit re-escalating) acts
 * on a slice the operator has already discarded, and dispatch (last) can re-launch
 * the freed item on the same tick.
 */

/** Give up (and ring the operator) after this many failed requeue attempts. */
export const MAX_REQUEUE_ATTEMPTS = 3;

/** Side-effecting GitHub seams (injected so the handler stays unit-testable). */
export interface RequeueDeps {
  /** Close an open PR with a comment. */
  closePr: (repoPath: string, prNumber: number, comment: string, sliceId?: string) => Promise<void>;
  /** Delete the remote branch; resolves `false` when it did not exist. */
  deleteRemoteBranch: (repoPath: string, branch: string, sliceId?: string) => Promise<boolean>;
}

export type RequeueDecision =
  | { readonly sliceId: string; readonly action: "requeue"; readonly request: RequeueRequest; readonly prNumber: number | null }
  | { readonly sliceId: string; readonly action: "release-archived"; readonly request: RequeueRequest; readonly terminal: "MERGED" | "CLOSED" }
  | { readonly sliceId: string; readonly action: "refuse"; readonly request: RequeueRequest; readonly reason: string };

/** The slice's PR as the fold observed it, falling back to the warm record. */
function prOf(state: LoopState, sliceId: string, slice: any): { number: number | null; state: string | null } {
  const observed = state.perSlice?.[sliceId]?.pr;
  const pr = observed && !observed.skipped ? observed : slice?.pr;
  const n = pr?.number;
  return {
    number: typeof n === "number" && n > 0 ? n : null,
    state: typeof pr?.state === "string" ? pr.state.toUpperCase() : null,
  };
}

/** Warm record of request seqs already resolved, keyed by slice id. The fold only
 *  forgets a request once our tombstone/refusal drains back next tick, so without
 *  this a just-handled request would be re-read — and could tear down the fresh
 *  re-dispatch that reuses the same slice id. Lost on a cold start, which is fine:
 *  a cold start rebuilds from a fold that has already folded our transition. */
function handledSeqs(raw: any): Record<string, number> {
  if (!raw.requeue_handled_seq || typeof raw.requeue_handled_seq !== "object") raw.requeue_handled_seq = {};
  return raw.requeue_handled_seq;
}

/** Pure: one decision per pending (not yet handled) requeue request. */
export function assess(state: LoopState): RequeueDecision[] {
  const out: RequeueDecision[] = [];
  const handled = (state.raw?.requeue_handled_seq ?? {}) as Record<string, number>;
  for (const request of state.requeueRequests ?? []) {
    const { sliceId } = request;
    if (typeof handled[sliceId] === "number" && request.seq <= handled[sliceId]) continue;
    const slice = state.slices?.[sliceId];
    const archived = state.archived?.[sliceId];
    if ((!slice || typeof slice !== "object") && archived && typeof archived === "object") {
      // #592: release an archived hold. Prefer the archive's recorded outcome;
      // fall back to the fold's PR observation when the archive lacks one.
      const observed = prOf(state, sliceId, archived).state;
      const subject = archived.terminal_state || !observed ? archived : { ...archived, terminal_state: observed };
      const release = releasableArchive(subject, request.releaseMerged === true);
      out.push(
        release.ok
          ? { sliceId, action: "release-archived", request, terminal: release.terminal }
          : { sliceId, action: "refuse", request, reason: `slice ${release.error}` },
      );
      continue;
    }
    if (!slice || typeof slice !== "object" || slice.recovered) {
      out.push({ sliceId, action: "refuse", request, reason: "slice is not in flight (unknown, archived or already recovered)" });
      continue;
    }
    if (slice.stage === "hatchery-pending") {
      // A spawn job is still running for this slice; discarding it now would let
      // its completion race a fresh dispatch. Let it land (or fail), then requeue.
      out.push({ sliceId, action: "refuse", request, reason: "a spawn is still in progress (hatchery-pending); requeue once it lands" });
      continue;
    }
    const pr = prOf(state, sliceId, slice);
    if (pr.state === "MERGED") {
      out.push({ sliceId, action: "refuse", request, reason: `PR #${pr.number} already merged` });
      continue;
    }
    const open = pr.number !== null && pr.state !== "CLOSED";
    if (open && !request.closePr) {
      out.push({ sliceId, action: "refuse", request, reason: `slice has open PR #${pr.number}; requeue with closePr to close it` });
      continue;
    }
    out.push({ sliceId, action: "requeue", request, prNumber: open ? pr.number : null });
  }
  return out;
}

interface StepOutcome {
  ok: boolean;
  detail: string;
}

/** Step 1: tear the incarnation down through Brood (exact path, #155). */
async function teardownIncarnation(sliceId: string, slice: any, state: LoopState, ctx: HandlerContext): Promise<StepOutcome> {
  const sessionId = typeof slice.worker_session_id === "string" ? slice.worker_session_id : "";
  // The REAL on-disk names, not the symbolic dispatch branch: a spawn that failed
  // before a PR/session was recorded leaves only `slice.branch` (`smithy/…`), but
  // agent-deck created `feature/smithy/…` and its worktree. Registering the bare
  // name made Brood "tear down" a branch that never existed and report success,
  // leaving the orphan to collide with every re-dispatch.
  const { worktreePath, branch } = managerWorkspace(slice, state.repoPath ?? "");
  const opts = { force: true, reason: "operator-requeue", traceKey: sliceId };

  if (sessionId) {
    const t = await ctx.broodTeardown(sessionId, opts);
    if (t.ok) return { ok: true, detail: `brood teardown of ${sessionId}` };
    if (!t.notTracked) return { ok: false, detail: `brood teardown of ${sessionId} failed: ${t.detail}` };
  }

  // Untracked by Brood (dead/legacy session) or no session at all.
  if (!worktreePath && !branch) {
    // Nothing on disk to reclaim; best-effort drop a still-live session.
    if (sessionId && state.sessionsById.get(sessionId)) {
      try {
        await ctx.castra.removeSession({ profile: ctx.meta.profile, sessionId, pruneWorktree: false, traceKey: sliceId });
      } catch (err: any) {
        return { ok: false, detail: `castra remove of ${sessionId} failed: ${err?.message ?? String(err)}` };
      }
    }
    return { ok: true, detail: "no worktree or branch to reclaim" };
  }
  if (!state.repoPath || !ctx.broodRegister) {
    return { ok: false, detail: "cannot reclaim the untracked workspace: repo path or Brood register unavailable" };
  }
  // Back-fill the incarnation into Brood from the slice's own facts so Brood owns
  // its teardown by exact worktree/branch path (the cleanup #225 reconcile, keyed
  // off the slice instead of a live Castra observation — the session may be gone).
  const id = sessionId || `requeue-${sliceId}-${Date.parse(ctx.ts) || 0}`;
  const reg = await ctx.broodRegister({
    id,
    kind: "steward",
    status: "running",
    ...(sessionId ? { agentDeckSessionId: sessionId } : {}),
    profile: ctx.meta.profile,
    repoPath: state.repoPath,
    ...(worktreePath ? { worktreePath } : {}),
    ...(branch ? { branch } : {}),
  });
  if (!reg.ok) return { ok: false, detail: `brood register of ${id} failed: ${reg.detail}` };
  const t = await ctx.broodTeardown(id, opts);
  return t.ok
    ? { ok: true, detail: `reconciled + brood teardown of ${id}` }
    : { ok: false, detail: `brood teardown of reconciled ${id} failed: ${t.detail}` };
}

function attribution(request: RequeueRequest): string {
  const who = request.operator ? ` by ${request.operator}` : "";
  const why = request.reason ? `: ${request.reason}` : "";
  return `Requeued by operator${who}${why}. March discarded this attempt and will re-dispatch the work fresh.`;
}

export async function apply(
  decisions: RequeueDecision[],
  ctx: HandlerContext,
  state: LoopState,
  deps?: RequeueDeps,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!state.raw) return res;

  for (const d of decisions) {
    const base = {
      schema_version: 1,
      ts: ctx.ts,
      processor: ctx.meta.processor_name,
      kind: "requeue",
      slice_id: d.sliceId,
      ...(d.request.operator ? { operator: d.request.operator } : {}),
      ...(d.request.reason ? { reason: d.request.reason } : {}),
    };

    if (d.action === "refuse") {
      handledSeqs(state.raw)[d.sliceId] = d.request.seq;
      res.mutated = true;
      ctx.emitTransition?.({ type: "slice.requeue.refused", sliceId: d.sliceId, reason: d.reason });
      res.actions.push({ ...base, action: "requeue-refused", detail: d.reason });
      continue;
    }

    const releasing = d.action === "release-archived";
    const slice = releasing ? state.archived[d.sliceId] : state.slices[d.sliceId];
    const sessionId = !releasing && typeof slice.worker_session_id === "string" ? slice.worker_session_id : null;
    // Pushed March branches carry the `feature/` prefix too (the PR head), so
    // the bare dispatch name would miss them.
    const { branch } = managerWorkspace(slice, state.repoPath ?? "");
    const notes: string[] = [];
    const archivedAttrs = releasing ? { archived: true, terminal: d.terminal } : {};

    let failure: string | null = null;
    if (releasing) {
      // Nothing to tear down: the archive's session/worktree went with the cleanup
      // that archived it, and its PR is already terminal.
      notes.push(`released archived ${d.terminal} hold`);
    } else {
      const teardown = await teardownIncarnation(d.sliceId, slice, state, ctx);
      notes.push(teardown.detail);
      if (!teardown.ok) failure = teardown.detail;
    }

    if (!failure && d.action === "requeue" && d.prNumber !== null) {
      if (!deps || !state.repoPath) {
        failure = "cannot close the PR: GitHub seam or repo path unavailable";
      } else {
        try {
          await deps.closePr(state.repoPath, d.prNumber, attribution(d.request), d.sliceId);
          notes.push(`closed PR #${d.prNumber}`);
        } catch (err: any) {
          failure = `closing PR #${d.prNumber} failed: ${err?.message ?? String(err)}`;
        }
      }
    }

    // A released archive's leftover remote branch (a closed attempt's, or a merged
    // one GitHub kept) would collide with the fresh dispatch, which reuses the
    // deterministic branch name; a merged branch's work is already on the default
    // branch, so deleting it loses nothing. `false` (already gone) is fine.
    if (!failure && branch && deps && state.repoPath) {
      try {
        const deleted = await deps.deleteRemoteBranch(state.repoPath, branch, d.sliceId);
        if (deleted) notes.push(`deleted remote branch ${branch}`);
      } catch (err: any) {
        failure = `deleting remote branch ${branch} failed: ${err?.message ?? String(err)}`;
      }
    }

    if (failure) {
      const attempts = (slice.requeue_attempts = Number(slice.requeue_attempts || 0) + 1);
      slice.last_action = ctx.ts;
      slice.last_action_note = `requeue attempt ${attempts}/${MAX_REQUEUE_ATTEMPTS} failed: ${failure}`;
      res.mutated = true;
      res.failures.push({ slice_id: d.sliceId, session_id: sessionId, attempts, error: failure });
      if (attempts >= MAX_REQUEUE_ATTEMPTS) {
        handledSeqs(state.raw)[d.sliceId] = d.request.seq;
        ctx.emitTransition?.({ type: "slice.requeue.refused", sliceId: d.sliceId, reason: `gave up after ${attempts} attempts: ${failure}` });
        delete slice.requeue_attempts;
        if (ctx.requestJudgement) {
          const event = await ctx.requestJudgement({
            ts: ctx.ts,
            slice,
            requestKey: `requeue-failed:${d.sliceId}`,
            sliceId: d.sliceId,
            sessionId,
            reason: "requeue-failed",
            detail: `operator requeue gave up after ${attempts} attempts: ${failure}`,
          });
          if (event) res.requests.push(event);
        }
      }
      res.actions.push({ ...base, ...archivedAttrs, action: "requeue-failed", session_id: sessionId, attempts, detail: failure });
      continue;
    }

    dropRecoveredSlice(state.raw, d.sliceId);
    handledSeqs(state.raw)[d.sliceId] = d.request.seq;
    if (state.perSlice) delete state.perSlice[d.sliceId];
    if (sessionId) dropSession(state, sessionId);
    // The rung-3 tombstone: the fold replaces the slice with a bare
    // `{recovered:true}` (clearing requeueRequested + the stale report/PR), and the
    // fresh slice.dispatched that follows re-creates it clean.
    ctx.emitTransition?.({ type: "slice.recovery.requested", sliceId: d.sliceId, rung: 3 });
    res.mutated = true;
    res.actions.push({ ...base, ...archivedAttrs, action: "requeue-done", session_id: sessionId, detail: notes.join("; ") });
  }
  return res;
}
