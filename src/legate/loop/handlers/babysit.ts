import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { prNumber, workerBySessionId } from "../pure/session.js";
import { hashText } from "../pure/hash.js";
import { resolveMergeRequirements } from "../../../herald/profiles/merge-policy.js";
import {
  ciFixMessage,
  conflictMessage,
  failedChecksSummary,
  loginRequiredDetail,
  loginResumeMessage,
  reviewFixMessage,
  threadsNeedingResponse,
  workerErrorDetail,
} from "../pure/messages.js";

/**
 * Babysit: the steward watchdog. For every slice with a live worker session it
 * reacts to the worker's status and its PR's state — login-block recovery,
 * worker-error escalation, stranded-steward nudges, PR discovery, conflict /
 * review-thread / CI handling, and post-dispatch re-nudges for parked workers.
 *
 * Two-stage: assess() is PURE. It reads the per-slice PR + recent output that
 * Stage 1 (senseFromHerald) already gathered (the folded inbox surface) plus the
 * cadence counters living on each slice, and emits a flat list of
 * {@link BabysitDecision}s. apply() performs every send / state mutation /
 * judgement request and persists. Decisions are emitted in original tick order;
 * a single slice can yield several (e.g. clear-worker-error + a PR action, or
 * pr-snapshot + a PR action).
 */

// Stranded-steward watchdog: a slice stuck in "implementing" with no PR has
// almost certainly exited mid-workflow. Nudge at 10min, re-nudge every 5min,
// fire a one-time operator alert at 25min — but keep nudging (giving up strands
// the slice).
const STRANDED = { initialNudgeMs: 10 * 60 * 1000, repeatNudgeMs: 5 * 60 * 1000, alertEscalateMs: 25 * 60 * 1000 };

// Post-dispatch stuck-worker watchdog: after sending a /smithy.fix or conflict
// prompt, a worker that parks in waiting/idle gets the message re-delivered at
// 5min, every 5min, escalating after 3 unanswered re-nudges (~15min).
const POST_DISPATCH = { initialNudgeMs: 5 * 60 * 1000, repeatNudgeMs: 5 * 60 * 1000, escalateAfterNudges: 3 };

// Review-fix safety cap (#224): the most DISTINCT /smithy.fix rounds the loop
// will dispatch for a single review thread. A round = one dispatch that included
// a genuinely new (unseen) comment on that thread. A thread that won't clear
// after this many rounds is a real review dispute or a stuck worker — escalate
// to the operator rather than keep poking the steward.
const REVIEW_FIX_MAX_ROUNDS = 3;

// CI-fix bound (#303): failing CI gets a deterministic steward fix first
// (rebase onto the synced default + /smithy.fix with the failed-check summary),
// mirroring the conflict path, rather than escalating straight to the
// legate-agent. A "round" is one /smithy.fix dispatch against a distinct failing
// head SHA — so it counts genuine worker attempts, not CI re-runs of the same
// commit. After this many rounds still fail to clear CI, escalate to the
// legate-agent ONCE (the real-PR-diff-failure case that needs human judgement).
const CI_FIX_MAX_ROUNDS = 2;

const STRANDED_MESSAGE = [
  "[STRANDED-STEWARD-NUDGE] The deterministic loop sees no PR for this slice yet.",
  "Resume the Hatchery manager workflow where you left off:",
  "- If you haven't committed yet: run the verification, commit, push, then open the PR.",
  "- If you've committed but not pushed: 'git push -u origin <branch>'.",
  "- If you've pushed but not opened the PR: 'gh pr create' with title/body derived from",
  "  the artifact path and original request.",
  "",
  "OVERRIDE: If a repo-local pr-creation skill is gating PR creation on finding a",
  "linked GitHub issue, SKIP the issue search. Hatchery dispatches do NOT have a",
  "tracking issue. Compose the PR body without an issue link and run 'gh pr create'",
  "now. Mention 'No tracking issue (Hatchery autonomous dispatch)' in the body if",
  "the skill template requires an explanation.",
  "",
  "End your turn ONLY after one of:",
  "  (a) reporting 'PR: <url>' on the final line, or",
  "  (b) escalating via 'NEED: <summary> -- <next action>'.",
  "If a previous turn ended after 'git push' without 'gh pr create', that's the stranded-",
  "steward bug the loop is nudging you out of. Run 'gh pr create' now.",
].join("\n");

const TERMINAL_RESET_STAGES = ["pr-in-fix", "pr-resolving-conflicts", "pr-rebasing", "pr-in-rerun", "implementing"];

/** A judgement request to fire via {@link BabysitDeps.requestJudgement}. */
export interface JudgementInput {
  ts: string;
  slice: any;
  requestKey: string;
  sliceId: string;
  sessionId: string | null;
  pr?: any;
  prNumber?: any;
  reason: string;
  detail: string;
}

/** Side-effect seams (Castra send + the legate-judgement emitter from events). */
export interface BabysitDeps {
  /** Send a prompt to a worker session; rejects on transport failure. */
  /**
   * Send a prompt to a steward. `traceKey` (the slice id) forwards as the Castra
   * span-correlation header so the babysit `/smithy.fix` castra.send nests under
   * the slice's trace instead of orphaning a root (#234).
   */
  sendMessage: (sessionId: string, message: string, traceKey?: string) => Promise<void>;
  /** Append + doorbell a judgement request; resolves to the event, or null if deduped. */
  requestJudgement: (input: JudgementInput) => Promise<any | null>;
  /**
   * Squash-merge a gated PR (`gh pr merge --squash --match-head-commit`). Optional
   * so handlers/tests that never auto-merge can omit it; a `pr-auto-merge` decision
   * with no `mergePr` seam escalates to the operator instead of merging.
   */
  mergePr?: (input: { prNumber: number | string; headSha: string; repoPath?: string }) => Promise<{
    merged: boolean;
    mergeSha?: string;
    error?: string;
  }>;
}

