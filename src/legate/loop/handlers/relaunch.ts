import fs from "node:fs";
import path from "node:path";
import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { isWorkerSession } from "../pure/session.js";
import { ensureRetryCounts } from "../state/mutations.js";
import { execText } from "../clients/exec.js";
import { unescalate } from "../steps/unescalate.js";
import {
  backoffMs,
  parseMs,
  readRecoveryRate,
  stepRecoveryRate,
  BACKOFF_BASE_MS,
  BACKOFF_JITTER,
  BACKOFF_MAX_MS,
} from "../pure/self-heal.js";

/**
 * Steward relaunch: a non-terminal slice that still has an open PR but whose
 * worker session has vanished (crashed/removed) gets a fresh opus steward
 * re-attached to its EXISTING worktree/branch (createBranch:false), so future
 * babysit messages have somewhere to land. assess() is pure; apply() recreates
 * the worktree if needed, launches via Castra, sends a resume-context prompt,
 * and rewrites the slice's worker pointer.
 *
 * SELF-HEALING PACE (AIMD + exponential backoff, supersedes the old hard
 * `RELAUNCH_LIMIT` give-up). A stranded slice surfaces a `march_legate_slices_stranded`
 * count but the old relaunch capped at 3 attempts and then PARKED the slice
 * forever — so a transient outage (codex auth expiry, a Castra-unreachable
 * window, a host reboot) stranded work until an operator ran `march legate
 * recover`. The automatic path now:
 *
 *  - retries INDEFINITELY with EXPONENTIAL BACKOFF + per-slice JITTER
 *    (`relaunch_backoff_until[sliceId]`, warm-only): a genuinely-broken slice is
 *    probed ever-further apart (plateauing at {@link RELAUNCH_BACKOFF_MAX_MS}),
 *    so it costs almost nothing yet self-heals the instant the world recovers
 *    (e.g. the operator re-auths codex → the next cheap probe succeeds). Jitter
 *    de-correlates slices that failed in the same burst so they don't re-probe in
 *    lock-step.
 *  - is rate-limited by a GLOBAL per-profile AIMD rate `raw.recovery_rate` R:
 *    each tick attempts at most R backoff-eligible slices (longest-waiting
 *    first); a fully-successful, rate-limited sweep adds 1 (additive increase),
 *    any failure halves R (multiplicative decrease, floored at
 *    {@link RECOVERY_RATE_MIN}). After an outage R collapses to 1, so recovery
 *    probes ONE slice, and only ramps back up as probes succeed — no
 *    thundering-herd re-attempt when a budget threshold elapses.
 *  - covers ESCALATED-with-dead-steward slices by un-escalating them in place
 *    first, then relaunching. Infra-failure reasons ({@link AUTO_RECOVERABLE_REASONS})
 *    always qualify. Human-hold reasons ({@link HUMAN_HOLD_REASONS}) qualify ONLY
 *    once the steward's session has VANISHED: a steward genuinely awaiting the user
 *    is held for the operator while a LIVE session can still receive the answer
 *    (such a slice is skipped by the liveness gate and never reaches the auto path),
 *    but once its session is gone there is no live prompt to resolve — holding it
 *    for an operator is pointless, so the auto path re-attaches a steward to the
 *    preserved PR/worktree (if the question still stands the fresh steward re-asks
 *    with a live session, re-escalating it back into the operator's hands). It
 *    never nukes: the destructive tombstone+re-dispatch stays in the operator's
 *    graduated-recovery ladder.
 *
 * The OPERATOR ladder path (#413) is unchanged: a slice the ladder is driving
 * (carrying `recovery_rung`) keeps the old bounded, every-tick, not-rate-limited
 * behavior so `march legate recover` stays prompt and walks to the nuke on
 * `relaunchRetryKey >= RELAUNCH_LIMIT`.
 *
 * Brood reconciliation AT THE SOURCE (#308): a relaunch mints a NEW session id
 * (the prior one vanished) and may land on a NEW worktree, but it only used to
 * rewrite the legate's in-memory pointer — Brood was never told. So the prior
 * attempt's row stayed registered (torndown later, possibly resolving the wrong
 * session by worktree match, #304) and the new attempt was never registered →
 * an untracked orphan the moment its slice completes. apply() now closes that at
 * the source: after a successful launch it REGISTERS the new session+worktree
 * with Brood and REAPS the prior steward's Brood record, so at most one live
 * steward + worktree per slice exists and Brood always tracks the live one. The
 * prior reap is GUARDED on a distinct worktree path: Brood's steward removal
 * resolves the live session by exact worktree (#304), so tearing down the prior
 * when both share a worktree path would pull the checkout out from under the
 * freshly relaunched session. Both Brood calls are best-effort — a failure logs
 * and records a note but never fails the relaunch (the #304 sweep is the net).
 */

