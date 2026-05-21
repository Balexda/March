/**
 * Herald's unified event log — taxonomy + fold.
 *
 * The system state is event-sourced. Herald (the afferent/observe side) appends
 * *observation* events as it senses the world; the legate (the efferent/react
 * side) appends *transition* events as it moves the slice state machine. Both
 * flow into one append-only, monotonically-sequenced log. The current system
 * state is the {@link reduce} fold of that log — state-at-a-point is the fold up
 * to a `seq`, and a delta between two points is the events between two `seq`s.
 *
 * This module is the canonical contract shared by BOTH services: Herald folds it
 * to serve `/state`, and the legate folds it to rebuild the working state its
 * handlers consume. Since #176 this fold is the SOLE source of system state —
 * there is no `state.json`; the legate's in-memory working state is rebuilt from
 * the fold on cold start. Keep `EventType` low-cardinality (it is a metric label).
 */

/** Who wrote an event: Herald observed it, or the legate transitioned it. */
export type EventSource = "herald" | "legate";

/** Worker session counts by status (the `summarizeWorkers` buckets). */
export interface WorkerCounts {
  waiting: number;
  running: number;
  idle: number;
  error: number;
  stopped: number;
  other: number;
}

/** An observed Castra/agent-deck worker session. `present:false` = disappeared. */
export interface ObservedSession {
  id: string;
  present: boolean;
  status?: string;
  group?: string;
  worktreePath?: string;
  branch?: string;
  title?: string;
  createdAt?: string;
}

/**
 * Event bodies, discriminated on `type`. Observation events are written by
 * Herald from PR1; transition events are written by the legate from PR2 (they
 * are defined here from the start so the shared reducer and `POST /events`
 * validation are complete).
 */
export type EventBody =
  // ── Observation events (Herald) ─────────────────────────────────────────
  /** Per-tick marker; carries the observe wall-clock for `/status`. */
  | { type: "heartbeat"; observeDurationMs?: number }
  /** Retired (#176): signalled a state.json read failure. No longer emitted —
   *  Herald reads its own projection now — but kept for replay of pre-#176 logs. */
  | { type: "state.error"; message: string }
  /** Retired (#176): cleared a latched {@link EventBody} `state.error`. Replay-only. */
  | { type: "state.ok" }
  /** A slice's PR/CI/review state changed (the `queryPrForBabysit` shape). */
  | { type: "slice.pr.changed"; sliceId: string; pr: unknown }
  /** A slice's recent session output changed (login/error detection). */
  | { type: "slice.output.changed"; sliceId: string; recentOutput: { output: string; error?: string } }
  /** A worker session appeared / changed status / disappeared. */
  | { type: "session.changed"; session: ObservedSession }
  /** Worker bucket counts changed. */
  | { type: "workers.changed"; workers: WorkerCounts }
  /** Smithy readiness queue changed. */
  | { type: "smithy.queue.changed"; dispatchable: number; blocked: number; total: number }
  // ── Transition events (legate; emitted from PR2) ────────────────────────
  /** The legate launched a spawn for a smithy item. */
  | { type: "slice.dispatched"; sliceId: string; branch?: string; worktreePath?: string; sessionId?: string; item?: unknown }
  /** The slice moved to a new stage (implementing/pr-open/merged/…). */
  | { type: "slice.stage.changed"; sliceId: string; stage: string }
  /** The slice reached a terminal state and was cleaned up. */
  | { type: "slice.archived"; sliceId: string }
  /** A partial-merge / branch-collision recovery dispatch. */
  | { type: "slice.recovery.dispatched"; sliceId: string; branch?: string; item?: unknown }
  /** A stalled steward was relaunched. */
  | { type: "steward.relaunched"; sliceId: string; sessionId?: string }
  /** The slice was escalated for legate judgement. */
  | { type: "slice.escalated"; sliceId: string; reason?: string }
  /** A transient auto-recovery retry counter was bumped. */
  | { type: "retry.counted"; key: string; count: number };

/** The discriminator values — also the `march.herald.events` metric labels. */
export type EventType = EventBody["type"];

/** Storage/transport envelope assigned by the event store. */
export interface EventEnvelope {
  /** Monotonic sequence assigned on append — the ordering key and inbox cursor. */
  seq: number;
  /** Stable event id (uuid); append is idempotent on it. */
  id: string;
  /** ISO8601 observation/transition time. */
  ts: string;
  source: EventSource;
}

/** A fully-materialized event (envelope + body). */
export type HeraldEvent = EventEnvelope & EventBody;

/** What a producer hands to the store; seq/id/ts are filled in if absent. */
export type AppendEventInput = EventBody & {
  source: EventSource;
  id?: string;
  ts?: string;
};

/** The entity an event is about (for store indexing). */
export interface EntityRef {
  kind: "slice" | "session" | "workers" | "smithy" | "system";
  id: string;
}

