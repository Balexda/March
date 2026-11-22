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

/** Operator slice levers that leave a durable request in the fold (#593). */
export type OperatorSliceAction = "merge" | "relaunch";

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
export const REVIEW_REQUEST_REASONS = ["initial", "stale_approval", "stale_changes_requested", "timeout_retry"] as const;

export interface ReviewRequestRecord {
  sliceId: string;
  pr: number;
  reviewer: "coderabbit" | "copilot";
  headSha: string;
  at: string;
  reason: typeof REVIEW_REQUEST_REASONS[number];
}

export const REVIEW_BACKOFF_CAUSES = ["http_429", "rate_limited_comment", "paused_comment", "post_failed", "reset"] as const;

export interface ReviewBackoffRecord {
  reviewer: ReviewRequestRecord["reviewer"];
  until: string;
  attempts: number;
  cause: typeof REVIEW_BACKOFF_CAUSES[number];
  /** Time of the underlying signal, which can precede event ingestion. */
  signalAt?: string;
  /** Stable identity of a sensed throttle notice. */
  noticeId?: string;
  /**
   * A fresh review observed too late to clear the current throttle. The record
   * otherwise repeats the active back-off; only the reset boundary advances.
   */
  resetObservedAt?: string;
}

export type EventBody =
  | ({ type: "review.backoff" } & ReviewBackoffRecord)
  | ({ type: "review.requested" } & ReviewRequestRecord)
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
  /** The plan checkout's default-branch sync status changed (#592). Appended by
   *  Herald's observer only when `ok`/`head`/`originHead`/`behind`/`ahead`/
   *  `defaultBranch` differ from the fold, so a steady checkout costs no events. */
  | { type: "repo.sync.changed"; sync: RepoSyncStatus }
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
  | { type: "slice.stage.changed"; sliceId: string; stage: string; sessionId?: string; handledFeedback?: HandledFeedback }
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
   * fresh on the next tick.
   *
   * The optional `rung` selects the reducer behavior (the graduated-recovery
   * ladder, #412): omitted / `0`-`2` → BEGIN-GRADUATED — the slice's still-true
   * durable facts (`branch`/`worktreePath`/`pr`) are PRESERVED and only its
   * execution state is reset (`recoveryRung` ← the event's `rung`, defaulting to
   * 0; `escalatedReason`/retry budgets cleared) so the gentle rungs can re-attach
   * in place; `3` → the last-resort NUKE that keeps today's #238 tombstone
   * (`recovered:true`) and re-dispatches fresh. The operator CLI append omits
   * `rung` (begin graduated at rung 0); the rung ladder driver (PR2) appends the
   * inner rungs (`1`/`2`) to durably advance the ladder and `3` for the nuke. */
  | { type: "slice.recovery.requested"; sliceId: string; rung?: number }
  /**
   * An OPERATOR asked to REQUEUE this slice (#588/#593): discard its current
   * incarnation — steward session, worktree, branch, and (only with `closePr`) its
   * open PR — and tombstone it so dispatch re-selects the smithy item fresh. Unlike
   * `slice.recovery.requested` it bypasses the graduated ladder (including the
   * rung-0b `awaiting_input` refusal): it is the "throw the output away" lever for
   * a steward whose question can no longer be answered (dead session) or that went
   * off the rails. `operator`/`reason` attribute the request in the log. The
   * reducer records a pending `requeueRequested` so a legate cold start still acts
   * on it; the legate's rung-3 tombstone (success) or `slice.requeue.refused`
   * (refusal / give-up) clears it.
   */
  | { type: "slice.requeue.requested"; sliceId: string; closePr?: boolean; releaseMerged?: boolean; operator?: string; reason?: string }
  /** The legate refused (open PR without `closePr`) or gave up on (teardown kept
   *  failing) a pending requeue; clears `requeueRequested`. */
  | { type: "slice.requeue.refused"; sliceId: string; reason?: string }
  /** A stalled steward was relaunched. Carries the LIVE worktree the relaunch
   *  attached to (agent-deck may mint a fresh hashed path when the expected one is
   *  taken) so the fold records it durably — a cold-start rebuild then keeps the
   *  real worktree instead of the relaunch handler re-guessing a colliding path
   *  (#410/#412). */
  | {
      type: "steward.relaunched";
      sliceId: string;
      sessionId?: string;
      worktreePath?: string;
      /** The operator relaunch request this relaunch settled (#593); absent for automatic relaunches. */
      requestSeq?: number;
    }
  /** The slice was escalated for legate judgement. */
  | { type: "slice.escalated"; sliceId: string; reason?: string }
  /**
   * A steward SELF-REPORT of its own state (push, not scrape): the steward's hook
   * fires when it parks, reads its last message chunk, and POSTs here. `classified`
   * is whether the steward could heuristically classify it; an unclassified report
   * carries only the raw `summary` for the legate-agent to classify later. The
   * legate acts on the folded `status` (e.g. `awaiting_input` → escalate). Herald
   * only RECORDS this — it makes no decision. (#steward-self-report)
   */
  | { type: "slice.steward.report"; sliceId: string; status?: "awaiting_input" | "reported" | "working"; summary?: string; classified: boolean }
  /** A transient auto-recovery retry counter was bumped. */
  | { type: "retry.counted"; key: string; count: number }
  // ── Audit events (Herald break-glass admin endpoint, #265) ──────────────
  /**
   * Forensic record paired with every operator-authored admin append (the
   * `POST /admin/events` break-glass path). It carries the `seq` of the event the
   * operator just appended (named {@link appendedSeq} so it never collides with
   * this audit event's own envelope `seq`) plus the operator + note, so the log is
   * self-describing even to tooling that only reads events and never inspects the
   * `admin`/`operator`/`note` columns. The reducer IGNORES it for state — it is
   * forensics-only. It is intentionally NOT in `POST /events`' accepted set: only
   * the admin route authors it, never a client.
   */
  | { type: "admin.event.appended"; appendedSeq: number; operator: string; note: string }
  /**
   * A profile's merge policy changed through `POST /profiles` (#593). History
   * only — the policy itself lives in the profile registry, which the legate
   * reads live each tick — so the reducer ignores it. `previous`/`mergePolicy`
   * are the before/after policy objects (null when unset). Authored only by
   * Herald's profile route (never accepted on `POST /events`); who changed it is
   * the envelope `operator`/`note`.
   */
  /**
   * Operator levers that act on a whole profile (#593). `legate.tick.requested`
   * is history only (the legate ran a tick on demand). `dispatch.paused` /
   * `dispatch.resumed` toggle the durable {@link SystemState.dispatchPaused} flag:
   * while set the legate launches no NEW work for the profile (relaunch, babysit,
   * merge and recovery keep running). Who asked is the envelope `operator`.
   */
  /**
   * Operator MERGE NOW (#593): squash-merge the slice's open PR on the next tick,
   * bypassing the review/CI merge gates (the head SHA is still pinned). Folds to
   * {@link SliceState.mergeRequested}; cleared by the `merged` stage transition
   * or by `slice.operator.refused {action:"merge"}`.
   */
  | { type: "slice.merge.requested"; sliceId: string; prNumber: number; reason?: string }
  /**
   * Operator RELAUNCH (#593): replace the slice's steward on the next tick —
   * remove a still-live session (keeping the worktree) and attach a fresh one to
   * the preserved PR/branch, bypassing the self-heal backoff. Folds to
   * {@link SliceState.relaunchRequested}; cleared by `steward.relaunched` or by
   * `slice.operator.refused {action:"relaunch"}`.
   */
  | { type: "slice.relaunch.requested"; sliceId: string; reason?: string }
  /** The legate could not carry out an operator slice lever (#593): `action`
   *  names which, `reason` why. Clears that lever's pending request. */
  | {
      type: "slice.operator.refused";
      sliceId: string;
      action: OperatorSliceAction;
      reason: string;
      /** The request seq this refusal settles; a later pending request survives it. */
      requestSeq?: number;
    }
  | { type: "legate.tick.requested"; reason?: string }
  | { type: "dispatch.paused"; reason?: string }
  | { type: "dispatch.resumed"; reason?: string }
  | {
      type: "profile.merge_policy.changed";
      mergePolicy: Record<string, unknown> | null;
      previous: Record<string, unknown> | null;
    };

/** The discriminator values — also the `march.herald.events` metric labels. */
export type EventType = EventBody["type"];

/** Storage/transport envelope assigned by the event store. */
export interface EventEnvelope {
  /** Monotonic sequence assigned on append — the ordering key and inbox cursor.
   *  ONE global seq across all profiles (the stream is multiplexed; the legate
   *  keeps a single cursor and routes each event to its profile's fold). */
  seq: number;
  /** Stable event id (uuid); append is idempotent on it. */
  id: string;
  /** ISO8601 observation/transition time. */
  ts: string;
  source: EventSource;
  /**
   * The profile this event belongs to. Events are folded PER profile so slices
   * from different profiles — whose deterministic `sliceId`s are only unique
   * within a repo and can therefore collide — never clobber each other. The
   * store fills this from the producer's `profile` (or its configured default).
   */
  profile: string;
  /**
   * Audit attributes. `admin` is set ONLY on rows from the break-glass
   * `POST /admin/events` endpoint (#265). `operator`/`note` are set on those rows
   * and on any operator-attributed append (#593): a lever an operator asked the
   * legate for (recover, respond, requeue, merge now, pause, ...), or a
   * merge-policy edit. Absent (undefined) on the loop's own events. They survive
   * the fold as forensic metadata — the reducer never reads them — so an
   * operator's request is always distinguishable from one the services emitted.
   */
  admin?: boolean;
  operator?: string;
  note?: string;
}

/** A fully-materialized event (envelope + body). */
export type HeraldEvent = EventEnvelope & EventBody;

/** What a producer hands to the store; seq/id/ts and `profile` are filled in if absent. */
export type AppendEventInput = EventBody & {
  source: EventSource;
  /** The owning profile. Omit to let the store stamp its configured default. */
  profile?: string;
  id?: string;
  ts?: string;
};

/** The entity an event is about (for store indexing). */
export interface EntityRef {
  kind: "slice" | "session" | "workers" | "smithy" | "repo" | "system";
  id: string;
}

/** Derive the indexed entity ref for an event body. */
export function entityRefOf(body: EventBody): EntityRef {
  switch (body.type) {
    case "review.requested":
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
    case "slice.steward.report":
    case "slice.requeue.requested":
    case "slice.requeue.refused":
    case "slice.merge.requested":
    case "slice.relaunch.requested":
    case "slice.operator.refused":
      return { kind: "slice", id: body.sliceId };
    case "session.changed":
      return { kind: "session", id: body.session.id };
    case "workers.changed":
      return { kind: "workers", id: "all" };
    case "smithy.queue.changed":
      return { kind: "smithy", id: "queue" };
    case "repo.sync.changed":
      return { kind: "repo", id: "sync" };
    case "retry.counted":
      return { kind: "slice", id: body.key };
    case "heartbeat":
    case "state.error":
    case "state.ok":
    case "admin.event.appended":
    case "review.backoff":
    case "profile.merge_policy.changed":
    case "legate.tick.requested":
    case "dispatch.paused":
    case "dispatch.resumed":
      return { kind: "system", id: "all" };
  }
}

/** Comment IDs a successful Legate fix dispatch handled. `dispatchKey` is that
 *  dispatch's action key and `headSha` the PR head it was sent against, so a
 *  restart restores the dispatch context the bounded post-dispatch nudge and the
 *  steward-stuck escalation depend on. */
export type HandledFeedback = {
  kind: "inline" | "conversation";
  commentIds: string[];
  dispatchKey?: string;
  headSha?: string;
};

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
  handledFeedback?: Partial<Record<HandledFeedback["kind"], string[]>>;
  /** The latest feedback fix dispatch (kind, action key, event time). */
  lastFeedbackDispatch?: { kind: HandledFeedback["kind"]; key: string; at: string; headSha?: string };
  recentOutput?: { output: string; error?: string };
  archived?: boolean;
  escalatedReason?: string;
  /** The steward's latest SELF-REPORT (#steward-self-report): its own classified
   *  state + a one-line summary, pushed via its hook (not scraped). The legate acts
   *  on `status` off the fold (e.g. `awaiting_input` → escalate). */
  stewardReport?: { status?: "awaiting_input" | "reported" | "working"; summary?: string; classified: boolean };
  /**
   * Tombstone set by `slice.recovery.requested` (#238): the operator recovered this
   * slice, so it carries no live/archived facts and must not block re-dispatch.
   * Observation deltas (`slice.pr.changed`/`slice.output.changed`) that were
   * snapshotted before the recovery and sequenced after it are ignored while this
   * is set, so a stale delta can't resurrect a ghost in-flight slice on a
   * cold-start rebuild. A fresh `slice.dispatched` clears it.
   */
  recovered?: boolean;
  /**
   * The current rung of the graduated-recovery ladder (#412), set from a
   * begin-graduated `slice.recovery.requested`'s `rung` (0 when the operator CLI
   * omits it) and advanced by the rung driver (PR2) appending an inner-rung event.
   * Durable so the ladder's progress survives a cold-start rebuild (it maps to the
   * working state's `recovery_rung`). Cleared on a clean
   * `slice.dispatched`/`slice.steward.attached` — the slice is then re-established
   * normally and no longer mid-recovery. Distinct from `recovered` (the rung-3
   * tombstone): rungs 0–2 keep the live slice and its observations.
   */
  recoveryRung?: number;
  /**
   * A pending operator requeue (#588/#593), set by `slice.requeue.requested` and
   * cleared by `slice.requeue.refused` or the rung-3 tombstone the legate appends
   * once the incarnation is torn down. Durable so a legate cold start re-reads it.
   * `seq` is the request event's seq, so the legate can tell a request it already
   * handled (its tombstone not yet drained back) from a new one.
   */
  requeueRequested?: { seq: number; closePr: boolean; releaseMerged?: boolean; operator?: string; reason?: string };
  /** Pending operator MERGE NOW (#593): the request seq and the PR it targets. */
  mergeRequested?: { seq: number; prNumber: number };
  /** Pending operator RELAUNCH (#593): the request seq. */
  relaunchRequested?: { seq: number };
}