export type BabysitDecision =
  | { kind: "login-block"; sliceId: string; sessionId: string; outputHash: string; requestKey: string; detail: string }
  | { kind: "login-resume-unverifiable"; sliceId: string; sessionId: string; requestKey: string; detail: string }
  | { kind: "login-resume-send"; sliceId: string; sessionId: string; key: string; message: string }
  | { kind: "worker-error"; sliceId: string; sessionId: string; requestKey: string; detail: string }
  | { kind: "clear-worker-error"; sliceId: string }
  | { kind: "steward-nudge"; sliceId: string; sessionId: string; nudge: boolean; alert: boolean; nextCount: number; detail: string; alertRequestKey: string; alertDetail: string }
  | { kind: "query-failed"; sliceId: string; sessionId: string; requestKey: string; detail: string; prNumber?: any }
  | { kind: "pr-snapshot"; sliceId: string; pr: any }
  | { kind: "discover-pr"; sliceId: string; sessionId: string; pr: any }
  | { kind: "unknown-pr-state"; sliceId: string; sessionId: string; pr: any; requestKey: string; detail: string }
  | { kind: "conflict-persisted"; sliceId: string; sessionId: string; pr: any; requestKey: string; detail: string }
  | { kind: "conflict-fix"; sliceId: string; sessionId: string; pr: any; key: string; message: string }
  | { kind: "post-dispatch-nudge"; sliceId: string; sessionId: string; pr: any; key: string; count: number; message: string; detail: string }
  | { kind: "nudge-exhausted"; sliceId: string; sessionId: string; pr: any; requestKey: string; reason: string; detail: string }
  | { kind: "review-fix"; sliceId: string; sessionId: string; pr: any; key: string; message: string; detail: string; threadIds: string[]; commentIds: string[] }
  | { kind: "review-fix-exhausted"; sliceId: string; sessionId: string; pr: any; requestKey: string; reason: string; detail: string; commentIds: string[] }
  | { kind: "ci-fix"; sliceId: string; sessionId: string; pr: any; key: string; message: string; detail: string }
  | { kind: "ci-failure"; sliceId: string; sessionId: string; pr: any; requestKey: string; detail: string }
  | { kind: "pr-open-clear"; sliceId: string; sessionId: string; pr: any }
  | { kind: "pr-auto-merge"; sliceId: string; sessionId: string; pr: any; key: string };

// ---- pure helpers ---------------------------------------------------------

function actionKey(action: string, pr: any, extra = ""): string {
  return [action, pr?.number || "", pr?.state || "", pr?.mergeable || "", pr?.checks || "", pr?.head_branch || "", extra].join(":");
}

/**
 * The smithy verb that keys a slice's per-task-type merge policy (e.g. "cut").
 * Tries, in order, the signals available on a slice — `command` is set at
 * dispatch on a warm loop, but the Herald fold is deliberately thin and does NOT
 * carry it, so after a cold-start rebuild we must fall back to the fold-durable
 * branch (`smithy/<verb>/…`) and the sliceId suffix (`…-<verb>`), both of which
 * the dispatch-id scheme guarantees. Undefined for non-smithy / unrecognized
 * shapes → resolveMergeRequirements falls back to all-required.
 */
