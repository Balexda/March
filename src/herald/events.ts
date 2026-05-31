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
  /** The legate launched a spawn for a smithy item. `jobId` is the Hatchery job
   *  id, persisted so the legate's completion poll survives a restart. */
  | { type: "slice.dispatched"; sliceId: string; branch?: string; worktreePath?: string; sessionId?: string; jobId?: string; item?: unknown }
  /**
   * Hatchery launched the steward and learned the slice↔session↔spawn pairing
   * (#213). Hatchery is the single integration point that holds all three ids, so
   * it OWNS this correlation fact and publishes it at launch — independent of the
   * legate's job-poll cadence. The reducer merges `sessionId`/`spawnId`/`branch`/
   * `worktreePath` additively, so this writer never fights the legate (which owns
   * stage/lifecycle). `EventType` stays low-cardinality (it is a metric label).
   */
  | { type: "slice.steward.attached"; sliceId: string; sessionId: string; spawnId?: string; branch?: string; worktreePath?: string }
  /** The slice moved to a new stage (implementing/pr-open/merged/…). Carries the
   *  steward `sessionId` on the implementing handoff so the fold learns the
   *  slice→session link Herald's PR discovery is gated on (#210) and a restart's
   *  rebuild keeps it (the latent #210 regression). */
  | { type: "slice.stage.changed"; sliceId: string; stage: string; sessionId?: string }
  /** The slice reached a terminal state and was cleaned up. */
  | { type: "slice.archived"; sliceId: string }
  /** A partial-merge / branch-collision recovery dispatch. */
  | { type: "slice.recovery.dispatched"; sliceId: string; branch?: string; item?: unknown }
  /**
   * Operator-triggered request to recover an escalated slice (#238). Unlike
   * `slice.recovery.dispatched` (the loop's own bounded auto-recovery, #211), this
   * is appended by an operator (`march legate recover <sliceId>`, or the
   * `legate.unwedge` skill) to un-wedge a slice whose recovery budget is exhausted
   * and which therefore has no internal re-dispatch path. The reducer DROPS the
   * slice from the fold and clears its retry counters so a cold-start rebuild no
   * longer reconstructs a blocking entry; the warm loop reconciles its in-memory
   * working state from the drained request (the cold-start fold alone can't reach
   * it — warm-loop invisibility, #238). The still-ready smithy work then dispatches
   * fresh on the next tick. */
  | { type: "slice.recovery.requested"; sliceId: string }
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
    case "slice.steward.attached":
    case "slice.stage.changed":
    case "slice.archived":
    case "slice.recovery.dispatched":
    case "slice.recovery.requested":
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
  /** Hatchery spawn id from `slice.steward.attached` (#213) — the spawn that owns
   *  this slice's steward, for teardown-by-slice. */
  spawnId?: string;
  /** Hatchery job id from `slice.dispatched`; lets the legate's completion poll
   *  resume after a restart (a `hatchery-pending` slice needs its job id). */
  jobId?: string;
  /** Observed PR/CI/review state (the `queryPrForBabysit` shape). */
  pr?: unknown;
  recentOutput?: { output: string; error?: string };
  archived?: boolean;
  escalatedReason?: string;
  /**
   * Tombstone set by `slice.recovery.requested` (#238): the operator recovered this
   * slice, so it carries no live/archived facts and must not block re-dispatch.
   * Observation deltas (`slice.pr.changed`/`slice.output.changed`) that were
   * snapshotted before the recovery and sequenced after it are ignored while this
   * is set, so a stale delta can't resurrect a ghost in-flight slice on a
   * cold-start rebuild. A fresh `slice.dispatched` clears it.
   */
  recovered?: boolean;
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
      // Skip a recovered (tombstoned) slice so a stale observation delta can't
      // resurrect a ghost in-flight slice after recovery (#238).
      if (!state.slices[event.sliceId]?.recovered) {
        sliceOf(state, event.sliceId).pr = event.pr;
      }
      state.statePresent = true;
      state.stateError = null;
      break;
    case "slice.output.changed":
      if (!state.slices[event.sliceId]?.recovered) {
        sliceOf(state, event.sliceId).recentOutput = event.recentOutput;
      }
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
      // A fresh slice.dispatched carries the Hatchery job id and *is* the slice
      // entering hatchery-pending, so record the stage (and clear any prior
      // escalation) — a cold-start rebuild then reproduces the warm-tick shape
      // instead of a stage-less slice the completion poll skips (#255).
      // slice.recovery.dispatched is emitted BEFORE the job-bearing
      // slice.dispatched (recoverDispatch -> launchDispatch), so it must NOT mark
      // the slice pending: a restart in that gap would otherwise rebuild a
      // job-less hatchery-pending slice that the poll skips forever (and that
      // bounded auto-recovery no longer sees as escalated). The inner
      // slice.dispatched sets the stage once the job id exists.
      if (event.type === "slice.dispatched") {
        slice.stage = "hatchery-pending";
        delete slice.escalatedReason;
      }
      if (event.branch !== undefined) slice.branch = event.branch;
      if ("worktreePath" in event && event.worktreePath !== undefined) slice.worktreePath = event.worktreePath;
      if ("sessionId" in event && event.sessionId !== undefined) slice.sessionId = event.sessionId;
      if ("jobId" in event && event.jobId !== undefined) slice.jobId = event.jobId;
      slice.archived = false;
      delete slice.recovered; // a fresh dispatch re-establishes the slice (#238)
      break;
    }
    case "slice.steward.attached": {
      const slice = sliceOf(state, event.sliceId);
      slice.sessionId = event.sessionId;
      if (event.spawnId !== undefined) slice.spawnId = event.spawnId;
      if (event.branch !== undefined) slice.branch = event.branch;
      if (event.worktreePath !== undefined) slice.worktreePath = event.worktreePath;
      slice.archived = false;
      delete slice.recovered; // a steward attach re-establishes the slice (#238)
      break;
    }
    case "slice.stage.changed": {
      const slice = sliceOf(state, event.sliceId);
      slice.stage = event.stage;
      // Mirror slice.dispatched: only set when present so a stage transition
      // without a sessionId never clobbers a known link (#210). The handoff
      // transition carries it so a restart's rebuild keeps the slice→session link.
      if (event.sessionId !== undefined) slice.sessionId = event.sessionId;
      break;
    }
    case "slice.archived":
      sliceOf(state, event.sliceId).archived = true;
      break;
    case "slice.recovery.requested": {
      // Operator recovery (#238): replace the escalated incarnation with a
      // tombstone so a cold-start rebuild produces no blocking slices/archived/
      // budget entry for it, AND so a stale observation delta (snapshotted before
      // the recovery, sequenced after it) can't resurrect a ghost in-flight slice
      // — the pr.changed/output.changed folds skip a tombstoned slice. The
      // deterministic slice id is re-derived from the artifact, so the subsequent
      // fresh `slice.dispatched` clears the tombstone and re-creates it clean.
      // Clearing the retry counters resets the bounded-recovery budget (#211).
      state.slices[event.sliceId] = { sliceId: event.sliceId, recovered: true };
      for (const key of Object.keys(state.retries)) {
        if (key === event.sliceId || key.endsWith(":" + event.sliceId)) delete state.retries[key];
      }
      break;
    }
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
