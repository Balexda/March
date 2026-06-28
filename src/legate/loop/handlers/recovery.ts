import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { dropRecoveredSlice } from "../state/mutations.js";
import { MAX_RECOVER_ATTEMPTS } from "./castra-recover.js";
import { RELAUNCH_LIMIT, relaunchRetryKey } from "./relaunch.js";
import { deriveUnescalateStage, unescalate } from "../steps/unescalate.js";

export { deriveUnescalateStage } from "../steps/unescalate.js";

/**
 * Graduated recovery ladder driver (#413, fixes #409). `march legate recover`
 * used to jump straight to the most-destructive option — tombstone + fresh
 * re-dispatch — because the escalated stage walls off the gentle recovery
 * handlers (`relaunch` excludes `escalated`; `adopt-from-fold` skips the
 * steward-attention reasons). This handler turns the operator lever into a rung
 * state machine that always starts at the least-destructive rung and walks down,
 * with a bounded budget per rung:
 *
 *   0b human-input — steward parked `awaiting_input` → REFUSE, touch nothing
 *                    (the full refuse-and-redirect UX lands in PR3).
 *   0a static      — errored worker session → un-escalate in place and let
 *                    `castra-recover` restart it. Descend when its budget
 *                    (`castra_recover_attempts >= MAX_RECOVER_ATTEMPTS`) is spent
 *                    and the session is still errored: drop the wedged session
 *                    (worktree/branch/PR preserved) so relaunch can take over.
 *   1   relaunch   — un-escalate to the slice's working stage (`pr-open` if it
 *                    has a PR, else `implementing`) so `relaunch` re-attaches a
 *                    fresh steward to the PRESERVED worktree next tick. Descend
 *                    when relaunch's budget (`relaunchRetryKey >= RELAUNCH_LIMIT`)
 *                    is spent and the session is still gone.
 *   2   confirm    — relaunch's budget is spent; wait ONE tick so a relaunch that
 *                    only just succeeded surfaces in the next sense (its new
 *                    session id is not in this tick's snapshot yet) before we give
 *                    up. Still gone next tick → descend to rung 3.
 *   3   nuke       — last resort: tombstone the slice (`dropRecoveredSlice`) and
 *                    append `slice.recovery.requested {rung:3}`, exactly today's
 *                    #238 behavior. Dispatch re-selects the still-ready item FRESH.
 *
 * Pipeline ordering is load-bearing (`coordinator.ts`): this handler runs AFTER
 * `castra-recover`/`relaunch`, so it PREPARES the slice (un-escalates) this tick
 * for the owning handler to act NEXT tick, and DESCENDS once that handler's
 * budget is exhausted. One-tick latency per rung; do NOT reorder.
 *
 * Durability (#412): the begin-graduated `slice.recovery.requested` the operator
 * appends sets the fold's `recoveryRung` to 0; each inner-rung descent appends
 * `slice.recovery.requested {rung:N}` ONCE (re-emitting every tick would re-clear
 * the relaunch budget the reducer resets, so the ladder would never descend), so
 * a cold-start rebuild resumes the walk at the right rung. The walk COMPLETES —
 * `recovery_rung` cleared — the moment the slice is un-escalated AND has a live
 * worker session again; that is re-derived from world state every tick, so it is
 * idempotent and cold-start-safe even if a stale `recoveryRung` lingers in the
 * fold.
 *
 * Pure `assess` + effecting `apply`. The only I/O is the rung-0→1 session drop
 * (best-effort `ctx.castra.removeSession`, worktree NOT pruned); everything else
 * is an in-memory mutation + a durable transition event. The action records are
 * appended to the log by {@link runHeartbeat} in pipeline order — this handler
 * does NOT write the log directly.
 */

/** The graduated-recovery action this slice takes THIS tick. */
export type RecoveryActionKind =
  | "refuse-awaiting-input" // 0b — steward awaiting input; touch nothing
  | "hold-castra" // 0a — un-escalate, ensure rung 0, await Castra restart
  | "free-and-relaunch" // 0a→1 — drop the wedged errored session, un-escalate for relaunch
  | "prepare-relaunch" // 1 — un-escalate so relaunch re-attaches a steward
  | "confirm-relaunch" // 1→2 — relaunch budget spent; hold one tick before the nuke
  | "nuke" // 2→3 (or descended into) — tombstone + fresh re-dispatch
  | "complete"; // un-escalated + live session (or nothing to do) — end the walk

