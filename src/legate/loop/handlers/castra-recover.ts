import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { isWorkerSession } from "../pure/session.js";

/**
 * Castra session recovery (#castra-recover). After a host reboot the worker
 * sessions still EXIST in agent-deck but report `status: "error"` (their tmux
 * panes died). That's invisible to `relaunch` — which only fires when a session
 * has VANISHED — and `babysit` would escalate the still-present-but-errored
 * worker as a worker-error. So this handler runs EARLY in the tick (before
 * relaunch/babysit): when any worker session is errored it asks Castra to
 * restart the group's errored sessions in place and answer Claude's "Resume
 * from summary" picker (`POST /v1/sessions/recover`), then reflects the
 * recovered statuses back into THIS tick's snapshot so the later handlers see
 * live sessions rather than re-escalating ones the loop just fixed.
 *
 * Throttle: a session that stays errored after a restart (`still_error`) must
 * not be restart-stormed every tick. Each restart attempt is counted in the
 * in-memory working state (`raw.castra_recover_attempts`, ephemeral — rebuilt
 * on a cold start, which is the right time to retry anyway); once every errored
 * worker session is at the cap the sweep stops and the stuck session falls
 * through to the existing babysit worker-error escalation. A session that
 * recovers has its counter cleared so a future re-error retries fresh.
 *
 * Deps-free like cleanup/recovery — the only inputs are `ctx.castra` and
 * `ctx.meta.profile`. The Castra-side `castra.recover` span plus the action log
 * this handler's `res.actions` feed are the durable trace; no Herald transition
 * event is emitted because recovery changes no slice state — the next tick's
 * sense observes the now-healthy sessions and records the `session.changed`.
 */

/** Max in-place restart attempts per session before deferring to escalation. */
export const MAX_RECOVER_ATTEMPTS = 3;

export interface CastraRecoverDecision {
  /** The worker group whose errored sessions to recover. */
  readonly group: string;
  /** Errored worker session ids still under the attempt cap (drives the throttle). */
  readonly sessionIds: string[];
}

/** The per-session attempt-count map kept on the in-memory working state. */
function attemptCounts(state: LoopState): Record<string, number> {
  const raw = state.raw as { castra_recover_attempts?: Record<string, number> } | undefined;
  return raw?.castra_recover_attempts ?? {};
}

/**
 * Pure: decide whether to run a recovery sweep this tick. Returns a decision
 * only when at least one errored worker session is still under the attempt cap;
 * `null` otherwise (no errored workers, workers unavailable, or all stuck
 * sessions exhausted their budget).
 */
export function assess(state: LoopState): CastraRecoverDecision | null {
  if (!Array.isArray(state.sessions)) return null;
  const counts = attemptCounts(state);
  const errored = state.sessions.filter(
    (s) => isWorkerSession(s, state.workerGroup) && s?.status === "error" && s?.id,
  );
  if (errored.length === 0) return null;
  const attemptable = errored.filter((s) => (counts[s.id] ?? 0) < MAX_RECOVER_ATTEMPTS);
  if (attemptable.length === 0) return null;
  return { group: state.workerGroup, sessionIds: attemptable.map((s) => String(s.id)) };
}

export async function apply(
  decision: CastraRecoverDecision | null,
  ctx: HandlerContext,
  state: LoopState,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!decision) return res;

  let report: Awaited<ReturnType<typeof ctx.castra.recoverSessions>>;
  try {
    // Scope the sweep to the attemptable ids (not the whole group) so a session
    // at the attempt cap is NOT restarted again just because a sibling is still
    // under budget — that would defeat the throttle and restart-storm a stuck
    // worker every tick.
    report = await ctx.castra.recoverSessions(
      ctx.meta.profile,
      decision.group,
      decision.sessionIds,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.failures.push({ action: "castra-recover-failed", detail });
    ctx.log(`castra-recover sweep failed (group=${decision.group}): ${detail}`);
    return res;
  }

  const raw = state.raw as { castra_recover_attempts?: Record<string, number> } | undefined;
  if (raw && !raw.castra_recover_attempts) raw.castra_recover_attempts = {};
  res.mutated = true;

  for (const r of report.recovered) {
    if (r.outcome === "restart_failed") {
      res.failures.push({
        action: "castra-recover-failed",
        sessionId: r.sessionId,
        detail: r.error ?? "restart failed",
      });
    }

    const left = r.outcome === "recovered" || r.outcome === "picker_resolved";
    const snap = state.sessionsById?.get(r.sessionId);
    // Reflect the recovered status into this tick's snapshot so relaunch / babysit
    // (which run after) see a live session. still_error stays "error" (no-op);
    // restart_failed leaves the existing status untouched.
    if (left && snap && r.finalStatus) snap.status = r.finalStatus;

    if (raw?.castra_recover_attempts) {
      const counts = raw.castra_recover_attempts;
      if (left) {
        // Healthy again — clear the budget so a future re-error retries fresh.
        delete counts[r.sessionId];
      } else {
        // Restarted but still wedged (or restart threw): count the attempt so a
        // persistently-stuck session eventually defers to babysit escalation.
        counts[r.sessionId] = (counts[r.sessionId] ?? 0) + 1;
      }
      // While recovery still has budget for a stuck session, mark it so babysit
      // (the next handler) defers its worker-error escalation until the cap is
      // exhausted — a slow restart / missed picker shouldn't cry wolf on attempt 1.
      if (snap) {
        if (!left && (counts[r.sessionId] ?? 0) < MAX_RECOVER_ATTEMPTS) {
          snap.recovery_pending = true;
        } else {
          delete snap.recovery_pending;
        }
      }
    }

    const picker = r.pickerResolved ? " (resume-from-summary)" : "";
    res.actions.push({
      action: "castra-recover",
      sessionId: r.sessionId,
      detail: `${r.outcome}${picker} → ${r.finalStatus}`,
    });
    ctx.log(`castra-recover ${r.outcome} ${r.sessionId}${picker} → ${r.finalStatus}`);
  }

  return res;
}
