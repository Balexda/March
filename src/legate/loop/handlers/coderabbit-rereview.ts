import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { CODERABBIT_REVIEW_COMMAND, reviewRequestBody } from "../../../observe/coderabbit-review.js";

/**
 * CodeRabbit review requests (opt-in: `mergePolicy.codeRabbit.rereview` and
 * `mergePolicy.codeRabbit.initialReview`).
 *
 * CodeRabbit's `CHANGES_REQUESTED` review blocks the merge on GitHub until
 * CodeRabbit reviews again and approves; the steward resolving its threads does
 * not clear it. CodeRabbit auto-review is off at the org level, so nothing asks
 * for that second review and a fixed PR sits forever. When the profile opts in,
 * this handler comments {@link CODERABBIT_REVIEW_COMMAND} on a slice PR once the
 * steward has answered CodeRabbit, which gives CodeRabbit the chance to approve.
 *
 * `initialReview` covers the step before that: no one asks CodeRabbit for its
 * *first* review either, so a slice PR it has never looked at waits for a human
 * approval that never comes. With it on, the handler makes that first request too.
 *
 * A request is made only when ALL of these hold (see {@link rereviewVerdict}):
 *   - the slice is `pr-open`: its steward is idle, not mid-fix or mid-rerun;
 *   - either (re-review) CodeRabbit's latest decisive review is
 *     `CHANGES_REQUESTED`, on a commit other than the current head (the steward
 *     has pushed since), or (first review) CodeRabbit has never reviewed the PR
 *     in any state;
 *   - no review thread still owes the steward a reply, the PR is not in conflict
 *     and CI is not failing — babysit dispatches those fixes first;
 *   - the current head has not been put forward yet: the newest request the
 *     legate posted on GitHub does not name it (durable: each request carries a
 *     `march-coderabbit-request:<sha>` marker) and this process has not already
 *     posted for it (warm memo).
 *
 * The natural bound is one request per pushed head. If CodeRabbit asks for more
 * changes, its new review is on the head, so nothing fires until the steward
 * pushes again. The merge gate is untouched: an approval CodeRabbit leaves counts
 * only where the profile accepts bot approvals (`botApproval`).
 */

export const REREVIEW_ACTION = "coderabbit-rereview-requested";
export const REREVIEW_FAILED_ACTION = "coderabbit-rereview-failed";

export interface CodeRabbitRereviewDeps {
  commentOnPr(repoPath: string, prNumber: number, body: string, sliceId?: string): Promise<void>;
}

export type RequestKind = "rereview" | "initial";
export type RereviewVerdict = { request: true; kind: RequestKind } | { request: false; reason: string };

/** Which requests the profile opts into. */
export interface RequestModes {
  rereview: boolean;
  initialReview: boolean;
}

const REREVIEW_ONLY: RequestModes = { rereview: true, initialReview: false };

/**
 * True only when Herald positively reports CodeRabbit never reviewed the PR:
 * `null` standing (no review, no request), or a standing with no decision and
 * a `null` last-reviewed commit. A missing field (an older snapshot) is unknown.
 */
function neverReviewed(cr: any): boolean {
  if (cr === null) return true;
  return !!cr && typeof cr === "object" && !cr.decision && cr.last_review_commit_sha === null;
}

/** Pure decision for one slice. `memoHead` is the head this process last requested for. */
export function rereviewVerdict(slice: any, pr: any, memoHead?: string, modes: RequestModes = REREVIEW_ONLY): RereviewVerdict {
  if (slice?.stage !== "pr-open") return { request: false, reason: "steward-busy" };
  if (!pr || typeof pr !== "object" || pr.state !== "OPEN") return { request: false, reason: "no-open-pr" };
  const head = typeof pr.head_sha === "string" ? pr.head_sha : "";
  if (!head) return { request: false, reason: "no-head" };
  const cr = pr.coderabbit;
  let kind: RequestKind;
  if (cr?.decision === "CHANGES_REQUESTED" && modes.rereview) {
    if (cr.decision_commit_sha === head) return { request: false, reason: "head-already-reviewed" };
    kind = "rereview";
  } else if (modes.initialReview && neverReviewed(cr)) {
    kind = "initial";
  } else if (modes.initialReview && cr === undefined) {
    // Sensed before Herald reported CodeRabbit's standing: unknown, so wait for
    // a fresh detail fetch rather than ask a bot that may already have reviewed.
    return { request: false, reason: "not-sensed" };
  } else {
    return { request: false, reason: "not-changes-requested" };
  }
  if (Number(pr.needs_response_count ?? 0) > 0) return { request: false, reason: "threads-owed" };
  if (pr.mergeable === "CONFLICTING" || pr.merge_state_status === "dirty") return { request: false, reason: "conflicted" };
  if (pr.checks === "FAIL") return { request: false, reason: "ci-failing" };
  if (memoHead === head || cr?.last_request_sha === head) return { request: false, reason: "already-requested" };
  return { request: true, kind };
}

export async function apply(
  _ctx: HandlerContext,
  state: LoopState,
  deps: CodeRabbitRereviewDeps | undefined,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  const policy = state.mergePolicy?.codeRabbit;
  const modes: RequestModes = { rereview: policy?.rereview === true, initialReview: policy?.initialReview === true };
  if (!deps || (!modes.rereview && !modes.initialReview)) return res;
  const repoPath = state.repoPath;
  if (!repoPath) return res;
  const memo: Record<string, string> = (state.raw.coderabbit_rereview ??= {});

  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    const pr = state.perSlice?.[sliceId]?.pr ?? slice?.pr;
    const number = Number(pr?.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const verdict = rereviewVerdict(slice, pr, memo[String(number)], modes);
    if (!verdict.request) continue;
    const head = String(pr.head_sha);
    const ref = { number, url: pr.url };
    // Memoized before the call: a failed comment is not retried for this head,
    // so a broken token cannot post-spam; the next push re-arms it.
    memo[String(number)] = head;
    res.mutated = true;
    try {
      await deps.commentOnPr(repoPath, number, reviewRequestBody(head), sliceId);
      res.actions.push({
        action: REREVIEW_ACTION,
        sliceId,
        pr: ref,
        detail:
          verdict.kind === "initial"
            ? `asked CodeRabbit for its first review of PR #${number} at ${head.slice(0, 7)}`
            : `asked CodeRabbit to re-review PR #${number} at ${head.slice(0, 7)} (its changes-requested review is on ${String(pr.coderabbit?.decision_commit_sha || "?").slice(0, 7)})`,
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