function taskTypeForSlice(sliceId: string, slice: any): string | undefined {
  const fromCommand = String(slice?.command || "").match(/^smithy\.([a-z0-9_-]+)/i);
  if (fromCommand) return fromCommand[1].toLowerCase();
  const branch = String(slice?.actual_branch || slice?.branch || "");
  const fromBranch = branch.match(/(?:^|\/)smithy\/([a-z0-9_-]+)\//i);
  if (fromBranch) return fromBranch[1].toLowerCase();
  const fromId = String(sliceId || "").match(/-(cut|forge|mark|render|fix|strike)$/i);
  if (fromId) return fromId[1].toLowerCase();
  return undefined;
}

function workerErrorRequestKey(sessionId: string, slice: any, recent: any): string {
  const stage = slice.stage || "unknown";
  const pr = prNumber(slice) || "none";
  return `worker-error:${sessionId}:${stage}:${pr}:${hashText(recent.output || recent.error || "")}`;
}

function hasClaudeLoginBlock(output: any): boolean {
  const text = String(output || "");
  return text.includes("Please run /login") || text.includes("API Error: 401 Invalid authentication credentials");
}

function alreadyDispatched(slice: any, key: string): boolean {
  return slice.last_processor_action_key === key;
}

/**
 * Every review-comment id on a thread, as strings (#224). Falls back to the
 * thread id — which IS the first comment's databaseId — when sense-io did not
 * carry the per-comment list (older snapshots / hand-built test fixtures), so a
 * thread always contributes at least one id.
 */
function threadCommentIds(thread: any): string[] {
  const raw = Array.isArray(thread?.comment_ids) ? thread.comment_ids : [];
  const ids = raw.map((id: any) => String(id)).filter((id: string) => id.length > 0 && id !== "null" && id !== "undefined");
  if (ids.length > 0) return ids;
  const fallback = thread?.id;
  return fallback != null && String(fallback).length > 0 ? [String(fallback)] : [];
}

/** Distinct review-comment ids across a set of threads. */
function commentIdsAcross(threads: any[]): string[] {
  const ids = new Set<string>();
  for (const thread of threads) for (const id of threadCommentIds(thread)) ids.add(id);
  return [...ids];
}

function minutesSince(ts: string, since: string | undefined): number {
  return Math.round((Date.parse(ts) - Date.parse(since || ts)) / 60000);
}

/** Pure stranded-steward cadence: whether to nudge / alert this tick. */
function strandedNudge(slice: any, sessionId: string, ts: string): { nudge: boolean; alert: boolean; nextCount: number } | null {
  if (slice.stage !== "implementing" || !sessionId) return null;
  const startedAt = Date.parse(slice.implementing_started_at || slice.last_action || "");
  const nowMs = Date.parse(ts);
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return null;
  const elapsed = nowMs - startedAt;
  if (elapsed < STRANDED.initialNudgeMs) return null;
  const nudgedAt = Date.parse(slice.steward_nudge_sent_at || "");
  if (!Number.isFinite(nudgedAt)) return { nudge: true, alert: false, nextCount: 1 };
  const alert = elapsed >= STRANDED.alertEscalateMs && !slice.steward_stranded_escalated_at;
  if (nowMs - nudgedAt < STRANDED.repeatNudgeMs) {
    return alert ? { nudge: false, alert: true, nextCount: slice.steward_nudge_count || 1 } : null;
  }
  return { nudge: true, alert, nextCount: (slice.steward_nudge_count || 1) + 1 };
}

/** Pure post-dispatch cadence: re-nudge a parked worker, or signal escalation. */
function postDispatchNudge(slice: any, workerStatus: string, ts: string, key: string): { nudge: boolean; escalate: boolean; count: number } {
  const none = { nudge: false, escalate: false, count: 0 };
  if (workerStatus !== "waiting" && workerStatus !== "idle") return none;
  const lastDispatchAt = Date.parse(slice.last_processor_action_at || "");
  const nowMs = Date.parse(ts);
  if (!Number.isFinite(lastDispatchAt) || !Number.isFinite(nowMs)) return none;
  // A new dispatch (different action key) invalidates the prior nudge count.
  const reset = slice.post_dispatch_nudge_for_key !== key;
  const count = reset ? 0 : slice.post_dispatch_nudge_count || 0;
  const sentAt = reset ? NaN : Date.parse(slice.post_dispatch_nudge_sent_at || "");
  if (nowMs - lastDispatchAt < POST_DISPATCH.initialNudgeMs) return { nudge: false, escalate: false, count };
  if (count >= POST_DISPATCH.escalateAfterNudges) return { nudge: false, escalate: true, count };
  if (Number.isFinite(sentAt) && nowMs - sentAt < POST_DISPATCH.repeatNudgeMs) return { nudge: false, escalate: false, count };
  return { nudge: true, escalate: false, count: count + 1 };
}

// ---- assess ---------------------------------------------------------------

export function assess(state: LoopState): BabysitDecision[] {
  const out: BabysitDecision[] = [];
  const workers = workerBySessionId(state.sessions, state.workerGroup);

  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    if (slice.resume_pending === "selected") continue;
    const sessionId = String(slice.worker_session_id || "");
    if (!sessionId) continue;
    const worker = workers.get(sessionId);
    if (!worker) continue;
    const workerStatus = worker.status || "other";
    const ext = state.perSlice[sliceId] || {};
    const recent = ext.recentOutput || { output: "" };

    // 1. Login block.
    if (hasClaudeLoginBlock(recent.output)) {
      const outputHash = hashText(recent.output || recent.error || "");
      out.push({
        kind: "login-block",
        sliceId,
        sessionId,
        outputHash,
        requestKey: `login-required:${sessionId}:${outputHash}`,
        detail: loginRequiredDetail({ sliceId, slice, sessionId, recent }),
      });
      continue;
    }

    // 2. Login-blocked → maybe resume (output is no longer blocked here).
    if (slice.login_blocked_at || slice.login_blocked_session_id || slice.login_blocked_reason) {
      if (recent.error) {
        out.push({
          kind: "login-resume-unverifiable",
          sliceId,
          sessionId,
          requestKey: `login-refresh-unknown:${sessionId}:${hashText(recent.error)}`,
          detail: `Could not read worker output to verify login refresh for ${sliceId}: ${recent.error}`,
        });
        continue;
      }
      const key = ["login-resume", sessionId, slice.stage || "", prNumber(slice) || "", slice.login_blocked_at || ""].join(":");
      if (!alreadyDispatched(slice, key)) {
        out.push({ kind: "login-resume-send", sliceId, sessionId, key, message: loginResumeMessage(sliceId, slice) });
      }
      continue;
    }

    // 3. Worker error.
    if (workerStatus === "error") {
      out.push({
        kind: "worker-error",
        sliceId,
        sessionId,
        requestKey: workerErrorRequestKey(sessionId, slice, recent),
        detail: workerErrorDetail({ sliceId, slice, worker, sessionId, recent }),
      });
      continue;
    }

    // 4. Clear a stale worker-error marker (bookkeeping; not terminal).
    if (slice.worker_error_last_seen_at) out.push({ kind: "clear-worker-error", sliceId });

    // 5. Running workers are healthy — nothing to do.
    if (workerStatus === "running") continue;

    // 6. PR logic.
    evaluatePr(state, sliceId, slice, sessionId, workerStatus, ext, out);
  }
  return out;
}