/** Working steward stages relaunch acts on directly (no un-escalation needed). */
const ELIGIBLE_STAGES = new Set([
  "implementing",
  "pr-open",
  "pr-in-fix",
  "pr-resolving-conflicts",
  "pr-rebasing",
  "pr-in-rerun",
]);

/** Escalation reasons the AUTOMATIC path may un-escalate and relaunch: a dead
 *  steward behind an infrastructure failure, not a human decision. Auto-recovery
 *  un-escalates these in place (PR/worktree preserved) and re-attaches a steward. */
export const AUTO_RECOVERABLE_REASONS = new Set([
  "hatchery_dispatch_failed",
  "real_spawn_error",
  "steward_stuck",
]);

/** Escalation reasons that hold a slice for a human WHILE the steward session is
 *  LIVE — silently relaunching a live steward would paper over a real prompt the
 *  operator must answer. The automatic path skips these for a live session (left
 *  for `respond` / the operator's graduated-recovery ladder), but recovers them
 *  once the session has VANISHED: a dead session has no prompt left to answer, so
 *  re-attaching a steward is the non-destructive way back (see assess()). */
export const HUMAN_HOLD_REASONS = new Set([
  "steward_awaiting_input",
  "needs_human",
  "needs_human_judgement",
]);

/** Max steward relaunch attempts per slice the OPERATOR ladder waits through
 *  before descending a rung. The automatic path no longer hard-stops here (it
 *  backs off); exported so the graduated-recovery driver (#413) reads the SAME
 *  budget — its rung-1→2 descent fires once relaunch has accrued this many
 *  failures and the session is still gone. */
export const RELAUNCH_LIMIT = 3;

/** AIMD bounds + exponential-backoff schedule for the automatic path. The math
 *  lives in the shared {@link ../pure/self-heal.js self-heal} module (identical to
 *  the spawn re-dispatch path, #460); these aliases keep relaunch's historical
 *  export names stable for its callers/tests. */
export { RECOVERY_RATE_MIN, RECOVERY_RATE_MAX } from "../pure/self-heal.js";
export const RELAUNCH_BACKOFF_BASE_MS = BACKOFF_BASE_MS;
export const RELAUNCH_BACKOFF_MAX_MS = BACKOFF_MAX_MS;
export const RELAUNCH_BACKOFF_JITTER = BACKOFF_JITTER;

/** The transient-retry-counts key for a slice's steward-relaunch budget. Shared
 *  with the recovery driver (#413) so both sides key the counter identically. */
export const relaunchRetryKey = (sliceId: string): string => "relaunch-steward:" + sliceId;

export interface RelaunchDecision {
  readonly sliceId: string;
  readonly bareBranch: string;
  readonly featureBranch: string;
  readonly expectedDirName: string;
  readonly worktreePath: string;
  readonly launchTitle: string;
  readonly prNumber: number;
  readonly prUrl: string;
  /** This attempt's 1-based count (== persisted counter after apply). */
  readonly attempt: number;
  readonly limit: number;
  /** "ladder" = driven by the operator's graduated recovery (`recovery_rung`):
   *  bounded by RELAUNCH_LIMIT, every tick, not rate-limited/backed-off.
   *  "auto" = the self-healing path: exponential backoff + AIMD rate. */
  readonly mode: "ladder" | "auto";
  /** auto only: an escalated-infra slice to un-escalate before launching. */
  readonly unescalateStage?: string;
  /** auto only: more backoff-eligible candidates existed than the AIMD rate R
   *  allowed this tick — a clean sweep should additively increase R. */
  readonly autoRateLimited?: boolean;
}

/** Side-effect seams for apply — injectable so the git/fs writes are testable. */
export interface RelaunchDeps {
  worktreeExists: (p: string) => boolean;
  ensureWorktree: (worktreePath: string, featureBranch: string, repoPath: string) => Promise<void>;
}