export interface RecoveryDecision {
  readonly sliceId: string;
  readonly action: RecoveryActionKind;
  /** Working stage to un-escalate to (hold-castra / free-and-relaunch / prepare-relaunch). */
  readonly stage?: string;
  /** The wedged errored session to drop (free-and-relaunch). */
  readonly removeSessionId?: string;
  /** Session whose Castra-recover budget to reset for a genuine fresh rung-0 attempt. */
  readonly resetCastraSessionId?: string;
  /** Durable rung to record this tick via `slice.recovery.requested` (descent only). */
  readonly emitRung?: number;
  /** This is a fresh operator request (no rung yet) — apply clears the slice's
   *  spent warm retry budgets, mirroring the fold's begin-graduated reset (#412). */
  readonly freshInit?: boolean;
}

function castraAttempts(state: LoopState): Record<string, number> {
  const raw = state.raw as { castra_recover_attempts?: Record<string, number> } | undefined;
  return raw?.castra_recover_attempts ?? {};
}

function retryCounts(state: LoopState): Record<string, number> {
  const raw = state.raw as { transient_retry_counts?: Record<string, number> } | undefined;
  const c = raw?.transient_retry_counts;
  return c && typeof c === "object" ? c : {};
}

/** True when a slice carries an open PR for relaunch to re-attach a steward to. */
function hasOpenPr(slice: any): boolean {
  const n = slice?.pr?.number;
  return typeof n === "number" && n > 0;
}

/** The relaunch rung (1) / confirm rung (2) decision: descend when relaunch has
 *  stopped firing and the session is still gone, else keep un-escalating so
 *  relaunch re-attaches. */
function relaunchRung(state: LoopState, sliceId: string, slice: any, sessionGone: boolean, fresh: boolean): RecoveryDecision {
  // Relaunch only operates on a slice with an open PR — it re-attaches a steward
  // to the EXISTING PR branch/worktree. With no PR (e.g. a spawn that died before
  // opening one) there is no gentler option than a fresh re-dispatch, so the
  // ladder degrades straight to the nuke rather than un-escalating to a stage
  // relaunch can't act on (which would strand the slice: no relaunch, and
  // dispatch skips it as in-flight).
  if (!hasOpenPr(slice)) return { sliceId, action: "nuke", freshInit: fresh };
  // A fresh operator request begins the ladder at rung 0 with a clean per-rung
  // budget (the begin-graduated reducer clears the fold's retries; apply mirrors
  // that into the warm working state). So a slice whose relaunch budget was
  // ALREADY spent — the stranded case the operator is un-wedging — relaunches
  // again instead of immediately reading as exhausted and descending to the nuke.
  const used = fresh
    ? 0
    : Number.isFinite(retryCounts(state)[relaunchRetryKey(sliceId)])
      ? retryCounts(state)[relaunchRetryKey(sliceId)]
      : 0;
  const rung = slice.recovery_rung === undefined ? 0 : Number(slice.recovery_rung);
  if (used >= RELAUNCH_LIMIT && sessionGone) {
    // Relaunch's budget is spent. Hold one tick at rung 2 so a relaunch that
    // only just succeeded (its new session id is not in THIS tick's snapshot)
    // surfaces in the next sense before we nuke; if we are already at rung 2 and
    // still gone, the relaunch genuinely failed — descend to the nuke.
    if (rung >= 2) return { sliceId, action: "nuke", freshInit: fresh };
    return { sliceId, action: "confirm-relaunch", emitRung: 2, freshInit: fresh };
  }
  return {
    sliceId,
    action: "prepare-relaunch",
    stage: deriveUnescalateStage(slice),
    freshInit: fresh,
    // Record rung 1 durably only on the transition INTO it (not every maintain
    // tick) so the reducer's retry-budget reset fires once, not repeatedly.
    ...(rung === 1 ? {} : { emitRung: 1 }),
  };
}

