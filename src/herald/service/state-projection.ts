import type { MultiProfileState, SliceState, SystemState } from "../events.js";
import { resolveMergePolicyRow, type MergePolicy } from "../profiles/merge-policy.js";
import { deriveReviewState, type ReviewSnapshot, type ReviewState } from "../profiles/review-state.js";
import { taskTypeForSlice } from "../profiles/slice-verb.js";

export interface StateProjection extends SystemState {
  slices: Record<string, SliceState & { reviewState?: ReviewState }>;
}

export interface MultiStateProjection extends MultiProfileState {
  byProfile: Record<string, StateProjection>;
}

/** Add display fields to a detached fold. Neither the store nor its snapshots are written. */
export function projectReviewStates(
  state: StateProjection,
  backoffs: MultiProfileState["reviewBackoffs"],
  policy: MergePolicy | undefined,
  selfLogin: string,
  waitMs: number,
  now: Date,
): StateProjection {
  for (const [sliceId, slice] of Object.entries(state.slices)) {
    const pr = slice.pr as (ReviewSnapshot & { head_branch?: string }) | null | undefined;
    if (!Number.isSafeInteger(pr?.number) || !pr || pr.number < 1) continue;
    const verb = taskTypeForSlice(sliceId, { ...slice, branch: slice.branch || pr.head_branch });
    const row = resolveMergePolicyRow(policy, verb);
    slice.reviewState = deriveReviewState(pr, state.reviewRequests ?? [], backoffs, { ...row, selfLogin, waitMs }, now);
  }
  return state;
}