/** The folded system state — the projection both services read. */
export interface SystemState {
  reviewRequests?: ReviewRequestRecord[];
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
  /** The plan checkout's default-branch sync status (#592); absent until Herald
   *  has synced this profile once. */
  repoSync?: RepoSyncStatus;
  /** Transient auto-recovery retry counters (replaces state.json's). */
  retries: Record<string, number>;
  /**
   * Set while an operator has paused fresh dispatch for this profile (#593):
   * the `dispatch.paused` seq/ts and its reason. Durable across restarts; cleared
   * by `dispatch.resumed`.
   */
  dispatchPaused?: { seq: number; ts: string; reason?: string };
}

/**
 * The plan checkout's default-branch sync status (#592), as of Herald's last
 * observed change. `behind`/`ahead` count commits between local HEAD and
 * `origin/<defaultBranch>` after the fetch; on a failed sync they are the
 * last-known local values (null when unreadable) and `error` says why.
 */
export interface RepoSyncStatus {
  ok: boolean;
  defaultBranch: string | null;
  head: string | null;
  originHead: string | null;
  behind: number | null;
  ahead: number | null;
  error?: string;
  /** When this status was observed (ISO). */
  at: string;
}

/** True when two sync statuses differ in a field worth an event (not `at`/`error` text). */
export function repoSyncChanged(prev: RepoSyncStatus | undefined, next: RepoSyncStatus): boolean {
  if (!prev) return true;
  return (
    prev.ok !== next.ok ||
    prev.defaultBranch !== next.defaultBranch ||
    prev.head !== next.head ||
    prev.originHead !== next.originHead ||
    prev.behind !== next.behind ||
    prev.ahead !== next.ahead
  );
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

/** A slice the fold holds as an OWN entry. A plain-object lookup of `__proto__`
 *  or `constructor` returns an inherited value, and writing a pending request
 *  onto it would pollute every slice (#593). */
function ownSlice(state: SystemState, sliceId: string): SliceState | undefined {
  return Object.hasOwn(state.slices, sliceId) ? state.slices[sliceId] : undefined;
}

/** The PR number on an observed PR snapshot (the `queryPrForBabysit` shape), or
 *  null when the snapshot carries none (`undefined` / `{skipped}` / `{error}`). */
export function prSnapshotNumber(pr: unknown): number | null {
  const n = (pr as { number?: unknown } | undefined)?.number;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
  // Match the numeric path: a PR number is a positive integer, so reject "0"
  // (and any other non-positive string) instead of treating it as concrete.
  if (typeof n === "string" && /^[0-9]+$/.test(n)) {
    const parsed = Number(n);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

/** True when an observed PR snapshot carries a query error — the transient
 *  `{error}` shape `queryPrForBabysit` returns when a `gh pr view` throws
 *  (auth / rate-limit / network). Distinct from a numberless None blip. */
export function prSnapshotErrored(pr: unknown): boolean {
  const err = (pr as { error?: unknown } | undefined)?.error;
  return err !== undefined && err !== null && err !== "";
}

/** True when an observed PR snapshot is in a terminal state (MERGED/CLOSED). */
export function isTerminalPrSnapshot(pr: unknown): boolean {
  const state = (pr as { state?: unknown } | undefined)?.state;
  return state === "MERGED" || state === "CLOSED";
}

/**
 * True when replacing the observed PR `prior` with `next` would REGRESS a known
 * PR — i.e. `prior` carries a number or is terminal, but `next` has neither
 * (a `{skipped: missing_pr_number}` / `{error}` / numberless snapshot).
 *
 * This is the merge-detection guard (#288): once a PR has merged, its branch is
 * deleted, so Herald's branch-rediscovery fallback comes back empty and produces
 * a numberless "None" observation. Folding that would overwrite the tracked PR
 * number and strand the slice — it then re-discovers forever by a branch that no
 * longer exists and never observes the terminal MERGED. A merged PR's number,
 * however, stays queryable (`gh pr view <n>` returns MERGED forever), so keeping
 * the number is exactly what lets the next by-number query reach the merge. A
 * *concrete* observation (carrying a number, or a terminal state) is never a
 * regression, so OPEN→MERGED/CLOSED still folds through normally.
 */
export function prObservationRegresses(prior: unknown, next: unknown): boolean {
  const priorKnown = prSnapshotNumber(prior) !== null || isTerminalPrSnapshot(prior);
  const nextConcrete = prSnapshotNumber(next) !== null || isTerminalPrSnapshot(next);
  return priorKnown && !nextConcrete;
}

/**
 * Resolve the PR snapshot to STORE given the prior stored snapshot and a new
 * observation. Centralizes the #288 monotonic-fold rules so the diff (what event
 * to emit) and the reducer (what to fold) can never disagree — the diff emits iff
 * this would change the stored value, and the reducer assigns exactly this:
 *
 *  - a CONCRETE observation (carries a number, or is terminal MERGED/CLOSED)
 *    always wins, so OPEN→MERGED/CLOSED still folds through;
 *  - a transient `{error}` against a KNOWN, non-terminal PR keeps the tracked
 *    number/state but ATTACHES the error, so the slice stays queryable next tick
 *    (#288) yet the legate's babysit still emits its `query-failed` action instead
 *    of silently acting on a stale OPEN snapshot (a real auth/rate/network failure
 *    must surface). A subsequent success clears the error (it is a concrete win);
 *  - any other regression — a numberless None blip from a deleted branch, or an
 *    error against an already-terminal PR — keeps the prior snapshot untouched.
 */
export function nextPrSnapshot(prior: unknown, next: unknown): unknown {
  if (next === undefined) return prior;
  if (!prObservationRegresses(prior, next)) return next;
  if (prSnapshotErrored(next) && prior !== undefined && !isTerminalPrSnapshot(prior)) {
    return { ...(prior as Record<string, unknown>), error: (next as { error?: unknown }).error };
  }
  return prior;
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
    case "review.requested": {
      const { sliceId, pr, reviewer, headSha, at, reason } = event;
      (state.reviewRequests ??= []).push({ sliceId, pr, reviewer, headSha: headSha.toLowerCase(), at, reason });
      break;
    }
    case "slice.pr.changed": {
      // Skip a recovered (tombstoned) slice so a stale observation delta can't
      // resurrect a ghost in-flight slice after recovery (#238). Otherwise fold the
      // observation through the monotonic-fold rules (#288): a branch-deletion None
      // blip can't null a known PR, but a concrete state (number / MERGED / CLOSED)
      // and a surfaced query error both flow through. See {@link nextPrSnapshot}.
      if (!state.slices[event.sliceId]?.recovered) {
        const slice = sliceOf(state, event.sliceId);
        slice.pr = nextPrSnapshot(slice.pr, event.pr);
      }
      state.statePresent = true;
      state.stateError = null;
      break;
    }
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
    case "repo.sync.changed":
      state.repoSync = { ...event.sync };
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
      delete slice.recoveryRung; // …and ends any graduated-recovery walk (#412)
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
      delete slice.recoveryRung; // …and ends any graduated-recovery walk (#412)
      break;
    }
    case "slice.stage.changed": {
      const slice = sliceOf(state, event.sliceId);
      slice.stage = event.stage;
      // A merge (operator-requested or the auto-merge gate) settles any pending
      // operator merge request (#593).
      if (event.stage === "merged") delete slice.mergeRequested;
      // Mirror slice.dispatched: only set when present so a stage transition
      // without a sessionId never clobbers a known link (#210). The handoff
      // transition carries it so a restart's rebuild keeps the slice→session link.
      if (event.sessionId !== undefined) slice.sessionId = event.sessionId;
      if (event.handledFeedback) {
        const { kind, commentIds } = event.handledFeedback;
        const handled = (slice.handledFeedback ??= {});
        handled[kind] = [...new Set([...(handled[kind] ?? []), ...commentIds])];
        const { dispatchKey, headSha } = event.handledFeedback;
        if (dispatchKey) {
          slice.lastFeedbackDispatch = { kind, key: dispatchKey, at: event.ts, ...(headSha ? { headSha } : {}) };
        }
      }
      break;
    }
    case "slice.archived":
      sliceOf(state, event.sliceId).archived = true;
      break;
    case "slice.recovery.requested": {
      // Graduated recovery (#412). The optional `rung` selects the behavior:
      //
      //  - rung===3 — the LAST-RESORT NUKE (today's #238 behavior, regression
      //    locked): replace the escalated incarnation with a bare tombstone so a
      //    cold-start rebuild produces no blocking slices/archived/budget entry,
      //    AND so a stale observation delta (snapshotted before the recovery,
      //    sequenced after it) can't resurrect a ghost in-flight slice — the
      //    pr.changed/output.changed folds skip a tombstoned slice. The
      //    deterministic slice id is re-derived from the artifact, so the
      //    subsequent fresh `slice.dispatched` clears the tombstone and re-creates
      //    it clean. The `recovered` stale-observation guard is set ONLY here.
      //
      //  - otherwise (operator CLI append, or the driver's rung 0-2) —
      //    BEGIN-GRADUATED: keep the live slice and its still-true durable facts
      //    (`branch`/`worktreePath`/`pr`) so the gentle rungs can re-attach in
      //    place, and reset only its execution state. `recoveryRung` is set to the
      //    event's `rung` (defaulting to 0 when the operator CLI omits it), so an
      //    inner-rung event the driver appends DURABLY records the ladder's
      //    progress — a cold-start rebuild then resumes at that rung instead of
      //    restarting from zero. The escalation reason is cleared. The slice is NOT
      //    tombstoned, so its observations keep folding through normally.
      //
      // Both branches clear the retry counters so the bounded-recovery budget
      // (#211) starts fresh — the ladder must be able to walk its rungs from zero,
      // and the nuke re-dispatches clean.
      if (event.rung === 3) {
        state.slices[event.sliceId] = { sliceId: event.sliceId, recovered: true };
      } else {
        const slice = sliceOf(state, event.sliceId);
        slice.recoveryRung = event.rung ?? 0;
        delete slice.escalatedReason;
      }
      for (const key of Object.keys(state.retries)) {
        if (key === event.sliceId || key.endsWith(":" + event.sliceId)) delete state.retries[key];
      }
      break;
    }
    case "steward.relaunched": {
      const slice = sliceOf(state, event.sliceId);
      // An operator relaunch settles only the request it carried out (#593): one
      // filed while it ran (higher seq) stays pending. An automatic relaunch
      // (no requestSeq) never settles an operator request.
      if (
        slice.relaunchRequested &&
        typeof event.requestSeq === "number" &&
        slice.relaunchRequested.seq <= event.requestSeq
      ) {
        delete slice.relaunchRequested;
      }
      if (event.sessionId !== undefined) slice.sessionId = event.sessionId;
      // Record the LIVE worktree the relaunch attached to (#410/#412) so a
      // cold-start rebuild keeps it instead of the relaunch handler re-guessing a
      // colliding path. Merged additively — never clobber a known path with absent.
      if (event.worktreePath !== undefined) slice.worktreePath = event.worktreePath;
      // A relaunch attaches a FRESH steward, which voids the PRIOR steward's stale
      // self-report — the new one has not reported yet. Clear it so the loop does
      // not act on a dead session's report: without this, an un-escalated slice
      // whose old report was `awaiting_input` is immediately RE-escalated by
      // babysit (its live-session re-check fires `awaitingNow` off the stale
      // report) — the exact bounce that walls a self-healed human-hold slice back
      // off the auto path. The fresh steward emits its own report when it acts.
      delete slice.stewardReport;
      break;
    }
    case "slice.escalated": {
      const slice = sliceOf(state, event.sliceId);
      slice.stage = "escalated";
      if (event.reason !== undefined) slice.escalatedReason = event.reason;
      break;
    }
    case "slice.steward.report": {
      // Record the steward's self-report; the legate acts on it off the fold.
      sliceOf(state, event.sliceId).stewardReport = {
        status: event.status,
        summary: event.summary,
        classified: event.classified,
      };
      break;
    }
    case "slice.requeue.requested": {
      const slice = ownSlice(state, event.sliceId);
      // Requeue only acts on a slice the fold knows; a request for an unknown or
      // already-tombstoned slice is a no-op (nothing to discard).
      if (!slice || slice.recovered) break;
      slice.requeueRequested = {
        seq: event.seq,
        closePr: event.closePr === true,
        ...(event.releaseMerged === true ? { releaseMerged: true } : {}),
        ...(event.operator !== undefined ? { operator: event.operator } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
      break;
    }
    case "slice.requeue.refused": {
      const slice = ownSlice(state, event.sliceId);
      if (slice) delete slice.requeueRequested;
      break;
    }
    case "slice.merge.requested": {
      const slice = ownSlice(state, event.sliceId);
      // Like requeue: only a slice the fold knows (and has not tombstoned).
      if (!slice || slice.recovered) break;
      slice.mergeRequested = { seq: event.seq, prNumber: event.prNumber };
      break;
    }
    case "slice.relaunch.requested": {
      const slice = ownSlice(state, event.sliceId);
      if (!slice || slice.recovered) break;
      slice.relaunchRequested = { seq: event.seq };
      break;
    }
    case "slice.operator.refused": {
      const slice = ownSlice(state, event.sliceId);
      // Settle only the request this refusal names: one appended while the
      // refused attempt was in flight stays pending. (No requestSeq → legacy,
      // settles whatever is pending.)
      const settles = (pending?: { seq: number }) =>
        pending && (typeof event.requestSeq !== "number" || pending.seq <= event.requestSeq);
      if (slice && event.action === "merge" && settles(slice.mergeRequested)) delete slice.mergeRequested;
      if (slice && event.action === "relaunch" && settles(slice.relaunchRequested)) delete slice.relaunchRequested;
      break;
    }
    case "retry.counted":
      state.retries[event.key] = event.count;
      break;
    case "admin.event.appended":
      // Forensics-only (#265): the paired audit row never moves system state.
      // The corrective event it records is folded by its OWN type. Still advance
      // seq/ts below so the projection's cursor tracks every appended row.
      break;
    case "profile.merge_policy.changed":
    case "legate.tick.requested":
      // History only (#593): the registry is the policy's source of truth, and a
      // requested tick changes nothing in the fold.
      break;
    case "dispatch.paused":
      state.dispatchPaused = {
        seq: event.seq,
        ts: event.ts,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      };
      break;
    case "dispatch.resumed":
      delete state.dispatchPaused;
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

/**
 * The multi-profile projection: one {@link SystemState} per profile. A single
 * legate drives N profiles and Herald observes N profiles, so the fold is keyed
 * first on `event.profile`. This is what structurally prevents cross-profile
 * sliceId collisions — each profile folds into its own isolated `SystemState`.
 * `seq`/`ts` track the last event folded across ALL profiles (the global stream).
 */
export interface MultiProfileState {
  seq: number;
  ts: string;
  byProfile: Record<string, SystemState>;
  reviewBackoffs?: Partial<Record<ReviewRequestRecord["reviewer"], ReviewBackoffRecord & { seq: number; ts: string }>>;
  reviewNoticeIds?: Record<string, true>;
  /** Latest reset signal time per reviewer; notices at or before it are stale. */
  reviewResetBoundaries?: Partial<Record<ReviewRequestRecord["reviewer"], string>>;
  latestReviewRequests?: Partial<Record<ReviewRequestRecord["reviewer"], ReviewRequestRecord & { profile: string; seq: number }>>;
}

/**
 * True when a stored snapshot predates the account-wide review indexes: it
 * holds review intents but no `latestReviewRequests`. Such a snapshot cannot
 * be folded forward correctly, so the caller replays the log from the start.
 */
export function snapshotLacksReviewIndex(state: MultiProfileState): boolean {
  return !state.latestReviewRequests &&
    Object.values(state.byProfile ?? {}).some((sys) => (sys.reviewRequests?.length ?? 0) > 0);
}

/** A fresh, empty multi-profile projection. */
export function emptyMultiProfileState(): MultiProfileState {
  return { seq: 0, ts: "", byProfile: {} };
}

/**
 * Fold one event into the multi-profile projection: select (creating if absent)
 * the event's profile bucket and apply the existing per-profile {@link reduce}.
 * Mutates and returns `multi`.
 */
export function reduceMulti(multi: MultiProfileState, event: HeraldEvent): MultiProfileState {
  const sys = (multi.byProfile[event.profile] ??= emptySystemState());
  reduce(sys, event);
  if (event.type === "review.backoff") {
    const { reviewer, until, attempts, cause, signalAt, noticeId, resetObservedAt, seq, ts } = event;
    (multi.reviewBackoffs ??= {})[reviewer] = { reviewer, until, attempts, cause, signalAt, noticeId, seq, ts };
    if (noticeId) (multi.reviewNoticeIds ??= {})[noticeId] = true;
    const boundary = cause === "reset" ? signalAt ?? ts : resetObservedAt;
    if (boundary) {
      const resets = (multi.reviewResetBoundaries ??= {});
      if (!(Date.parse(resets[reviewer] ?? "") >= Date.parse(boundary))) resets[reviewer] = boundary;
    }
  }
  if (event.type === "review.requested") {
    const { sliceId, pr, reviewer, headSha, at, reason, profile, seq } = event;
    (multi.latestReviewRequests ??= {})[reviewer] = { sliceId, pr, reviewer, headSha: headSha.toLowerCase(), at, reason, profile, seq };
  }
  multi.seq = event.seq;
  multi.ts = event.ts;
  return multi;
}

/** Fold a sequence of events into a multi-profile projection from `base`/empty. */
export function foldEventsMulti(
  events: Iterable<HeraldEvent>,
  base?: MultiProfileState,
): MultiProfileState {
  const multi = base ? structuredClone(base) : emptyMultiProfileState();
  for (const event of events) reduceMulti(multi, event);
  return multi;
}
