import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { CODERABBIT_REVIEW_COMMAND } from "../../../observe/coderabbit-review.js";

/**
 * CodeRabbit re-review request (opt-in: `mergePolicy.codeRabbit.rereview`).
 *
 * CodeRabbit's `CHANGES_REQUESTED` review blocks the merge on GitHub until
 * CodeRabbit reviews again and approves; the steward resolving its threads does
 * not clear it. CodeRabbit auto-review is off at the org level, so nothing asks
 * for that second review and a fixed PR sits forever. When the profile opts in,
 * this handler comments {@link CODERABBIT_REVIEW_COMMAND} on a slice PR once the
 * steward has answered CodeRabbit, which gives CodeRabbit the chance to approve.
 *
 * A request is made only when ALL of these hold (see {@link rereviewVerdict}):
 *   - the slice is `pr-open`: its steward is idle, not mid-fix or mid-rerun;
 *   - CodeRabbit's latest decisive review is `CHANGES_REQUESTED`, on a commit
 *     other than the current head (the steward has pushed since);
 *   - no review thread still owes the steward a reply, the PR is not in conflict
 *     and CI is not failing — babysit dispatches those fixes first;
 *   - the current head has not been put forward yet: no `@coderabbitai review`
 *     comment newer than the head commit (durable, read from GitHub) and none
 *     this process already posted for that head (warm memo).
 *
 * The natural bound is one request per pushed head. If CodeRabbit asks for more
 * changes, its new review is on the head, so nothing fires until the steward
 * pushes again. The merge gate is untouched: an approval CodeRabbit leaves counts
 * only where the profile accepts bot approvals (`botApproval`).
 */

export const REREVIEW_ACTION = "coderabbit-rereview-requested";
export const REREVIEW_FAILED_ACTION = "coderabbit-rereview-failed";

export interface CodeRabbitRereviewDeps {
  commentOnPr(repoPath: string, prNumber: number, body: string): Promise<void>;
}

export type RereviewVerdict = { request: true } | { request: false; reason: string };

/** Pure decision for one slice. `memoHead` is the head this process last requested for. */
export function rereviewVerdict(slice: any, pr: any, memoHead?: string): RereviewVerdict {
  if (slice?.stage !== "pr-open") return { request: false, reason: "steward-busy" };
  if (!pr || typeof pr !== "object" || pr.state !== "OPEN") return { request: false, reason: "no-open-pr" };
  const head = typeof pr.head_sha === "string" ? pr.head_sha : "";
  if (!head) return { request: false, reason: "no-head" };
  const cr = pr.coderabbit;
  if (!cr || cr.decision !== "CHANGES_REQUESTED") return { request: false, reason: "not-changes-requested" };
  if (cr.decision_commit_sha === head) return { request: false, reason: "head-already-reviewed" };
  if (Number(pr.needs_response_count ?? 0) > 0) return { request: false, reason: "threads-owed" };
  if (pr.mergeable === "CONFLICTING" || pr.merge_state_status === "dirty") return { request: false, reason: "conflicted" };
  if (pr.checks === "FAIL") return { request: false, reason: "ci-failing" };
  if (memoHead === head) return { request: false, reason: "already-requested" };
  if (
    typeof cr.last_request_at === "string" &&
    typeof pr.head_committed_at === "string" &&
    cr.last_request_at >= pr.head_committed_at
  ) {
    return { request: false, reason: "already-requested" };
  }
  return { request: true };
}

export async function apply(
  _ctx: HandlerContext,
  state: LoopState,
  deps: CodeRabbitRereviewDeps | undefined,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!deps || state.mergePolicy?.codeRabbit?.rereview !== true) return res;
  const repoPath = state.repoPath;
  if (!repoPath) return res;
  const memo: Record<string, string> = (state.raw.coderabbit_rereview ??= {});

  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    const pr = state.perSlice?.[sliceId]?.pr ?? slice?.pr;
    const number = Number(pr?.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const verdict = rereviewVerdict(slice, pr, memo[String(number)]);
    if (!verdict.request) continue;
    const head = String(pr.head_sha);
    const ref = { number, url: pr.url };
    // Memoized before the call: a failed comment is not retried for this head,
    // so a broken token cannot post-spam; the next push re-arms it.
    memo[String(number)] = head;
    res.mutated = true;
    try {
      await deps.commentOnPr(repoPath, number, CODERABBIT_REVIEW_COMMAND);
      res.actions.push({
        action: REREVIEW_ACTION,
        sliceId,
        pr: ref,
        detail: `asked CodeRabbit to re-review PR #${number} at ${head.slice(0, 7)} (its changes-requested review is on ${String(pr.coderabbit?.decision_commit_sha || "?").slice(0, 7)})`,
      });
    } catch (err: any) {
      res.failures.push({
        action: REREVIEW_FAILED_ACTION,
        sliceId,
        pr: ref,
        detail: `could not comment on PR #${number}: ${err?.message || String(err)}`,
      });
    }
  }
  return res;
}