/** Pure: classify ONE candidate slice into its rung action for this tick.
 *  `requested` = an OPERATOR `slice.recovery.requested` (no rung) was drained for
 *  this slice THIS tick — an explicit (re-)request that restarts the ladder from
 *  the gentlest rung with clean budgets, even mid-walk (the operator fixed the
 *  blocker and wants a fresh attempt). Mid-walk continuation (no fresh request)
 *  is driven by `recovery_rung` and keeps its accruing budget so it can descend. */
function classify(state: LoopState, sliceId: string, requested: boolean): RecoveryDecision {
  const slice = state.slices?.[sliceId];
  if (!slice || typeof slice !== "object" || slice.recovered || slice.archived) {
    // Operator requested recovery on an unknown / already-recovered slice.
    return { sliceId, action: "complete" };
  }

  // 0b — the steward is deliberately parked awaiting the user. Refuse and touch
  // nothing; this wins even over an errored session (e.g. both at once).
  if (state.perSlice?.[sliceId]?.stewardReport?.status === "awaiting_input") {
    return { sliceId, action: "refuse-awaiting-input" };
  }

  const sessId = typeof slice.worker_session_id === "string" ? slice.worker_session_id : "";
  const snap = sessId ? state.sessionsById?.get(sessId) : undefined;
  const sessionPresent = !!snap;
  const sessionErrored = sessionPresent && snap.status === "error";
  const sessionHealthy = sessionPresent && snap.status !== "error";
  const sessionGone = !sessionPresent;

  // Walk complete: the slice is no longer escalated and has a live steward —
  // babysit drives it from here. Idempotent / cold-start-safe (re-derived every
  // tick), so a lingering fold `recoveryRung` resolves on the next pass.
  if (slice.stage !== "escalated" && sessionHealthy) return { sliceId, action: "complete" };

  // A FRESH start of the ladder — at rung 0 with clean per-rung budgets — is
  // either a slice with no rung yet OR an explicit operator (re-)request (the
  // operator fixed the blocker and wants to retry from the gentlest rung). The
  // begin-graduated reducer (#412) clears the fold's retries; apply mirrors that
  // into the warm working state (warm-loop invisibility: the fold edit never
  // reaches the running loop's in-memory raw).
  const fresh = requested || slice.recovery_rung === undefined;
  const rung = fresh ? 0 : Number(slice.recovery_rung);

  if (rung <= 0) {
    if (sessionErrored) {
      const attempts = Number.isFinite(castraAttempts(state)[sessId]) ? castraAttempts(state)[sessId] : 0;
      // A fresh request gets a genuine gentlest attempt: reset the Castra-recover
      // budget so rung 0 actually retries even if the slice escalated because that
      // budget was already spent.
      if (fresh || attempts < MAX_RECOVER_ATTEMPTS) {
        return {
          sliceId,
          action: "hold-castra",
          stage: deriveUnescalateStage(slice),
          freshInit: fresh,
          ...(fresh ? { resetCastraSessionId: sessId } : {}),
        };
      }
      // Restart budget spent and still errored: nothing gentle can heal it in
      // place. With an open PR, drop the wedged session (worktree/branch/PR
      // preserved) so relaunch re-attaches a fresh steward next tick (descend to
      // rung 1); with no PR there is nothing to relaunch onto, so go to the nuke.
      if (!hasOpenPr(slice)) return { sliceId, action: "nuke", freshInit: fresh };
      return {
        sliceId,
        action: "free-and-relaunch",
        stage: deriveUnescalateStage(slice),
        removeSessionId: sessId,
        emitRung: 1,
        freshInit: fresh,
      };
    }
    // No errored session to recover in place (vanished, or alive-but-escalated):
    // rung 0 has nothing to do — go straight to the relaunch rung.
    return relaunchRung(state, sliceId, slice, sessionGone, fresh);
  }

  return relaunchRung(state, sliceId, slice, sessionGone, fresh);
}

/**
 * Pure: one decision per DISTINCT candidate slice this tick — the union of slices
 * whose operator `slice.recovery.requested` was drained (`state.recoveryRequests`,
 * begin-graduated → rung-0 init) and slices already mid-walk (carrying
 * `recovery_rung`, continuing to descend). De-duped by slice id so a re-drained
 * inner-rung event (the descents this handler appends re-enter `recoveryRequests`)
 * is processed once; the rung-0 init is guarded on `recovery_rung === undefined`
 * inside {@link classify} so a duplicate request can never reset progress.
 */
