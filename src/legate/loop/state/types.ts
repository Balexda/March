import type { LoopMeta } from "../meta.js";
import type { WorkerSummary } from "../pure/session.js";
import type { CastraClient } from "../../../castra/client.js";
import type { BroodRegisterResult, BroodRetireResult, BroodTeardownOptions, BroodTeardownResult } from "../clients/brood.js";
import type { RegisterSessionInput } from "../../../brood/service/types.js";
import type { JudgementInput } from "../judgement.js";
import type { TransitionEvent } from "../clients/herald.js";
import type { MergePolicy } from "../../../herald/profiles/merge-policy.js";
import type { SpawnBudget } from "../pure/slice.js";

/**
 * Two-stage loop contracts.
 *
 * Stage 1 (`senseFromHerald`) drains the Herald inbox into a single
 * immutable-ish {@link LoopState} snapshot. Stage 2 handlers are pure
 * `assess(state) -> Decision[]` + `apply(decisions, ctx, state)` that execute
 * side effects, mutate the snapshot so later handlers see current state without
 * re-polling, and append transition events to the log (the durable record).
 *
 * Since the Herald cutover (#176) there is no `state.json`: the working state
 * (`raw`) lives in memory across ticks and is rebuilt from the event-log fold on
 * cold start, so `assess`/`apply` are untouched by where the snapshot comes from.
 */

/** Per-slice external state — the Herald-pushable surface (today polled). */
export interface SliceExternalState {
  /** queryPrForBabysit result (number/state/checks/threads/…) or a skip marker. */
  pr?: any;
  /** Recent session output (for login/error detection). */
  recentOutput?: { output: string; error?: string };
  /** The steward's self-report (#steward-self-report): its own classified state +
   *  a one-line summary, pushed via its hook. babysit acts on `status`
   *  (`awaiting_input` → escalate) instead of scraping `recentOutput`. */
  stewardReport?: { status?: "awaiting_input" | "reported" | "working"; summary?: string; classified: boolean };
}

/** Smithy readiness view derived once per tick. */
export interface SmithyView {
  ok: boolean;
  error?: string;
  /** Raw `smithy status` payload (for graph/dependency reasoning). */
  status?: any;
  /** Layer-0 ready, dispatch-ordered records. */
  ready: any[];
  queue: { dispatchable: number; blocked: number; total: number };
}

/** The single snapshot Stage 2 reads. `apply` mutates it as the world changes. */
export interface LoopState {
  ts: string;
  statePresent: boolean;
  stateError: string | null;
  /** Mutable in-memory working state (slices, archived_slices, repo, …),
   *  threaded across ticks and rebuilt from the event-log fold on cold start. */
  raw: any;
  slices: Record<string, any>;
  archived: Record<string, any>;
  repoPath: string | undefined;
  /** The deployment's worker group (for session classification in handlers). */
  workerGroup: string;
  /** The profile's per-task-type merge policy (undefined = all requirements
   *  enforced). Read by babysit's auto-merge gate; set per-profile each tick. */
  mergePolicy?: MergePolicy;
  /** Agent-deck-shaped sessions (mapped from Castra). */
  sessions: any[];
  sessionsById: Map<string, any>;
  workers: WorkerSummary | { error: string };
  smithy: SmithyView;
  perSlice: Record<string, SliceExternalState>;
  /**
   * Slice ids whose operator recovery (`slice.recovery.requested`, #238) was
   * drained from the Herald inbox THIS tick. The recovery handler reconciles the
   * in-memory `raw` for these (drops the slice + clears its budget) so the
   * still-ready smithy work re-dispatches fresh — acting on the drain is what
   * defeats warm-loop invisibility (the fold alone can't reach the warm `raw`).
   */
  recoveryRequests?: string[];
}

/** Side-effect dependencies handed to each handler's `apply`. */
export interface HandlerContext {
  meta: LoopMeta;
  ts: string;
  castra: CastraClient;
  /** Request teardown of a session via Brood (the teardown authority). */
  broodTeardown: (sessionId: string, opts?: BroodTeardownOptions) => Promise<BroodTeardownResult>;
  /**
   * Back-fill a live-but-untracked session into Brood's registry so Brood owns
   * its teardown by exact path (#155, #225). Optional so tests/handlers that
   * never reconcile can omit it.
   */
  broodRegister?: (input: RegisterSessionInput) => Promise<BroodRegisterResult>;
  /**
   * Retire a prior steward's Brood row (status → torndown) WITHOUT a worktree-
   * pruning teardown — used on a same-worktree relaunch where a teardown would
   * reap the live session by exact-worktree match (#308/#304). Optional so
   * tests/handlers that never relaunch can omit it.
   */
  broodRetire?: (sessionId: string) => Promise<BroodRetireResult>;
  /**
   * Escalate to the legate operator when a handler can't proceed deterministically
   * (rings the doorbell + records a `processor_request`, deduped by `requestKey`).
   * Optional so tests/handlers that never escalate can omit it.
   */
  requestJudgement?: (input: JudgementInput) => Promise<any | null>;
  /**
   * The GLOBAL concurrent-spawn budget (#313), shared across every profile in this
   * tick so the combined number of fresh dispatches can't exceed the cap. Dispatch
   * decrements `remaining` per fresh launch and skips the rest once it hits 0.
   * Optional: when absent (e.g. unit tests, or a caller that doesn't cap), dispatch
   * is unbounded — preserving the pre-#313 behavior.
   */
  spawnBudget?: SpawnBudget;
  /** Append an action/event record to the action log (+ otel span/log). */
  emit: (event: any) => void;
  /**
   * Append a Herald transition event to the unified event log (#176). Since
   * `state.json` was retired this is the SOLE durable record of a transition —
   * the in-memory working state is rebuilt from these events on cold start.
   * Fire-and-forget so a Herald write never blocks or breaks a tick.
   */
  emitTransition?: (event: TransitionEvent) => void;
  /** Append a human-readable line to the action log. */
  log: (line: string) => void;
}