/** Derive the indexed entity ref for an event body. */
export function entityRefOf(body: EventBody): EntityRef {
  switch (body.type) {
    case "slice.pr.changed":
    case "slice.output.changed":
    case "slice.dispatched":
    case "slice.stage.changed":
    case "slice.archived":
    case "slice.recovery.dispatched":
    case "steward.relaunched":
    case "slice.escalated":
      return { kind: "slice", id: body.sliceId };
    case "session.changed":
      return { kind: "session", id: body.session.id };
    case "workers.changed":
      return { kind: "workers", id: "all" };
    case "smithy.queue.changed":
      return { kind: "smithy", id: "queue" };
    case "retry.counted":
      return { kind: "slice", id: body.key };
    case "heartbeat":
    case "state.error":
    case "state.ok":
      return { kind: "system", id: "all" };
  }
}

/** Per-slice projected state — observed facts merged with legate-owned stage. */
export interface SliceState {
  sliceId: string;
  /** Legate-owned stage, from the legate's transition events (undefined before
   *  the slice's first stage transition). */
  stage?: string;
  branch?: string;
  worktreePath?: string;
  sessionId?: string;
  /** Observed PR/CI/review state (the `queryPrForBabysit` shape). */
  pr?: unknown;
  recentOutput?: { output: string; error?: string };
  archived?: boolean;
  escalatedReason?: string;
}

/** The folded system state — the projection both services read. */
export interface SystemState {
  /** seq of the last event folded in (0 = empty). */
  seq: number;
  /** ts of the last event folded in. */
  ts: string;
  statePresent: boolean;
  stateError: string | null;
  slices: Record<string, SliceState>;
  sessions: Record<string, ObservedSession>;
  workers: WorkerCounts | null;
  smithy: { dispatchable: number; blocked: number; total: number };
  /** Transient auto-recovery retry counters (replaces state.json's). */
  retries: Record<string, number>;
}

/** A fresh, empty projection. */
export function emptySystemState(): SystemState {
  return {
    seq: 0,
    ts: "",
    statePresent: false,
    stateError: null,
    slices: {},
    sessions: {},
    workers: null,
    smithy: { dispatchable: 0, blocked: 0, total: 0 },
    retries: {},
  };
}

function sliceOf(state: SystemState, sliceId: string): SliceState {
  return (state.slices[sliceId] ??= { sliceId });
}

/**
 * Fold one event into the projection. Mutates and returns `state` (the hot
 * projection is updated in place each tick); use {@link foldEvents} for an
 * isolated fold from a base.
 */
export function reduce(state: SystemState, event: HeraldEvent): SystemState {
  switch (event.type) {
    case "heartbeat":
      break;
    case "state.error":
      state.stateError = event.message;
      state.statePresent = false;
      break;
    case "state.ok":
      state.stateError = null;
      state.statePresent = true;
      break;
    case "slice.pr.changed":
      sliceOf(state, event.sliceId).pr = event.pr;
      state.statePresent = true;
      state.stateError = null;
      break;
    case "slice.output.changed":
      sliceOf(state, event.sliceId).recentOutput = event.recentOutput;
      break;
    case "session.changed":
      if (event.session.present) {
        state.sessions[event.session.id] = event.session;
      } else {
        delete state.sessions[event.session.id];
      }
      break;
    case "workers.changed":
      state.workers = event.workers;
      break;
    case "smithy.queue.changed":
      state.smithy = {
        dispatchable: event.dispatchable,
        blocked: event.blocked,
        total: event.total,
      };
      break;
    case "slice.dispatched":
    case "slice.recovery.dispatched": {
      const slice = sliceOf(state, event.sliceId);
      if (event.branch !== undefined) slice.branch = event.branch;
      if ("worktreePath" in event && event.worktreePath !== undefined) slice.worktreePath = event.worktreePath;
      if ("sessionId" in event && event.sessionId !== undefined) slice.sessionId = event.sessionId;
      slice.archived = false;
      break;
    }
    case "slice.stage.changed":
      sliceOf(state, event.sliceId).stage = event.stage;
      break;
    case "slice.archived":
      sliceOf(state, event.sliceId).archived = true;
      break;
    case "steward.relaunched":
      if (event.sessionId !== undefined) sliceOf(state, event.sliceId).sessionId = event.sessionId;
      break;
    case "slice.escalated": {
      const slice = sliceOf(state, event.sliceId);
      slice.stage = "escalated";
      if (event.reason !== undefined) slice.escalatedReason = event.reason;
      break;
    }
    case "retry.counted":
      state.retries[event.key] = event.count;
      break;
  }
  state.seq = event.seq;
  state.ts = event.ts;
  return state;
}

/**
 * Fold a sequence of events into a projection, starting from `base` (cloned so
 * the input is never mutated) or a fresh empty state. Use for `stateAt(seq)` /
 * delta materialization where the hot projection must not be touched.
 */
export function foldEvents(events: Iterable<HeraldEvent>, base?: SystemState): SystemState {
  const state = base ? structuredClone(base) : emptySystemState();
  for (const event of events) reduce(state, event);
  return state;
}