export function assess(state: LoopState): RecoveryDecision[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  const requested = new Set<string>();
  for (const id of state.recoveryRequests ?? []) {
    requested.add(id);
    add(id);
  }
  const slices = state.slices && typeof state.slices === "object" ? state.slices : {};
  for (const [id, slice] of Object.entries(slices) as [string, any][]) {
    if (slice && typeof slice === "object" && slice.recovery_rung !== undefined) add(id);
  }
  return ids.map((id) => classify(state, id, requested.has(id)));
}

/**
 * Mirror the begin-graduated reducer's retry reset (#412) into the WARM working
 * state: clear every `transient_retry_counts` entry keyed to this slice so a
 * fresh operator request restarts the per-rung budgets — without this the warm
 * loop (whose `raw` is never re-folded from the budget-cleared fold) still reads
 * the spent counters and a stranded slice descends straight to the nuke (gap #3
 * in #238 / warm-loop invisibility). Keyed identically to the reducer:
 * `<sliceId>` or any `…:<sliceId>` (relaunch-steward / dispatch-recovery / …).
 */
function clearWarmRetryBudgets(raw: any, sliceId: string): void {
  const counts = raw?.transient_retry_counts;
  if (counts && typeof counts === "object") {
    for (const key of Object.keys(counts)) {
      if (key === sliceId || key.endsWith(":" + sliceId)) delete counts[key];
    }
  }
  // Also drop the self-healing backoff timer (relaunch.ts) so a fresh operator
  // request relaunches promptly instead of waiting out an accrued cooldown.
  const backoff = raw?.relaunch_backoff_until;
  if (backoff && typeof backoff === "object") delete backoff[sliceId];
}

