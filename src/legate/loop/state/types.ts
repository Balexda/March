import type { LoopMeta } from "../meta.js";
import type { WorkerSummary } from "../pure/session.js";
import type { CastraClient } from "../../../castra/client.js";
import type { BroodTeardownOptions, BroodTeardownResult } from "../clients/brood.js";

/**
 * Two-stage loop contracts.
 *
 * Stage 1 (`senseState`) does ALL I/O reads into a single immutable-ish
 * {@link LoopState} snapshot. Stage 2 handlers are pure `assess(state) ->
 * Decision[]` + `apply(decisions, ctx, state)` that executes side effects and
 * mutates the snapshot so later handlers see current state without re-polling.
 *
 * This split is what makes the Herald cutover a drop-in: Herald will *push* the
 * per-slice transitions that `senseState` currently polls (`perSlice`), leaving
 * `assess`/`apply` untouched.
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
  /** Mutable state.json object (slices, archived_slices, repo, …). */
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
  /** Persist the (mutated) state.json. */
  persist: (state: LoopState) => void;
  /** Append an action/event record to the action log (+ otel span/log). */
  emit: (event: any) => void;
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
  cleanupCount: number;
  cleanupFailureCount: number;
  ghostCleanupCount: number;
  relaunchCount: number;
  babysitActionCount: number;
  processorRequestCount: number;
  dispatchActionCount: number;
  dispatchFailureCount: number;
}
