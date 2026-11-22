import type { HandlerContext, HandlerResult, LoopState, MergeRequest } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";

/**
 * Operator MERGE NOW (#593) — the lever that replaces running `gh pr merge` out
 * of band. An operator appends `slice.merge.requested` (via the legate's
 * `POST /slices/:sliceId/merge`); the fold keeps it as `mergeRequested` until
 * this handler settles it, so a restart re-reads a request not yet acted on.
 *
 * It deliberately BYPASSES the auto-merge gate's review/CI requirements — the
 * operator has judged the PR mergeable — but keeps the two safety rails the gate
 * relies on: it re-reads the PR from GitHub (the fold can lag) and refuses a PR
 * that is not OPEN or is CONFLICTING, and it pins the merge to the head SHA it
 * just read (`--match-head-commit`), so a steward push between read and merge
 * fails cleanly instead of merging an unseen commit.
 *
 * Success transitions the slice to `merged` exactly like the auto-merge path (the
 * fold clears `mergeRequested` on that stage); any failure appends
 * `slice.operator.refused {action:"merge"}` so the request does not retry every
 * tick — the operator re-asks once the cause is fixed.
 *
 * Runs right after requeue in the pipeline, so a merge requested this tick lands
 * before cleanup/babysit look at the PR.
 */

/** The PR as GitHub reports it right now (the fold can lag behind). */
export interface LivePr {
  state: string;
  headSha: string;
  mergeable?: string;
}

/** Side-effecting GitHub seams (injected so the handler stays unit-testable). */
export interface MergeNowDeps {
  readPr: (repoPath: string, prNumber: number, sliceId?: string) => Promise<LivePr>;
  mergePr: (input: { prNumber: number; headSha: string; repoPath?: string; sliceId?: string }) => Promise<{ merged: boolean; error?: string }>;
}

export type MergeNowDecision =
  | { readonly sliceId: string; readonly action: "merge"; readonly request: MergeRequest }
  | { readonly sliceId: string; readonly action: "refuse"; readonly request: MergeRequest; readonly reason: string };

/** Warm record of request seqs already settled (see requeue's `handledSeqs`). */
function handledSeqs(raw: any): Record<string, number> {
  if (!raw.merge_now_handled_seq || typeof raw.merge_now_handled_seq !== "object") raw.merge_now_handled_seq = {};
  return raw.merge_now_handled_seq;
}

/** Pure: one decision per pending (not yet settled) merge request. */
export function assess(state: LoopState): MergeNowDecision[] {
  const out: MergeNowDecision[] = [];
  const handled = (state.raw?.merge_now_handled_seq ?? {}) as Record<string, number>;
  for (const request of state.mergeRequests ?? []) {
    const { sliceId } = request;
    if (typeof handled[sliceId] === "number" && request.seq <= handled[sliceId]) continue;
    const slice = state.slices?.[sliceId];
    if (!slice || typeof slice !== "object" || slice.recovered) {
      out.push({ sliceId, action: "refuse", request, reason: "slice is not in flight (unknown, archived or already recovered)" });
      continue;
    }
    if (slice.stage === "merged") {
      out.push({ sliceId, action: "refuse", request, reason: `PR #${request.prNumber} is already merged` });
      continue;
    }
    out.push({ sliceId, action: "merge", request });
  }
  return out;
}

export async function apply(
  decisions: MergeNowDecision[],
  ctx: HandlerContext,
  state: LoopState,
  deps?: MergeNowDeps,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!state.raw) return res;

  const base = (sliceId: string, prNumber: number) => ({
    schema_version: 1,
    ts: ctx.ts,
    processor: ctx.meta.processor_name,
    kind: "operator-merge",
    slice_id: sliceId,
    pr_number: prNumber,
  });
  // `stage` is the bounded march.failure_stage on the errored execution span:
  // precondition (refused before acting), read (live PR lookup), merge (gh merge).
  const refuse = (d: MergeNowDecision, reason: string, stage: "precondition" | "read" | "merge" = "precondition") => {
    handledSeqs(state.raw)[d.sliceId] = d.request.seq;
    res.mutated = true;
    ctx.emitTransition?.({ type: "slice.operator.refused", sliceId: d.sliceId, action: "merge", reason, requestSeq: d.request.seq });
    res.actions.push({ ...base(d.sliceId, d.request.prNumber), action: "operator-merge-refused", detail: reason, failure_stage: stage });
  };

  for (const d of decisions) {
    if (d.action === "refuse") {
      refuse(d, d.reason);
      continue;
    }
    if (!deps || !state.repoPath) {
      refuse(d, "cannot merge: GitHub seam or repo path unavailable");
      continue;
    }
    const prNumber = d.request.prNumber;
    let live: LivePr;
    try {
      live = await deps.readPr(state.repoPath, prNumber, d.sliceId);
    } catch (err: any) {
      refuse(d, `reading PR #${prNumber} failed: ${err?.message ?? String(err)}`, "read");
      res.failures.push({ slice_id: d.sliceId, error: `read PR #${prNumber}: ${err?.message ?? String(err)}` });
      continue;
    }
    const prState = String(live.state || "").toUpperCase();
    if (prState !== "OPEN") {
      refuse(d, `PR #${prNumber} is ${prState || "in an unknown state"}, not OPEN`);
      continue;
    }
    if (String(live.mergeable || "").toUpperCase() === "CONFLICTING") {
      refuse(d, `PR #${prNumber} has merge conflicts`);
      continue;
    }
    if (!live.headSha) {
      refuse(d, `PR #${prNumber} reported no head SHA`);
      continue;
    }

    let result: { merged: boolean; error?: string };
    try {
      result = await deps.mergePr({ prNumber, headSha: live.headSha, repoPath: state.repoPath, sliceId: d.sliceId });
    } catch (err: any) {
      result = { merged: false, error: err?.message ?? String(err) };
    }
    if (!result.merged) {
      refuse(d, `merging PR #${prNumber} failed: ${result.error ?? "unknown error"}`, "merge");
      res.failures.push({ slice_id: d.sliceId, error: `merge PR #${prNumber}: ${result.error ?? "unknown error"}` });
      continue;
    }

    handledSeqs(state.raw)[d.sliceId] = d.request.seq;
    const slice = state.slices[d.sliceId];
    slice.stage = "merged";
    if (slice.pr) slice.pr.state = "MERGED";
    // The tick's sensed PR observation still says OPEN; later handlers this tick
    // (babysit, cleanup) read it, so mark it merged too — babysit then skips the
    // slice instead of sending fix work, and cleanup tears it down as after an
    // auto-merge.
    const ext = state.perSlice?.[d.sliceId];
    if (ext?.pr && typeof ext.pr === "object" && !ext.pr.skipped) ext.pr = { ...ext.pr, state: "MERGED" };
    slice.last_action = ctx.ts;
    slice.last_action_note = `merged by operator request — squash, sha=${live.headSha}`;
    ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "merged" });
    res.actions.push({
      ...base(d.sliceId, prNumber),
      action: "operator-merge",
      detail: `squash-merged PR #${prNumber} on operator request (sha=${live.headSha})`,
    });
    res.mutated = true;
  }
  return res;
}