function evaluatePr(
  state: LoopState,
  sliceId: string,
  slice: any,
  sessionId: string,
  workerStatus: string,
  ext: { pr?: any },
  out: BabysitDecision[],
): void {
  const ts = state.ts;
  let pr: any = null;
  let discovered = false;

  if (!slice.pr && slice.stage === "implementing" && (workerStatus === "waiting" || workerStatus === "idle")) {
    const cand = ext.pr;
    if (cand && !cand.skipped && !cand.error && cand.number) {
      pr = cand;
      discovered = true;
      out.push({ kind: "discover-pr", sliceId, sessionId, pr });
    }
  }

  if (!pr) {
    if (!slice.pr) {
      // Stranded-steward watchdog.
      const sd = strandedNudge(slice, sessionId, ts);
      if (sd && (sd.nudge || sd.alert)) {
        out.push({
          kind: "steward-nudge",
          sliceId,
          sessionId,
          nudge: sd.nudge,
          alert: sd.alert,
          nextCount: sd.nextCount,
          detail: "sent stranded-steward nudge (count " + sd.nextCount + ") — implementing for " + minutesSince(ts, slice.implementing_started_at) + "min with no PR",
          alertRequestKey: actionKey("steward-stranded", { number: 0 }, "alert"),
          alertDetail: "Slice has been in 'implementing' for >" + STRANDED.alertEscalateMs / 60000 + "min with no PR. The watchdog is still re-nudging every 5 min; operator can manually inspect the worktree at " + (slice.worktree_path || "(unknown)") + " and run 'gh pr create' if the steward is genuinely stuck.",
        });
      }
      return;
    }
    const queried = ext.pr;
    if (!queried || queried.error) {
      if (queried && queried.error) {
        out.push({
          kind: "query-failed",
          sliceId,
          sessionId,
          requestKey: actionKey("query-failed", slice.pr || {}, "query"),
          detail: queried.error,
          prNumber: slice.pr?.number,
        });
      }
      return;
    }
    if (queried.skipped) return;
    pr = queried;
    out.push({ kind: "pr-snapshot", sliceId, pr });
  }

  // Merged/closed PR short-circuit (#224): a merged PR must stop being babysat
  // regardless of thread state — no review-fix, no conflict-fix, no CI poke —
  // so a PR waiting on a default-branch sync can't keep getting prodded. The
  // pr-snapshot above already recorded its terminal state for cleanup to act on.
  if (pr.state === "MERGED" || pr.state === "CLOSED") return;
  if (pr.state !== "OPEN") {
    out.push({ kind: "unknown-pr-state", sliceId, sessionId, pr, requestKey: actionKey("unknown-pr-state", pr), detail: `state=${pr.state}` });
    return;
  }

  // Evaluate threads/stage as the worker would see them post-discovery.
  const evalSlice = discovered ? { ...slice, stage: "pr-open", pr_open_at: ts } : slice;

  if (pr.mergeable === "CONFLICTING") {
    if (slice.stage === "pr-resolving-conflicts") {
      out.push({
        kind: "conflict-persisted",
        sliceId,
        sessionId,
        pr,
        requestKey: actionKey("conflict-persisted", pr),
        detail: `PR #${pr.number} is still CONFLICTING after the processor previously sent a conflict-resolution prompt. Legate judgement is required before repeating recovery.`,
      });
      return;
    }
    const key = actionKey("conflict-fix", pr);
    if (alreadyDispatched(slice, key)) {
      const nd = postDispatchNudge(slice, workerStatus, ts, key);
      if (nd.nudge) {
        out.push({
          kind: "post-dispatch-nudge",
          sliceId,
          sessionId,
          pr,
          key,
          count: nd.count,
          message: conflictMessage(slice, pr, state.raw),
          detail: `re-sent conflict-fix prompt (nudge ${nd.count}/${POST_DISPATCH.escalateAfterNudges}) — worker ${workerStatus}`,
        });
      } else if (nd.escalate) {
        out.push({
          kind: "nudge-exhausted",
          sliceId,
          sessionId,
          pr,
          requestKey: actionKey("conflict-nudges-exhausted", pr, key),
          reason: "worker_unresponsive_after_conflict_fix",
          detail: `Sent ${nd.count} conflict-fix nudges to PR #${pr.number} worker (session ${sessionId}); still ${workerStatus}. Operator should attach and inspect.`,
        });
      }
      return;
    }
    out.push({ kind: "conflict-fix", sliceId, sessionId, pr, key, message: conflictMessage(slice, pr, state.raw) });
    return;
  }

  const neededThreads = threadsNeedingResponse(evalSlice, pr);
  if (neededThreads.length > 0) {
    // Dedup by review-comment id, not last_comment_at (#224). The old key
    // (`thread.id@last_comment_at`) churned on every reply, so a steward
    // addressing a thread (push + reply) re-armed /smithy.fix forever. Instead
    // remember the comment ids already dispatched for (refreshed each tick from
    // the observed unresolved threads — see snapshot()) and only fire on
    // genuinely new (unseen) ids — any author. A fixed-but-unresolved thread
    // contributes no new id, so it stops triggering; the steward's own reply,
    // once observed, is already in `seen` and never re-triggers.
    const seen = new Set<string>((slice.review_fix_seen_comment_ids || []).map((id: any) => String(id)));
    const threadsWithNew = neededThreads.filter((thread: any) => threadCommentIds(thread).some((id) => !seen.has(id)));

    if (threadsWithNew.length === 0) {
      // No unseen comments on any needed thread. Never start a fresh /smithy.fix
      // here — only re-nudge a worker that parked after a review-fix dispatch it
      // never acted on (the genuine stuck-worker case), bounded + escalating.
      if (slice.last_processor_action === "review-fix" && !slice.review_fix_escalated_at) {
        const key = slice.last_processor_action_key || actionKey("review-fix", pr);
        const nd = postDispatchNudge(slice, workerStatus, ts, key);
        if (nd.nudge) {
          out.push({
            kind: "post-dispatch-nudge",
            sliceId,
            sessionId,
            pr,
            key,
            count: nd.count,
            message: reviewFixMessage(pr, neededThreads),
            detail: `re-sent /smithy.fix (nudge ${nd.count}/${POST_DISPATCH.escalateAfterNudges}) — worker ${workerStatus} ${minutesSince(ts, slice.last_processor_action_at)}min after dispatch`,
          });
        } else if (nd.escalate) {
          out.push({
            kind: "nudge-exhausted",
            sliceId,
            sessionId,
            pr,
            requestKey: actionKey("review-nudges-exhausted", pr, key),
            reason: "worker_unresponsive_after_review_fix",
            detail: `Sent ${nd.count} /smithy.fix nudges to PR #${pr.number} worker (session ${sessionId}) and still ${workerStatus} with ${neededThreads.length} thread(s) needing response. Likely parked at a permission prompt or a stuck spinner. Operator should attach and inspect, or close the slice if the worker is unrecoverable.`,
          });
        }
      }
      return;
    }

    // New, unseen comments exist. Bound distinct /smithy.fix rounds per thread
    // (#224): beyond REVIEW_FIX_MAX_ROUNDS, a thread that won't clear is a
    // genuine dispute or a stuck worker — escalate instead of re-dispatching.
    const rounds: Record<string, number> = slice.review_fix_rounds || {};
    const dispatchable = threadsWithNew.filter((thread: any) => (rounds[String(thread.id)] || 0) < REVIEW_FIX_MAX_ROUNDS);
    const exhausted = threadsWithNew.filter((thread: any) => (rounds[String(thread.id)] || 0) >= REVIEW_FIX_MAX_ROUNDS);

    if (exhausted.length > 0) {
      out.push({
        kind: "review-fix-exhausted",
        sliceId,
        sessionId,
        pr,
        requestKey: actionKey("review-fix-rounds-exhausted", pr, exhausted.map((thread: any) => String(thread.id)).join(",")),
        reason: "review_fix_rounds_exhausted",
        detail: `PR #${pr.number} has ${exhausted.length} review thread(s) still unresolved after ${REVIEW_FIX_MAX_ROUNDS} /smithy.fix round(s) each. This is likely a genuine review dispute or a stuck worker, not something the loop should keep poking. Operator should review the threads and resolve them, re-instruct the steward, or close the slice.`,
        commentIds: commentIdsAcross(exhausted),
      });
    }

    if (dispatchable.length > 0) {
      const newIds = commentIdsAcross(dispatchable).filter((id) => !seen.has(id));
      const key = actionKey("review-fix", pr, [...newIds].sort().join(","));
      out.push({
        kind: "review-fix",
        sliceId,
        sessionId,
        pr,
        key,
        message: reviewFixMessage(pr, dispatchable),
        detail: `sent /smithy.fix for ${dispatchable.length} review thread(s) (${newIds.length} new comment(s))`,
        threadIds: dispatchable.map((thread: any) => String(thread.id)),
        commentIds: commentIdsAcross(dispatchable),
      });
    }
    return;
  }

  if (pr.checks === "FAIL") {
    // Fix-first, escalate-on-persist — the conflict path's shape applied to CI
    // (#303). "Ask the steward to rebase + /smithy.fix" is safe to attempt
    // deterministically and clears the common stale-main / fixable-failure
    // cases; the legate-agent is only needed once bounded attempts don't take.
    const key = actionKey("ci-fix", pr, String(pr.head_sha || ""));
    if (alreadyDispatched(slice, key)) {
      // A ci-fix for THIS head SHA already went out; the same SHA is still
      // failing. Only re-nudge a worker that parked without pushing a fix
      // (bounded + escalating) — don't count it as a fresh attempt.
      const nd = postDispatchNudge(slice, workerStatus, ts, key);
      if (nd.nudge) {
        out.push({
          kind: "post-dispatch-nudge",
          sliceId,
          sessionId,
          pr,
          key,
          count: nd.count,
          message: ciFixMessage(slice, pr, state.raw),
          detail: `re-sent ci-fix prompt (nudge ${nd.count}/${POST_DISPATCH.escalateAfterNudges}) — worker ${workerStatus}`,
        });
      } else if (nd.escalate) {
        out.push({
          kind: "nudge-exhausted",
          sliceId,
          sessionId,
          pr,
          requestKey: actionKey("ci-nudges-exhausted", pr, key),
          reason: "worker_unresponsive_after_ci_fix",
          detail: `Sent ${nd.count} ci-fix nudges to PR #${pr.number} worker (session ${sessionId}); still ${workerStatus} with failing CI. Operator should attach and inspect.`,
        });
      }
      return;
    }
    const rounds = Number(slice.ci_fix_rounds || 0);
    if (rounds >= CI_FIX_MAX_ROUNDS) {
      // Bounded steward attempts exhausted (a fresh failing head SHA after
      // CI_FIX_MAX_ROUNDS /smithy.fix rounds). This is the real-PR-diff-failure
      // case — escalate to the legate-agent for human judgement, exactly once.
      if (!slice.ci_fix_escalated_at) {
        out.push({
          kind: "ci-failure",
          sliceId,
          sessionId,
          pr,
          requestKey: actionKey("ci-failure", pr, (pr.failed_checks || []).map((c: any) => `${c.name}:${c.url || ""}`).join(",")),
          detail: `PR #${pr.number} still has failing CI after ${rounds} deterministic steward fix round(s) (rebase + /smithy.fix). This looks like a real PR-diff failure, not stale-main or a flake the loop can clear on its own. Failed checks:\n${failedChecksSummary(pr)}`,
        });
      }
      return;
    }
    // Dispatch the steward to fix it first.
    out.push({
      kind: "ci-fix",
      sliceId,
      sessionId,
      pr,
      key,
      message: ciFixMessage(slice, pr, state.raw),
      detail: `sent ci-fix /smithy.fix (round ${rounds + 1}/${CI_FIX_MAX_ROUNDS}) for failing CI on PR #${pr.number}`,
    });
    return;
  }

  if (pr.checks === "PASS" && pr.needs_response_count === 0 && pr.mergeable !== "CONFLICTING") {
    // Record the one-time transition into the all-clear `pr-open` stage (the loop
    // confirmed CI/threads/conflicts). This happens regardless of the merge gate.
    if (TERMINAL_RESET_STAGES.includes(slice.stage)) {
      out.push({ kind: "pr-open-clear", sliceId, sessionId, pr });
    }
    // Auto-merge gate (#merge-requirements-by-type): on top of the all-clear
    // precondition, enforce the human-review requirements — relaxable per task
    // type by the profile's merge policy (e.g. cut drops the approval gate). An
    // unknown verb / no policy resolves to all-required.
    const req = resolveMergeRequirements(state.mergePolicy, taskTypeForSlice(sliceId, slice));
    const approvalOk = !req.approval || Number(pr.human_approval_count ?? 0) >= 1;
    const crOk = !req.changesRequested || Number(pr.changes_requested_count ?? 0) === 0;
    // Only attempt the merge when GitHub itself says the button is available
    // (mergeStateStatus == clean) — this enforces the repo's own branch-protection
    // rules and avoids dispatching a merge GitHub will reject (DRAFT/BLOCKED/BEHIND).
    const mergeStateOk = String(pr.merge_state_status || "").toLowerCase() === "clean";
    if (approvalOk && crOk && mergeStateOk && pr.head_sha) {
      // Dedup on every gate-relevant dynamic field, not head_sha alone (#283
      // review): a failed/transient attempt must re-arm if the merge state clears,
      // an approval is added, or a CR is dismissed without a new push — otherwise
      // the PR could stay stuck in pr-open until the head SHA changes.
      const key = actionKey(
        "pr-auto-merge",
        pr,
        [pr.head_sha, pr.merge_state_status, pr.human_approval_count ?? "", pr.changes_requested_count ?? ""].join("|"),
      );
      if (!alreadyDispatched(slice, key)) {
        out.push({ kind: "pr-auto-merge", sliceId, sessionId, pr, key });
      }
    }
    return;
  }
  // PENDING / UNKNOWN: nothing to do this tick.
}