export async function apply(decisions: RecoveryDecision[], ctx: HandlerContext, state: LoopState): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!state.raw) return res;
  const ts = ctx.ts;

  for (const d of decisions) {
    const slice = state.slices?.[d.sliceId];
    const sessionId = (slice && typeof slice.worker_session_id === "string" && slice.worker_session_id) || null;

    // Fresh request → reset the warm per-rung budgets (mirror of #412's
    // begin-graduated fold reset) BEFORE acting, so a stranded slice whose
    // relaunch/recover budgets were already spent gets a clean walk. The nuke's
    // own dropRecoveredSlice still clears them on rung 3.
    if (d.freshInit) clearWarmRetryBudgets(state.raw, d.sliceId);

    switch (d.action) {
      case "refuse-awaiting-input": {
        // Touch nothing — the steward is parked on a user prompt the operator must
        // resolve. PR3 adds the refuse-and-redirect UX.
        res.actions.push({
          action: "recovery-awaiting-input",
          sliceId: d.sliceId,
          sessionId,
          detail: "rung 0b: steward awaiting user input — recovery refused (resolve the prompt; PR3 will redirect)",
        });
        break;
      }

      case "complete": {
        const had = !!slice && slice.recovery_rung !== undefined;
        if (had) delete slice.recovery_rung;
        res.mutated = true;
        res.actions.push({
          action: "recovery-complete",
          sliceId: d.sliceId,
          sessionId,
          detail: !slice
            ? "no tracked slice to recover (already recovered or unknown)"
            : "slice un-escalated with a live steward — graduated recovery complete",
        });
        break;
      }

      case "hold-castra": {
        if (!slice) break;
        const stageChanged = unescalate(slice, d.stage as string, ts, "Graduated recovery rung 0: un-escalated; awaiting in-place Castra restart (#413)");
        slice.recovery_rung = 0;
        if (d.resetCastraSessionId) {
          const raw = state.raw as { castra_recover_attempts?: Record<string, number> };
          if (raw.castra_recover_attempts) delete raw.castra_recover_attempts[d.resetCastraSessionId];
        }
        if (stageChanged) {
          ctx.emitTransition?.({
            type: "slice.stage.changed",
            sliceId: d.sliceId,
            stage: d.stage as string,
            ...(sessionId ? { sessionId } : {}),
          });
        }
        res.mutated = true;
        res.actions.push({
          action: "recovery-hold",
          sliceId: d.sliceId,
          sessionId,
          detail: `rung 0: un-escalated to ${d.stage}; Castra-recover restarts the errored session in place`,
        });
        break;
      }

      case "free-and-relaunch": {
        if (!slice) break;
        let dropNote = "";
        if (d.removeSessionId) {
          try {
            await ctx.castra.removeSession({
              profile: ctx.meta.profile,
              sessionId: d.removeSessionId,
              // Preserve the worktree/branch/PR — only the wedged session goes, so
              // relaunch re-attaches a fresh steward to the existing checkout.
              pruneWorktree: false,
              traceKey: d.sliceId,
            });
            dropNote = `; dropped wedged session ${d.removeSessionId}`;
          } catch (err) {
            const msg = (err as any)?.message || String(err);
            dropNote = `; could not drop wedged session ${d.removeSessionId} (${msg.slice(0, 120)})`;
            ctx.log(`recovery ${d.sliceId}: removeSession ${d.removeSessionId} failed: ${msg}`);
          }
        }
        const descStageChanged = unescalate(slice, d.stage as string, ts, "Graduated recovery rung 0→1: Castra restart exhausted; un-escalated for relaunch (#413)");
        slice.recovery_rung = 1;
        if (descStageChanged) {
          ctx.emitTransition?.({
            type: "slice.stage.changed",
            sliceId: d.sliceId,
            stage: d.stage as string,
            ...(sessionId ? { sessionId } : {}),
          });
        }
        ctx.emitTransition?.({ type: "slice.recovery.requested", sliceId: d.sliceId, rung: 1 });
        res.mutated = true;
        res.actions.push({
          action: "recovery-descend",
          sliceId: d.sliceId,
          sessionId,
          detail: `rung 0→1: Castra restart budget spent${dropNote}; un-escalated to ${d.stage} for relaunch`,
        });
        break;
      }

      case "prepare-relaunch": {
        if (!slice) break;
        const prepStageChanged = unescalate(slice, d.stage as string, ts, "Graduated recovery rung 1: un-escalated; relaunch re-attaches a steward (#413)");
        slice.recovery_rung = 1;
        if (prepStageChanged) {
          ctx.emitTransition?.({
            type: "slice.stage.changed",
            sliceId: d.sliceId,
            stage: d.stage as string,
            ...(sessionId ? { sessionId } : {}),
          });
        }
        if (d.emitRung !== undefined) {
          ctx.emitTransition?.({ type: "slice.recovery.requested", sliceId: d.sliceId, rung: d.emitRung });
        }
        res.mutated = true;
        res.actions.push({
          action: "recovery-relaunch",
          sliceId: d.sliceId,
          sessionId,
          detail: `rung 1: un-escalated to ${d.stage}; relaunch re-attaches a steward to the preserved worktree`,
        });
        break;
      }

      case "confirm-relaunch": {
        if (!slice) break;
        slice.recovery_rung = 2;
        if (d.emitRung !== undefined) {
          ctx.emitTransition?.({ type: "slice.recovery.requested", sliceId: d.sliceId, rung: d.emitRung });
        }
        res.mutated = true;
        res.actions.push({
          action: "recovery-descend",
          sliceId: d.sliceId,
          sessionId,
          detail: "rung 1→2: relaunch budget spent; holding one tick to confirm before the last-resort nuke",
        });
        break;
      }

      case "nuke": {
        const cleared = dropRecoveredSlice(state.raw, d.sliceId);
        // Tombstone the fold (recovered:true) so a cold-start rebuild reconstructs
        // nothing blocking and a stale observation can't resurrect a ghost; the
        // ensuing fresh slice.dispatched clears the tombstone. Mirrors #238.
        ctx.emitTransition?.({ type: "slice.recovery.requested", sliceId: d.sliceId, rung: 3 });
        res.mutated = true;
        res.actions.push({
          action: "recovery-nuke",
          sliceId: d.sliceId,
          sessionId,
          detail: cleared
            ? "rung 3: gentle rungs exhausted — tombstoned for fresh re-dispatch"
            : "rung 3: no tracked slice to clear (already recovered) — re-dispatch will proceed if still ready",
        });
        break;
      }
    }
  }

  return res;
}