const defaultRelaunchDeps: RelaunchDeps = {
  worktreeExists: (p) => fs.existsSync(p),
  ensureWorktree: async (worktreePath, featureBranch, repoPath) => {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await execText("git", ["worktree", "add", worktreePath, featureBranch], { cwd: repoPath });
  },
};

function errMsg(err: any): string {
  return (err?.message || String(err)).slice(0, 200);
}

/** Pure read of the throttle counters (assess never mutates them). */
function readRetryCounts(raw: any): Record<string, number> {
  const c = raw?.transient_retry_counts;
  return c && typeof c === "object" ? c : {};
}

/** Pure read of the per-slice backoff timers (epoch ms of next eligibility). */
function readBackoff(raw: any): Record<string, number> {
  const b = raw?.relaunch_backoff_until;
  return b && typeof b === "object" ? b : {};
}

/** Ensure the warm backoff map exists and return it (apply-side mutation). */
function ensureBackoff(raw: any): Record<string, number> {
  if (!raw.relaunch_backoff_until || typeof raw.relaunch_backoff_until !== "object") {
    raw.relaunch_backoff_until = {};
  }
  return raw.relaunch_backoff_until;
}

/** Pure read of the relaunch AIMD recovery rate (its own `recovery_rate` scalar),
 *  clamped to [MIN, MAX]. Default MIN. */
function readRate(raw: any): number {
  return readRecoveryRate(raw, "recovery_rate");
}

/** Exponential backoff with per-slice jitter for the Nth failure (1-based).
 *  Historical name; delegates to the shared {@link backoffMs}. */
export const relaunchBackoffMs = backoffMs;

function stewardResumeMessage(d: RelaunchDecision): string {
  return [
    "[STEWARD RESUME] You are the re-launched March Hatchery management session for PR #" + d.prNumber + ".",
    "Branch: " + d.featureBranch,
    "PR: " + d.prUrl,
    "",
    "The previous steward session for this slice was removed; the loop has attached you to the",
    "existing worktree so future babysit messages have somewhere to go. Stand by for:",
    "  - '/smithy.fix <thread-summary>' if review threads need a response.",
    "  - Conflict-resolution prompts if the branch develops merge conflicts.",
    "  - CI-failure judgement requests.",
    "",
    "When such a message arrives, act on it directly: inspect, fix, commit, push.",
    "Do not pre-emptively rewrite anything; the PR is already open and may be in review.",
  ].join("\n");
}

