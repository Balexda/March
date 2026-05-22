import type { LoopMeta } from "../meta.js";
import type { WorkerSummary } from "../pure/session.js";
import type { CastraClient } from "../../../castra/client.js";
import type { BroodTeardownOptions, BroodTeardownResult } from "../clients/brood.js";
import type { TransitionEvent } from "../clients/herald.js";

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
  /** Agent-deck-shaped sessions (mapped from Castra). */
  sessions: any[];
  sessionsById: Map<string, any>;
  workers: WorkerSummary | { error: string };
  smithy: SmithyView;
  perSlice: Record<string, SliceExternalState>;
}

/** Side-effect dependencies handed to each handler's `apply`. */
export interface HandlerContext {
  meta: LoopMeta;
  ts: string;
  castra: CastraClient;
  /** Request teardown of a session via Brood (the teardown authority). */
  broodTeardown: (sessionId: string, opts?: BroodTeardownOptions) => Promise<BroodTeardownResult>;
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
  /** Derived: pr-open slices with clean checks, no conflicts, no threads owed. */
  readyToMergeCount: number;
  cleanupCount: number;
  cleanupFailureCount: number;
  ghostCleanupCount: number;
  relaunchCount: number;
  /** Babysit actions excluding the steward-nudge family (counted separately below). */
  babysitActionCount: number;
  /** Stranded-steward nudges sent this tick. */
  stewardNudgeCount: number;
  /** Stranded-steward escalations raised this tick. */
  stewardStrandedCount: number;
  processorRequestCount: number;
  dispatchActionCount: number;
  dispatchFailureCount: number;
}