/** What a handler returns after applying its decisions. */
export interface HandlerResult {
  actions: any[];
  failures: any[];
  requests: any[];
  mutated: boolean;
  /**
   * Count of this tick's drained spawn failures whose `[agent_failure_reason]`
   * marker is a hard-down class (the agent is unusable, e.g. codex auth
   * expired). Set only by the dispatch handler; feeds the agent-health
   * circuit-breaker (spawn-breaker.ts). Absent ⇒ 0.
   */
  hardDownFailures?: number;
}

export function emptyHandlerResult(): HandlerResult {
  return { actions: [], failures: [], requests: [], mutated: false };
}

/** Aggregate of a full tick — consumed by the heartbeat. */
export interface TickResult {
  ts: string;
  statePresent: boolean;
  stateError: string | null;
  sliceCount: number;
  archivedSliceCount: number;
  workers: WorkerSummary | { error: string };
  queue: { dispatchable: number; blocked: number; total: number };
  /** Non-archived slice counts keyed by lifecycle stage (#220 gauge source). */
  slicesByStage: Record<string, number>;
  /** All-clear slices the loop WILL squash-merge now (merge_gate=ready). Transient. */
  readyToMergeCount: number;
  /** All-clear slices blocked on a human review gate (merge_gate=waiting-approval).
   *  Human-paced — metric only, not alarmed. */
  waitingOnApprovalCount: number;
  /** All-clear, human-gates-cleared slices GitHub won't merge yet
   *  (merge_gate=blocked-merge-state: UNKNOWN/BEHIND/BLOCKED/DIRTY). */
  blockedOnMergeStateCount: number;
  /** The record-paced set the dispatcher would launch FRESH (dispatchableReady):
   *  ready smithy items minus in-flight/archived. Distinct from queue.dispatchable
   *  (the node-level frontier that over-counts); the precise dispatch-ready signal
   *  the dispatch alarms key on. */
  dispatchableReadyCount: number;
  /** Slices in a steward stage (implementing/pr-open/…) with NO live worker session
   *  behind them — adopted-but-steward-less open PRs + crashed-steward slices. They
   *  look like active "In steward" work but have no resource; surfaced as
   *  `march_legate_slices_stranded`. */
  strandedCount: number;
  /** Escalated-stage slices keyed by escalation reason; sums to slicesByStage.escalated. */
  escalatedByReason: Record<string, number>;
  /** PR-bearing slices keyed by dominant merge BLOCKER (conflicting /
   *  owes_review_threads / owes_comments / ci_failing) — the not-ready reasons the
   *  3-way merge-readiness gauge collapses away (#non-thread-comments). */
  prBlockerCounts: Record<string, number>;
  /** Babysit fix dispatches this tick keyed by kind (conflict_fix / review_fix /
   *  ci_fix / comment_fix) — the per-kind split of the babysit umbrella. */
  babysitActionsByKind: Record<string, number>;
  cleanupCount: number;
  cleanupFailureCount: number;
  ghostCleanupCount: number;
  /** Ghost-cleanup attempts this tick that Brood would not confirm
   *  (`ghost-cleanup-failed`). A loop failing here every tick is invisible on the
   *  success-only counters, so it is metricized on its own (loop-failing monitor). */
  ghostCleanupFailureCount: number;
  /** Ghost-cleanup attempts this tick deferred to Brood because it does not track
   *  the session (`ghost-cleanup-deferred`, a 404). Benign — tombstoned, not retried;
   *  NOT a failure. Metricized so the deferral stays visible instead of going silent. */
  ghostCleanupDeferredCount: number;
  relaunchCount: number;
  /** Steward relaunch attempts this tick that failed (`relaunch-failed`). */
  relaunchFailureCount: number;
  /** Babysit actions excluding the steward-nudge family (counted separately below). */
  babysitActionCount: number;
  /** Stranded-steward nudges sent this tick. */
  stewardNudgeCount: number;
  /** Stranded-steward escalations raised this tick. */
  stewardStrandedCount: number;
  processorRequestCount: number;
  dispatchActionCount: number;
  dispatchFailureCount: number;
  /** GLOBAL concurrent-spawn cap (#313), or undefined when uncapped. Same value
   *  for every profile this tick. */
  spawnCap?: number;
  /** Live spawns across ALL profiles at tick start (the cap's draw). */
  spawnsLive?: number;
  /** Fresh dispatchable items deferred this tick because the cap was reached
   *  (global running tally; they stay dispatchable for a later tick). */
  spawnsDeferred?: number;
}
