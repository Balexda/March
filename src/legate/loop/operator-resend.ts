/**
 * Operator RESEND of review threads (#593): the decision + record logic behind
 * `POST /slices/:sliceId/review-threads/resend`, with its I/O injected so the
 * send/relaunch/requeue overlap is testable end to end. The runtime wraps it with
 * the real Castra send, Herald append and warm-state lookup.
 */
import type { LegateHerald } from "./clients/herald.js";
import {
  relaunchGeneration,
  resendStillCurrent,
  resolveResendTarget,
  type OperatorActionResult,
  type ResendThreadsInput,
  type ResendThreadsResult,
} from "./http.js";
import { reviewFixMessage } from "./pure/messages.js";

export interface ResendDeps {
  /** Deliver the /smithy.fix message into the steward session. */
  send: (sessionId: string, message: string) => Promise<void>;
  /** The warm slice entry for the slice id as of now (re-read after the send). */
  currentSlice: () => any;
  /** Append the attributed record event; a refusal result when Herald rejects it. */
  record: (event: Parameters<LegateHerald["append"]>[1]) => Promise<OperatorActionResult | null>;
  now: () => string;
}

export interface ResendOutcome {
  result: ResendThreadsResult;
  /** Extra span attributes (e.g. `march.failure_stage`). */
  attributes?: Record<string, string | number>;
}

/**
 * Resend the named (or every unresolved) review thread to the slice's steward and
 * record it like babysit's review-fix. `slice` is the warm entry captured before
 * the send; `observedPr` is Herald's PR observation for it.
 */
export async function resendWithDeps(
  input: ResendThreadsInput,
  slice: any,
  observedPr: any,
  deps: ResendDeps,
): Promise<ResendOutcome> {
  const resolved = resolveResendTarget(slice, observedPr, input.threadIds);
  if (!resolved.ok) {
    return { result: { ok: false, status: resolved.status, profile: input.profile, sliceId: input.sliceId, error: resolved.error } };
  }
  const { pr, prNumber, threads, threadIds, commentIds, sessionId } = resolved;
  const generation = relaunchGeneration(slice);
  try {
    await deps.send(sessionId, reviewFixMessage(pr, threads));
  } catch (err: any) {
    return {
      result: {
        ok: false,
        status: 502,
        profile: input.profile,
        sliceId: input.sliceId,
        error: `failed to deliver /smithy.fix to session ${sessionId}: ${err?.message ?? String(err)} — relaunch the steward and retry.`,
      },
      attributes: { "march.failure_stage": "delivery" },
    };
  }

  // The tick may have requeued the slice during the send (a new warm entry under
  // the same id) or made a relaunch attempt on its steward (generation bumped,
  // even if that attempt removed the session and then failed to launch).
  // Recording now would mark the old comment ids handled for a steward that never
  // got them, so refuse to record.
  if (!resendStillCurrent(deps.currentSlice(), slice, sessionId, generation)) {
    return {
      result: {
        ok: false,
        status: 409,
        profile: input.profile,
        sliceId: input.sliceId,
        delivered: true,
        threadIds,
        commentIds,
        error: `delivered to session ${sessionId}, but the slice was requeued or its steward relaunched while sending — not recorded; re-send to reach the new steward.`,
      },
      attributes: { "march.failure_stage": "incarnation" },
    };
  }

  // Record it like babysit's review-fix so dedup, the round cap and the bounded
  // post-dispatch nudge all see this dispatch.
  const ts = deps.now();
  const key = ["operator-resend", prNumber, [...commentIds].sort().join(",")].join(":");
  const seen = new Set<string>((slice.review_fix_seen_comment_ids || []).map((id: any) => String(id)));
  for (const id of commentIds) seen.add(id);
  slice.review_fix_seen_comment_ids = [...seen];
  const rounds: Record<string, number> = slice.review_fix_rounds || (slice.review_fix_rounds = {});
  for (const id of threadIds) rounds[id] = (rounds[id] || 0) + 1;
  delete slice.review_fix_escalated_at;
  if (slice.stage === "pr-open") slice.stage = "pr-in-fix";
  slice.last_processor_action = "review-fix";
  slice.last_processor_action_key = key;
  slice.last_processor_action_at = ts;
  slice.last_action = ts;
  slice.last_action_note = `operator re-sent ${threadIds.length} review thread(s) as /smithy.fix`;

  const recorded = await deps.record({
    type: "slice.stage.changed",
    sliceId: input.sliceId,
    stage: String(slice.stage),
    handledFeedback: { kind: "inline", commentIds, dispatchKey: key },
  });
  const base = { profile: input.profile, sliceId: input.sliceId, delivered: true, threadIds, commentIds };
  if (recorded) {
    // Delivered, but the fold did not record it: report the partial outcome.
    return { result: { ...base, ok: false, status: 502, error: `delivered, but ${recorded.error}` }, attributes: { "march.failure_stage": "record" } };
  }
  return { result: { ...base, ok: true }, attributes: { "march.pr_number": prNumber, "march.threads": threadIds.length } };
}