// ---- apply ----------------------------------------------------------------

function mark(slice: any, action: string, key: string, note: string, ts: string): void {
  slice.last_processor_action = action;
  slice.last_processor_action_key = key;
  slice.last_processor_action_at = ts;
  slice.last_action = ts;
  slice.last_action_note = note;
}

function snapshot(slice: any, pr: any): void {
  slice.pr = { number: pr.number, url: pr.url, state: pr.state, checks: pr.checks, mergeable: pr.mergeable };
  if (pr.head_branch) slice.actual_branch = pr.head_branch;
  slice.thread_count = pr.thread_count;
  slice.needs_response_count = pr.needs_response_count;
  slice.unresolved_threads = pr.unresolved_threads;
}

/** Fold handled comment ids into the review-fix dedup set, union-merged so a
 *  comment is only ever recorded as seen once it has actually been dispatched
 *  for (or escalated) — never speculatively before a send that may fail (#224). */
function markCommentsSeen(slice: any, commentIds: string[]): void {
  slice.review_fix_seen_comment_ids = [...new Set([...(slice.review_fix_seen_comment_ids || []).map((id: any) => String(id)), ...commentIds])];
}

function clearLoginBlocked(slice: any): void {
  delete slice.login_blocked_at;
  delete slice.login_blocked_session_id;
  delete slice.login_blocked_reason;
  delete slice.login_blocked_output_hash;
}