/** Shared per-candidate fields (everything but the mode-specific bits). */
function baseDecision(
  sliceId: string,
  slice: any,
  attempt: number,
  worktreesParent: string,
): Omit<RelaunchDecision, "mode" | "unescalateStage" | "autoRateLimited"> {
  const rawBranch = typeof slice.branch === "string" ? slice.branch : "";
  const bareBranch = rawBranch.replace(/^feature\//, "");
  const featureBranch = "feature/" + bareBranch;
  const expectedDirName = "feature-" + bareBranch.replace(/\//g, "-");
  const pr = slice.pr || {};
  return {
    sliceId,
    bareBranch,
    featureBranch,
    expectedDirName,
    worktreePath: slice.worktree_path || path.join(worktreesParent, expectedDirName),
    launchTitle: slice.worker_title || "steward: " + sliceId,
    prNumber: pr.number,
    prUrl: pr.url || "(unknown)",
    attempt,
    limit: RELAUNCH_LIMIT,
  };
}

/**
 * Pure: which slices have lost their steward and should be relaunched this tick.
 * Produces ladder decisions (operator-driven, bounded, unconditional) plus up to
 * R auto decisions (self-healing, backoff-gated, longest-waiting first).
 */
export function assess(state: LoopState): RelaunchDecision[] {
  const repoPath = state.repoPath;
  if (typeof repoPath !== "string" || repoPath.length === 0) return [];

  const liveSessionIds = new Set<string>();
  for (const s of state.sessions) {
    if (isWorkerSession(s, state.workerGroup) && typeof s?.id === "string") liveSessionIds.add(s.id);
  }
  const counts = readRetryCounts(state.raw);
  const backoff = readBackoff(state.raw);
  const nowMs = parseMs(state.ts);
  const worktreesParent = path.join(path.dirname(repoPath), "WorkTrees", path.basename(repoPath));
  // Slices with a pending operator recovery request this tick belong to the
  // graduated-recovery ladder (recovery.ts runs LATER in the pipeline). Relaunch
  // must not act on them first — the auto path would otherwise un-escalate +
  // relaunch a slice the operator just asked the ladder to walk, pre-empting the
  // least-destructive-first descent (#413).
  const requested = new Set(Array.isArray(state.recoveryRequests) ? state.recoveryRequests : []);

  const ladder: RelaunchDecision[] = [];
  // Auto candidates collected first, then sorted + rate-capped.
  const autoCandidates: { sliceId: string; slice: any; attempt: number; until: number; unescalateStage?: string }[] =
    [];

  for (const [sliceId, slice] of Object.entries(state.slices) as [string, any][]) {
    if (!slice || typeof slice !== "object") continue;
    if (requested.has(sliceId)) continue; // the recovery ladder owns it this tick
    const pr = slice.pr || {};
    if (!pr.number) continue; // relaunch re-attaches to an EXISTING PR
    const rawBranch = typeof slice.branch === "string" ? slice.branch : "";
    if (rawBranch.length === 0) continue;
    // Only act when the steward is actually gone.
    const sessId = slice.worker_session_id;
    if (typeof sessId === "string" && sessId.length > 0 && liveSessionIds.has(sessId)) continue;

    const prev = Number.isFinite(counts[relaunchRetryKey(sliceId)]) ? counts[relaunchRetryKey(sliceId)] : 0;
    const attempt = prev + 1;

    // The operator's graduated ladder owns slices it is walking (`recovery_rung`):
    // keep the bounded, every-tick behavior so `march legate recover` stays prompt.
    if (slice.recovery_rung !== undefined) {
      if (!ELIGIBLE_STAGES.has(slice.stage)) continue;
      if (attempt > RELAUNCH_LIMIT) continue;
      ladder.push({ ...baseDecision(sliceId, slice, attempt, worktreesParent), mode: "ladder" });
      continue;
    }

    // Automatic self-healing path.
    let unescalateStage: string | undefined;
    if (ELIGIBLE_STAGES.has(slice.stage)) {
      // working steward stage — relaunch directly
    } else if (
      slice.stage === "escalated" &&
      (AUTO_RECOVERABLE_REASONS.has(slice.escalated_reason) || HUMAN_HOLD_REASONS.has(slice.escalated_reason))
    ) {
      // An escalated slice whose steward is DEAD → un-escalate first, then relaunch.
      // Infra-failure reasons (AUTO_RECOVERABLE_REASONS) always qualify. Human-hold
      // reasons (awaiting_input / needs_human) qualify HERE too, but ONLY because
      // control already passed the liveness gate above — a slice with a live worker
      // session was skipped. A steward genuinely awaiting the user is held for the
      // operator only while it can still BE answered; once its session has vanished
      // there is no live prompt to resolve, so silently relaunching it (re-attaching
      // a steward to the preserved PR/worktree) is the non-destructive way back —
      // if the question still stands the fresh steward re-asks with a LIVE session,
      // which re-escalates and is once again held for the operator. Never nukes.
      unescalateStage = "pr-open"; // it has a PR (checked above)
    } else {
      continue; // non-steward stages are not auto-recovered
    }

    // Backoff gate: skip while still cooling down (only when we can compare times).
    const until = Number.isFinite(backoff[sliceId]) ? backoff[sliceId] : 0;
    if (Number.isFinite(nowMs) && nowMs < until) continue;

    autoCandidates.push({ sliceId, slice, attempt, until, unescalateStage });
  }

  // Longest-waiting first: smallest next-eligible timestamp (never-tried = 0) wins.
  autoCandidates.sort((a, b) => a.until - b.until);
  const rate = readRate(state.raw);
  const autoRateLimited = autoCandidates.length > rate;
  const selected = autoCandidates.slice(0, rate);
  const auto: RelaunchDecision[] = selected.map((c) => ({
    ...baseDecision(c.sliceId, c.slice, c.attempt, worktreesParent),
    mode: "auto",
    autoRateLimited,
    ...(c.unescalateStage ? { unescalateStage: c.unescalateStage } : {}),
  }));

  return [...ladder, ...auto];
}

/**
 * Reconcile Brood after a successful relaunch (#308). Registers the LIVE steward
 * (new session id + its real worktree) so Brood owns its #155-safe teardown, then
 * reaps the prior steward's Brood record. The reap is GUARDED on a distinct
 * worktree path: Brood resolves the steward's real session by exact worktree
 * (#304), so tearing down the prior when it shares the live worktree would remove
 * the freshly relaunched session/checkout. Returns a short note for the action
 * log (or "" when nothing notable happened). Never throws — Brood unavailability
 * must not fail a relaunch; the #304 sweep remains the safety net.
 */
async function reconcileBrood(
  ctx: HandlerContext,
  state: LoopState,
  d: RelaunchDecision,
  ids: {
    newSessionId: string;
    liveWorktree: string;
    priorSessionId: string;
    priorWorktree: string;
    /** Hatchery spawn id this steward belongs to (#308) — preserved as the new
     *  row's parentId so terminal teardown resolves & archives the spawn group. */
    parentSpawnId: string;
  },
): Promise<string> {
  const notes: string[] = [];

  // Register the live steward FIRST so a crash between the two calls leaves the
  // live one tracked rather than orphaned.
  if (ctx.broodRegister) {
    try {
      const reg = await ctx.broodRegister({
        id: ids.newSessionId,
        kind: "steward",
        status: "running",
        // Preserve the spawn parent (#308): Brood teardown uses a steward's
        // parentId to resolve/mark the spawn+steward group; without it the
        // relaunched steward looks unparented and terminal cleanup leaves the
        // original spawn row active/unarchived. Omit when there is no spawn id
        // (a steward not backed by a Hatchery spawn).
        ...(ids.parentSpawnId ? { parentId: ids.parentSpawnId } : {}),
        agentDeckSessionId: ids.newSessionId,
        profile: ctx.meta.profile,
        repoPath: state.repoPath as string,
        branch: d.featureBranch,
        worktreePath: ids.liveWorktree,
        ...(ctx.meta.worker_group ? { group: ctx.meta.worker_group } : {}),
      });
      notes.push(reg.ok ? "registered live steward with Brood" : "Brood register failed: " + reg.detail);
      if (!reg.ok) ctx.log(`relaunch ${d.sliceId}: Brood register of ${ids.newSessionId} failed: ${reg.detail}`);
    } catch (err) {
      notes.push("Brood register errored: " + errMsg(err));
      ctx.log(`relaunch ${d.sliceId}: Brood register of ${ids.newSessionId} errored: ${errMsg(err)}`);
    }
  }

  // Reap the prior steward — only when it is a DISTINCT session on a DISTINCT
  // worktree (else the worktree-match teardown would reap the live one, #304).
  const distinctSession = ids.priorSessionId.length > 0 && ids.priorSessionId !== ids.newSessionId;
  const distinctWorktree = ids.priorWorktree.length > 0 && ids.priorWorktree !== ids.liveWorktree;
  if (distinctSession && distinctWorktree) {
    try {
      const teardown = await ctx.broodTeardown(ids.priorSessionId, {
        force: true,
        reason: "steward-relaunch",
        traceKey: d.sliceId,
      });
      if (teardown.ok) notes.push("reaped prior steward " + ids.priorSessionId);
      else if (teardown.notTracked) notes.push("prior steward " + ids.priorSessionId + " not tracked by Brood");
      else {
        notes.push("prior reap failed: " + teardown.detail);
        ctx.log(`relaunch ${d.sliceId}: Brood teardown of prior ${ids.priorSessionId} failed: ${teardown.detail}`);
      }
    } catch (err) {
      notes.push("prior reap errored: " + errMsg(err));
      ctx.log(`relaunch ${d.sliceId}: Brood teardown of prior ${ids.priorSessionId} errored: ${errMsg(err)}`);
    }
  } else if (distinctSession && !distinctWorktree) {
    // Same worktree path: a teardown would resolve the live session by worktree
    // and remove it (#304), so we must NOT tear down. But the register above only
    // upserts the NEW id — it does not retire the PRIOR row, so Brood would track
    // BOTH stewards on this worktree and the stale row (its worktree still
    // present) is not even a #304 sweep candidate, lingering forever. Retire the
    // prior row (status → torndown, no worktree prune) so exactly ONE active row
    // remains for the worktree (#308).
    if (ctx.broodRetire) {
      try {
        const retired = await ctx.broodRetire(ids.priorSessionId);
        if (retired.ok) notes.push("retired prior steward " + ids.priorSessionId + " (shared worktree)");
        else if (retired.notTracked) notes.push("prior steward " + ids.priorSessionId + " not tracked by Brood");
        else {
          notes.push("prior retire failed: " + retired.detail);
          ctx.log(`relaunch ${d.sliceId}: Brood retire of prior ${ids.priorSessionId} failed: ${retired.detail}`);
        }
      } catch (err) {
        notes.push("prior retire errored: " + errMsg(err));
        ctx.log(`relaunch ${d.sliceId}: Brood retire of prior ${ids.priorSessionId} errored: ${errMsg(err)}`);
      }
    } else {
      notes.push("prior steward shares live worktree — broodRetire unavailable");
    }
  }

  return notes.join("; ");
}

export async function apply(
  decisions: RelaunchDecision[],
  ctx: HandlerContext,
  state: LoopState,
  deps: RelaunchDeps = defaultRelaunchDeps,
): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (decisions.length === 0) return res;
  const counts = ensureRetryCounts(state.raw);
  const backoff = ensureBackoff(state.raw);
  const nowMs = parseMs(ctx.ts);

  // AIMD accumulators over THIS tick's automatic attempts.
  let autoAttempts = 0;
  let autoFailures = 0;
  let autoRateLimited = false;

  // Persist THIS attempt against the budget. Called on success AND on every
  // failure path: the counter advances the operator ladder's descent and the
  // automatic backoff exponent alike.
  const recordAttempt = (d: RelaunchDecision): void => {
    counts[relaunchRetryKey(d.sliceId)] = d.attempt;
    ctx.emitTransition?.({ type: "retry.counted", key: relaunchRetryKey(d.sliceId), count: d.attempt });
  };

  // A failed automatic attempt schedules the next backoff window and signals the
  // AIMD decrease. (Ladder failures advance only the counter — the operator path
  // is not rate-limited.)
  const recordFailure = (d: RelaunchDecision): void => {
    recordAttempt(d);
    if (d.mode !== "auto") return;
    autoFailures++;
    if (Number.isFinite(nowMs)) backoff[d.sliceId] = nowMs + relaunchBackoffMs(d.attempt, d.sliceId);
  };

  for (const d of decisions) {
    if (d.mode === "auto") {
      autoAttempts++;
      if (d.autoRateLimited) autoRateLimited = true;
    }

    const slice = state.slices[d.sliceId];

    // Auto path: an escalated-infra slice is un-escalated in place first so the
    // relaunch re-attaches to its preserved PR/worktree (never nukes).
    if (d.unescalateStage && slice) {
      const stageChanged = unescalate(
        slice,
        d.unescalateStage,
        ctx.ts,
        "Auto-recovery: un-escalated for steward relaunch (infra failure, #stranded)",
      );
      if (stageChanged) {
        ctx.emitTransition?.({ type: "slice.stage.changed", sliceId: d.sliceId, stage: d.unescalateStage });
      }
    }

    if (!deps.worktreeExists(d.worktreePath)) {
      try {
        await deps.ensureWorktree(d.worktreePath, d.featureBranch, state.repoPath as string);
      } catch (err) {
        recordFailure(d);
        res.mutated = true;
        res.actions.push({
          action: "relaunch-failed",
          sliceId: d.sliceId,
          sessionId: null,
          detail:
            "could not recreate worktree at " + d.worktreePath + " from branch " + d.featureBranch +
            " (" + attemptLabel(d) + "): " + errMsg(err),
        });
        continue;
      }
    }

    // Capture the PRIOR steward's identity BEFORE the rebind so we can reap its
    // Brood record after the new one is registered (#308).
    const priorSessionId = typeof slice.worker_session_id === "string" ? slice.worker_session_id : "";
    const priorWorktree = typeof slice.worktree_path === "string" ? slice.worktree_path : "";
    // The Hatchery spawn this steward belongs to — re-registered as the new
    // row's parentId so Brood keeps the spawn↔steward group intact (#308).
    const parentSpawnId =
      slice.hatchery && typeof slice.hatchery.spawn_id === "string" ? slice.hatchery.spawn_id : "";

    let newSessionId: string | null = null;
    let liveWorktree = d.worktreePath;
    try {
      const relaunched = await ctx.castra.launchSession({
        profile: ctx.meta.profile,
        repoPath: state.repoPath as string,
        branch: d.bareBranch,
        title: d.launchTitle,
        group: ctx.meta.worker_group,
        model: "opus",
        // Attach to the EXISTING branch/PR — never `-b` (it already exists). This
        // flag was previously dropped by the async client, collapsing the attach
        // into a create that always failed "branch already exists".
        createBranch: false,
        traceKey: d.sliceId,
      });
      newSessionId = relaunched.sessionId;
      // The launch response carries the session's REAL worktree (agent-deck may
      // pick a fresh hashed path when feature-<branch> already exists); register
      // and track THAT, not the assess-time guess, so Brood owns the live path.
      if (typeof relaunched.worktreePath === "string" && relaunched.worktreePath.length > 0) {
        liveWorktree = relaunched.worktreePath;
      }
    } catch (err) {
      recordFailure(d);
      res.mutated = true;
      res.actions.push({ action: "relaunch-failed", sliceId: d.sliceId, sessionId: null, detail: "castra launch failed (" + attemptLabel(d) + "): " + errMsg(err) });
      continue;
    }
    if (!newSessionId) {
      recordFailure(d);
      res.mutated = true;
      res.actions.push({ action: "relaunch-failed", sliceId: d.sliceId, sessionId: null, detail: "castra launch returned no identifiable new session (" + attemptLabel(d) + ")" });
      continue;
    }

    try {
      await ctx.castra.sendPrompt({ profile: ctx.meta.profile, sessionId: newSessionId, prompt: stewardResumeMessage(d), traceKey: d.sliceId } as any);
    } catch {
      // Best-effort: session is alive; future babysit messages will still reach it.
    }

    // #308: register the LIVE steward with Brood and reap the prior one's record
    // so Brood tracks exactly one live steward + worktree per slice. Best-effort
    // — neither call may fail the relaunch (the live session must serve the PR).
    const reconcileNote = await reconcileBrood(ctx, state, d, {
      newSessionId,
      liveWorktree,
      priorSessionId,
      priorWorktree,
      parentSpawnId,
    });

    slice.worker_session_id = newSessionId;
    slice.worker_title = d.launchTitle;
    slice.worktree_path = liveWorktree;
    slice.last_action = ctx.ts;
    slice.last_action_note = "Re-launched steward for PR #" + d.prNumber + " (" + attemptLabel(d) + "); new session " + newSessionId;
    // Record the LIVE worktree (the launch-reported path, which may be a fresh
    // agent-deck hash) so the fold keeps it durably — a cold-start rebuild then
    // re-attaches to the real worktree instead of re-guessing a colliding one
    // (#410/#412).
    ctx.emitTransition?.({ type: "steward.relaunched", sliceId: d.sliceId, sessionId: newSessionId, worktreePath: liveWorktree });
    recordAttempt(d);
    // Healed: clear any pending backoff window so a future re-strand re-probes
    // promptly (its first backoff is short again).
    if (d.mode === "auto") delete backoff[d.sliceId];
    res.mutated = true;
    res.actions.push({
      action: "relaunch-steward",
      sliceId: d.sliceId,
      sessionId: newSessionId,
      detail:
        "re-attached opus steward to PR #" + d.prNumber + " on " + d.featureBranch +
        " (" + attemptLabel(d) + ")" + (reconcileNote ? "; " + reconcileNote : ""),
    });
  }

  // AIMD: a fully-successful rate-limited sweep earns +1; ANY failure halves R.
  if (autoAttempts > 0) {
    const current = readRate(state.raw);
    const next = stepRecoveryRate(current, { failures: autoFailures, rateLimited: autoRateLimited });
    if (next !== current) state.raw.recovery_rate = next;
  }

  return res;
}

/** Human-readable attempt label: bounded "N/limit" for the ladder, open-ended
 *  "attempt N, backing off" for the self-healing path. */
function attemptLabel(d: RelaunchDecision): string {
  return d.mode === "ladder" ? "attempt " + d.attempt + "/" + d.limit : "auto attempt " + d.attempt + ", backing off";
}