export async function apply(decisions: BabysitDecision[], ctx: HandlerContext, state: LoopState, deps: BabysitDeps): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  const ts = ctx.ts;
  const fireRequest = async (input: JudgementInput): Promise<void> => {
    const event = await deps.requestJudgement(input);
    if (event) {
      res.requests.push(event);
      res.mutated = true;
    }
  };

  for (const d of decisions) {
    const slice = state.slices[d.sliceId];
    if (!slice) continue;

    switch (d.kind) {
      case "login-block": {
        if (!slice.login_blocked_at) slice.login_blocked_at = ts;
        slice.login_blocked_session_id = d.sessionId;
        slice.login_blocked_reason = "claude_api_401_login_required";
        slice.login_blocked_output_hash = d.outputHash;
        slice.last_action = ts;
        slice.last_action_note = "worker blocked on Claude Code login refresh";
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: slice.pr || null, reason: "claude_api_401_login_required", detail: d.detail });
        res.mutated = true;
        break;
      }
      case "login-resume-unverifiable":
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: slice.pr || null, reason: "could not verify Claude login refresh", detail: d.detail });
        break;
      case "login-resume-send": {
        try {
          await deps.sendMessage(d.sessionId, d.message, d.sliceId);
        } catch (err: any) {
          await fireRequest({ ts, slice, requestKey: `login-resume-send-failed:${d.sessionId}:${slice.login_blocked_at || ""}`, sliceId: d.sliceId, sessionId: d.sessionId, pr: slice.pr || null, reason: "processor failed to send login-refresh resume prompt", detail: err?.message || String(err) });
          break;
        }
        clearLoginBlocked(slice);
        mark(slice, "login-resume", d.key, "processor sent login-refresh resume prompt", ts);
        res.actions.push({ action: "login-resume", sliceId: d.sliceId, sessionId: d.sessionId, pr: slice.pr || null, detail: "sent resume prompt after Claude login refresh" });
        res.mutated = true;
        break;
      }
      case "worker-error": {
        if (!slice.worker_error_detected_at) slice.worker_error_detected_at = ts;
        slice.worker_error_last_seen_at = ts;
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: slice.pr || null, reason: "worker_session_error", detail: d.detail });
        res.mutated = true;
        break;
      }
      case "clear-worker-error":
        delete slice.worker_error_detected_at;
        delete slice.worker_error_last_seen_at;
        res.mutated = true;
        break;
      case "steward-nudge": {
        // The nudge and the escalation are recorded as distinct actions so each
        // is metricized on its own (#212): a runaway watchdog shows up as a
        // sustained `steward-nudge` rate, an escalation as `steward-stranded`.
        if (d.nudge) {
          try {
            await deps.sendMessage(d.sessionId, STRANDED_MESSAGE, d.sliceId);
            slice.steward_nudge_sent_at = ts;
            slice.steward_nudge_count = d.nextCount;
            // Record the action only after a successful send so steward_nudge_count
            // (and the exported metric) counts nudges actually delivered — a
            // messaging outage must not masquerade as a runaway-nudge loop.
            res.actions.push({ action: "steward-nudge", sliceId: d.sliceId, sessionId: d.sessionId, detail: d.detail });
          } catch {
            // send failed — leave counters unrecorded; next tick retries.
          }
        }
        if (d.alert) {
          slice.steward_stranded_escalated_at = ts;
          await fireRequest({ ts, slice, requestKey: d.alertRequestKey, sliceId: d.sliceId, sessionId: d.sessionId, reason: "steward stranded after dispatch (watchdog still nudging)", detail: d.alertDetail });
          res.actions.push({ action: "steward-stranded", sliceId: d.sliceId, sessionId: d.sessionId, detail: d.alertDetail });
        }
        res.mutated = true;
        break;
      }
      case "query-failed":
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, prNumber: d.prNumber, reason: "processor could not query PR state", detail: d.detail });
        break;
      case "pr-snapshot":
        snapshot(slice, d.pr);
        res.mutated = true;
        break;
      case "discover-pr":
        snapshot(slice, d.pr);
        slice.stage = "pr-open";
        slice.pr_open_at = ts;
        mark(slice, "discover-pr", actionKey("discover-pr", d.pr), "processor discovered PR", ts);
        ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "pr-open" });
        res.actions.push({ action: "discover-pr", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: "discovered worker PR" });
        res.mutated = true;
        break;
      case "unknown-pr-state":
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "unknown PR state", detail: d.detail });
        break;
      case "conflict-persisted":
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "merge conflict persisted after processor prompt", detail: d.detail });
        break;
      case "conflict-fix": {
        try {
          await deps.sendMessage(d.sessionId, d.message, d.sliceId);
        } catch (err: any) {
          await fireRequest({ ts, slice, requestKey: actionKey("conflict-send-failed", d.pr), sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "processor failed to send conflict-resolution prompt", detail: err?.message || String(err) });
          break;
        }
        slice.stage = "pr-resolving-conflicts";
        mark(slice, "conflict-fix", d.key, "processor sent conflict-resolution fix", ts);
        ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "pr-resolving-conflicts" });
        res.actions.push({ action: "conflict-fix", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: "sent conflict-resolution prompt" });
        res.mutated = true;
        break;
      }
      case "post-dispatch-nudge": {
        try {
          await deps.sendMessage(d.sessionId, d.message, d.sliceId);
        } catch {
          break;
        }
        slice.post_dispatch_nudge_for_key = d.key;
        slice.post_dispatch_nudge_sent_at = ts;
        slice.post_dispatch_nudge_count = d.count;
        res.actions.push({ action: "post-dispatch-nudge", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: d.detail });
        res.mutated = true;
        break;
      }
      case "nudge-exhausted":
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: d.reason, detail: d.detail });
        break;
      case "review-fix": {
        try {
          await deps.sendMessage(d.sessionId, d.message, d.sliceId);
        } catch (err: any) {
          await fireRequest({ ts, slice, requestKey: actionKey("review-send-failed", d.pr, d.key), sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "processor failed to send review-thread /smithy.fix", detail: err?.message || String(err) });
          break;
        }
        slice.stage = "pr-in-fix";
        // Only NOW — after a successful send — record these comments as seen, so
        // a transient send failure above is retried next tick instead of being
        // silently dropped (#224). Count this distinct round against each
        // dispatched thread's safety cap and clear any prior exhaustion marker.
        markCommentsSeen(slice, d.commentIds || []);
        const rounds: Record<string, number> = slice.review_fix_rounds || (slice.review_fix_rounds = {});
        for (const threadId of d.threadIds || []) rounds[threadId] = (rounds[threadId] || 0) + 1;
        delete slice.review_fix_escalated_at;
        mark(slice, "review-fix", d.key, "processor sent review-thread /smithy.fix", ts);
        ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "pr-in-fix" });
        res.actions.push({ action: "review-fix", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: d.detail });
        res.mutated = true;
        break;
      }
      case "review-fix-exhausted":
        // Latch so the no-new-comment branch stops re-nudging /smithy.fix for a
        // thread set we just told the operator to take over (#224). Cleared on
        // the next genuine dispatch or when the PR goes all-clear. Mark the
        // escalated comments seen so the escalation isn't recomputed every tick.
        slice.review_fix_escalated_at = ts;
        markCommentsSeen(slice, d.commentIds || []);
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: d.reason, detail: d.detail });
        res.mutated = true;
        break;
      case "ci-fix": {
        try {
          await deps.sendMessage(d.sessionId, d.message, d.sliceId);
        } catch (err: any) {
          await fireRequest({ ts, slice, requestKey: actionKey("ci-fix-send-failed", d.pr), sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "processor failed to send CI-fix prompt", detail: err?.message || String(err) });
          break;
        }
        slice.stage = "pr-in-rerun";
        // Count this round only after a successful send so a transient outage is
        // retried next tick rather than burning an attempt against the budget.
        slice.ci_fix_rounds = Number(slice.ci_fix_rounds || 0) + 1;
        mark(slice, "ci-fix", d.key, "processor sent CI-failure fix", ts);
        ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "pr-in-rerun" });
        res.actions.push({ action: "ci-fix", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: d.detail });
        res.mutated = true;
        break;
      }
      case "ci-failure":
        slice.ci_fix_escalated_at = ts;
        await fireRequest({ ts, slice, requestKey: d.requestKey, sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "CI failure requires Legate judgement", detail: d.detail });
        res.mutated = true;
        break;
      case "pr-open-clear":
        slice.stage = "pr-open";
        slice.pr_open_at = ts;
        // PR is all-clear: reset the per-thread round counters and clear the
        // exhaustion latch so a future review thread starts a fresh budget (#224).
        delete slice.review_fix_rounds;
        delete slice.review_fix_escalated_at;
        // Same for the CI-fix budget (#303): a later CI failure starts fresh.
        delete slice.ci_fix_rounds;
        delete slice.ci_fix_escalated_at;
        mark(slice, "pr-open", actionKey("pr-open", d.pr), "processor observed PR all clear", ts);
        ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "pr-open" });
        res.actions.push({ action: "pr-open", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: "observed PR all clear" });
        res.mutated = true;
        break;
      case "pr-auto-merge": {
        if (!deps.mergePr) {
          // No merge seam wired — surface it rather than silently stalling.
          await fireRequest({ ts, slice, requestKey: actionKey("auto-merge-unconfigured", d.pr, String(d.pr.head_sha)), sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "auto_merge_unconfigured", detail: `PR #${d.pr.number} cleared the merge gate but no merge seam is configured.` });
          break;
        }
        // Mark BEFORE awaiting so a failed/transient attempt isn't retried against
        // the same head SHA every tick (dedup key includes head_sha). A new worker
        // push changes the SHA → a fresh key → a fresh attempt.
        mark(slice, "pr-auto-merge", d.key, `auto-merging PR #${d.pr.number} (squash, sha=${d.pr.head_sha})`, ts);
        let result: { merged: boolean; mergeSha?: string; error?: string };
        try {
          result = await deps.mergePr({ prNumber: d.pr.number, headSha: String(d.pr.head_sha), repoPath: state.repoPath });
        } catch (err: any) {
          result = { merged: false, error: err?.message || String(err) };
        }
        if (result.merged) {
          slice.stage = "merged";
          if (slice.pr) slice.pr.state = "MERGED";
          slice.last_action_note = `merged via legate auto-merge — squash, sha=${result.mergeSha || d.pr.head_sha}`;
          ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: "merged" });
          res.actions.push({ action: "pr-auto-merge", sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, detail: `squash-merged PR #${d.pr.number} (sha=${result.mergeSha || d.pr.head_sha})` });
          res.mutated = true;
        } else {
          // Merge failed (head-SHA race, transient gh error, repo rule). Leave the
          // slice at pr-open and escalate; cleanup will sweep it if it actually
          // merged out-of-band, the gate re-evaluates next tick otherwise.
          slice.last_action_note = `auto-merge failed: ${result.error || "unknown error"}`;
          await fireRequest({ ts, slice, requestKey: actionKey("auto-merge-failed", d.pr, String(d.pr.head_sha)), sliceId: d.sliceId, sessionId: d.sessionId, pr: d.pr, reason: "auto_merge_failed", detail: `auto-merge of PR #${d.pr.number} failed: ${result.error || "unknown error"}` });
          res.mutated = true;
        }
        break;
      }
    }
  }

  return res;
}
