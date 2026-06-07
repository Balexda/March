import type { LoopMeta } from "../meta.js";
import type { LoopState, SliceExternalState, SmithyView } from "./types.js";
import { looseSessionMatch, summarizeWorkers } from "../pure/session.js";
import { dispatchableReady, isTerminalSlice } from "../pure/slice.js";
import { actionableLayer0Items, queueDepth, readySmithyItems } from "../pure/smithy-graph.js";
import type { ObservedSession, SystemState } from "../../../herald/events.js";

/**
 * Stage 1: gather every external read into one {@link LoopState} snapshot. Since
 * the Herald cutover (#176) the system state is event-sourced, so there are two
 * Herald-backed entry points and NO `state.json`:
 *
 *   - {@link senseFromHerald} — the legate's Stage 1. The working state (`raw`)
 *     is held in memory across ticks and rebuilt from the Herald fold on cold
 *     start; the observed world (sessions, workers, per-slice PR/output) comes
 *     from the fold.
 *   - {@link senseObserved} — Herald's own observation Stage 1. It sources the
 *     slices-to-observe from Herald's projection (fed by the legate's
 *     `slice.dispatched` transition events) and reads the live world for them.
 *
 * The world-observing I/O is injected via {@link SenseDeps} so both paths are
 * fully unit-testable.
 */

export interface SenseDeps {
  readonly meta: LoopMeta;
  readonly now: () => string;
  /** Castra session list, mapped to agent-deck-shaped objects (or `{error}`). */
  readonly listSessions: () => Promise<any[] | { error: string }>;
  /** Best-effort default-branch sync before reading smithy (keeps status fresh). */
  readonly syncDefaultBranch: (repoPath: string, knownDefault?: string) => Promise<void>;
  readonly readSmithyStatus: (repoPath: string) => Promise<any>;
  /** Per-slice PR state (queryPrForBabysit) for an active slice. */
  readonly queryPr: (slice: any, state: any, repoPath: string | undefined) => Promise<any>;
  /** Branch/output-based PR discovery for an implementing slice with no PR yet. */
  readonly discoverPr?: (slice: any, state: any, repoPath: string | undefined, sessionId: string) => Promise<any>;
  /** Recent session output for login/error detection. */
  readonly sessionOutput: (sessionId: string) => Promise<{ output: string; error?: string }>;
  /** Sink for non-fatal sync/sense warnings (so they surface in the action log). */
  readonly warn?: (message: string) => void;
}

async function senseSmithy(
  deps: SenseDeps,
  state: any,
  repoPath: string | undefined,
  opts: { sync?: boolean } = {},
): Promise<SmithyView> {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { ok: false, error: "repo path is missing", ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } };
  }
  // The legate's Herald sense path passes `sync:false` — Herald owns the
  // default-branch sync (`MARCH_HERALD_SYNC=1`), so the legate must not also
  // fetch and fight it. Herald's own observe path syncs (its `syncDefaultBranch`
  // is itself the no-op when read-only), so it leaves the default (true).
  if (opts.sync !== false) {
    try {
      await deps.syncDefaultBranch(repoPath, state?.repo?.default_branch);
    } catch (err: any) {
      deps.warn?.("sync warning: " + (err?.message || String(err)) + " — proceeding against stale local repo");
    }
  }
  let status: any;
  try {
    status = await deps.readSmithyStatus(repoPath);
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err), ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } };
  }
  // `ready` drives the actual dispatch this tick — smithy serializes work per
  // record (one `next_action` each), so the loop paces itself through the layer-0
  // frontier rather than spawning a steward for every ready node at once.
  const ready = readySmithyItems(status);
  // The queue METRIC, by contrast, is measured at the smithy graph's NODE level so
  // the dashboard reflects the true dependency frontier, not the one-next-action-
  // per-record collapse (#289). `dispatchable` = the actionable layer-0 nodes a
  // steward could be launched on now, MINUS work already in-flight/archived (the
  // same dedup `assess()` applies). `blocked` = the next wave (layer 1, one dep
  // away). `total` = the deep backlog (layer ≥ 2).
  const dispatchable = dispatchableReady(state, actionableLayer0Items(status)).length;
  const { blocked, total } = queueDepth(status);
  return {
    ok: true,
    status,
    ready,
    queue: {
      dispatchable,
      total,
      blocked,
    },
  };
}

/**
 * A `slice.steward.attached` (#213) drained in the most recent {@link
 * HeraldInbox.consume}. Hatchery (and, via #265, the break-glass admin endpoint)
 * authors this event — NOT the legate — so the warm in-memory working state never
 * learns of it through the handlers; only the durable fold carries it, and the
 * fold alone reaches the warm loop on the next tick (warm-loop invisibility, the
 * same shape as `slice.recovery.requested`). The inbox surfaces the incremental
 * attachments so {@link senseFromHerald} can reconcile `raw.slices` mid-run,
 * matching what the cold-start {@link rebuildWorkingState} already maps.
 */
export interface StewardAttachment {
  readonly sliceId: string;
  readonly sessionId: string;
  readonly branch?: string;
  readonly worktreePath?: string;
}

/** A consumer of the Herald inbox — drains + folds, returning the projection. */
export interface HeraldInbox {
  consume(): Promise<SystemState>;
  /**
   * Slice ids whose operator `slice.recovery.requested` (#238) was drained in the
   * most recent {@link consume}. Optional so test stubs and pre-#238 callers can
   * omit it; the loop reconciles its in-memory working state for these.
   */
  takeRecoveryRequests?(): string[];
  /**
   * `slice.steward.attached` events (#213/#265) drained in the most recent
   * {@link consume}. Optional so test stubs can omit it; {@link senseFromHerald}
   * folds them into the running `raw.slices` so a mid-run attach (Hatchery push or
   * an operator admin event) takes effect on the next tick without a restart.
   */
  takeStewardAttachments?(): StewardAttachment[];
}

/**
 * Fold the incremental `slice.steward.attached` deltas drained this tick into the
 * running working state (#265). Mirrors the steward-attached mapping in
 * {@link rebuildWorkingState} / the events.ts reducer so the warm path and a
 * cold-start rebuild converge on the same `worker_session_id`/`branch`/
 * `worktree_path`. Only the slice→session correlation fields are touched — never
 * `stage`/`archived`/`pr`, which flow from their own (legate-authored) events.
 */
function applyStewardAttachments(slices: Record<string, any>, attachments: StewardAttachment[]): void {
  for (const att of attachments) {
    // The attach targets a slice the legate already dispatched (so it is present
    // in `raw.slices`); the cold-start rebuild reconstructs any slice the warm
    // state is missing, so skipping an unknown one here can't lose the fact.
    const slice = slices[att.sliceId];
    if (!slice) continue;
    slice.worker_session_id = att.sessionId;
    if (att.branch !== undefined) slice.branch = att.branch;
    if (att.worktreePath !== undefined) slice.worktree_path = att.worktreePath;
    // A steward attach re-establishes the slice — clear any recovery tombstone,
    // mirroring the reducer (events.ts) so cold/warm agree.
    if (slice.recovered) delete slice.recovered;
  }
}

/**
 * Map a folded {@link ObservedSession} back to the agent-deck-shaped session
 * object the Stage-2 handlers + `pure/session.ts` helpers consume (snake_case
 * fields: `worktree_path`, `created_at`, `group`, plus `name` aliasing `title`).
 */
function adaptObservedSession(s: ObservedSession): any {
  return {
    id: s.id,
    title: s.title,
    name: s.title,
    status: s.status,
    group: s.group,
    worktree_path: s.worktreePath,
    branch: s.branch,
    created_at: s.createdAt,
  };
}

/**
 * Cold-start rebuild of the legate's working `raw` from the Herald fold. The
 * fold is intentionally thin (its `EventType` is a low-cardinality metric
 * label), so this restores the slice SET and the durable facts the fold carries
 * — stage, branch, worktree, session, PR snapshot, archive, and the transient
 * retry counters — while the loop's self-healing (PR discovery, branch-collision
 * recovery, stranded-steward nudges) re-derives the per-slice cadence fields the
 * fold does not. A restart therefore resumes against the same slices rather than
 * a blank slate, which is what makes retiring `state.json` safe (#176).
 */
export function rebuildWorkingState(sys: SystemState, meta: LoopMeta): any {
  const slices: Record<string, any> = {};
  const archivedSlices: Record<string, any> = {};
  for (const [sliceId, s] of Object.entries(sys.slices)) {
    // A recovered (tombstoned) slice (#238) carries no live/archived facts and must
    // not block re-dispatch — skip it so the rebuild reconstructs nothing for it; a
    // fresh dispatch re-creates it clean.
    if (s.recovered) continue;
    const pr = s.pr as any;
    const prState = pr?.state;
    if (s.archived) {
      archivedSlices[sliceId] = {
        pr_number: pr?.number ?? null,
        pr_url: pr?.url ?? null,
        branch: s.branch ?? null,
        terminal_state: prState === "MERGED" || prState === "CLOSED" ? prState : s.stage === "merged" ? "MERGED" : null,
      };
      continue;
    }
    const slice: any = {
      kind: "smithy",
      worker_session_id: s.sessionId ?? null,
      branch: s.branch ?? null,
      worktree_path: s.worktreePath ?? null,
      stage: s.stage,
      pr: pr ?? null,
    };
    if (s.escalatedReason !== undefined) {
      slice.last_action_note = s.escalatedReason;
      // Restore the structured class too so bounded auto-recovery (#211) can tell a
      // recoverable escalation from a terminal one after a cold start.
      slice.escalated_reason = s.escalatedReason;
    }
    // Restore the Hatchery job id so a slice still in `hatchery-pending` after a
    // restart can be polled to completion (otherwise the completion poll skips it).
    if (s.jobId) slice.hatchery = { job_id: s.jobId, backend: "codex" };
    slices[sliceId] = slice;
  }
  return {
    repo: { ...(meta.repo ?? {}) },
    slices,
    archived_slices: archivedSlices,
    transient_retry_counts: { ...sys.retries },
  };
}

/**
 * Stage 1 for the legate, Herald-backed (#176). The legate's working state is
 * the in-memory `raw` object threaded across ticks: the Stage-2 handlers mutate
 * it in place and it is never written to disk. On the first tick after process
 * start `prevRaw` is null, so the working state is rebuilt from the Herald fold
 * ({@link rebuildWorkingState}); thereafter the SAME object is reused and the
 * caller keeps it via the returned {@link LoopState.raw}.
 *
 * The observed world (sessions, workers, per-slice PR/output) always comes from
 * the folded inbox ({@link HeraldInbox.consume}); the smithy ready set is read
 * locally WITHOUT syncing (Herald owns the sync). The durable record of every
 * transition is the event log (the handlers' `emitTransition`), so the in-memory
 * `raw` can always be rebuilt after a restart.
 */
export async function senseFromHerald(deps: SenseDeps, herald: HeraldInbox, prevRaw: any): Promise<LoopState> {
  const ts = deps.now();

  // Drain + fold the Herald inbox: the observed world (sessions, workers,
  // per-slice PR/output) instead of polling gh/git/Castra directly.
  const sys = await herald.consume();

  const raw = prevRaw ?? rebuildWorkingState(sys, deps.meta);
  if (!raw.slices || typeof raw.slices !== "object") raw.slices = {};
  if (!raw.archived_slices || typeof raw.archived_slices !== "object") raw.archived_slices = {};
  const slices = raw.slices;
  const archived = raw.archived_slices;
  const repoPath = raw.repo?.path || deps.meta.repo?.path;

  // Fold this tick's `slice.steward.attached` deltas (#213/#265) into the running
  // working state. Hatchery/the admin endpoint — not the legate — authors them, so
  // without this the warm loop keeps acting on a stale (often empty)
  // `worker_session_id` until a restart. On cold start `rebuildWorkingState`
  // already mapped them from the full fold, so re-applying the post-cursor subset
  // is idempotent (same sessionId).
  applyStewardAttachments(slices, herald.takeStewardAttachments?.() ?? []);

  const sessions = Object.values(sys.sessions).map(adaptObservedSession);
  const sessionsById = new Map<string, any>();
  for (const s of sessions) {
    if (s?.id) sessionsById.set(String(s.id), s);
    if (s?.title) sessionsById.set(String(s.title), s);
    if (s?.name) sessionsById.set(String(s.name), s);
  }
  const workers = sys.workers ?? { error: "unavailable" };

  const perSlice: Record<string, SliceExternalState> = {};
  for (const [sliceId, s] of Object.entries(sys.slices)) {
    const entry: SliceExternalState = {};
    if (s.pr !== undefined) entry.pr = s.pr;
    if (s.recentOutput !== undefined) entry.recentOutput = s.recentOutput;
    if (entry.pr !== undefined || entry.recentOutput !== undefined) perSlice[sliceId] = entry;
  }

  return {
    ts,
    statePresent: true,
    stateError: null,
    raw,
    slices,
    archived,
    repoPath,
    workerGroup: deps.meta.worker_group,
    sessions,
    sessionsById,
    workers,
    smithy: await senseSmithy(deps, raw, repoPath, { sync: false }),
    perSlice,
    // Operator recovery requests drained this tick (#238) — the recovery handler
    // reconciles `raw` for these so the still-ready smithy work re-dispatches.
    recoveryRequests: herald.takeRecoveryRequests?.() ?? [],
  };
}

/**
 * Reconcile a projection slice to a live Castra session, in priority order:
 *
 *   1. **Exact recorded id** — the slice's `sessionId` from a correlation event
 *      (#213 push, #214 metadata, or the handoff transition). When present this
 *      is authoritative; if no live session carries it the steward is gone, so we
 *      return null rather than mis-attaching by a looser heuristic.
 *   2. **Self-described metadata** (#214) — a session whose `metadata.sliceId`
 *      equals this slice. Exact, and survives a missed push.
 *   3. **Loose worktree/branch/title match** (#210 gate) — the last-resort
 *      fallback so a missing id degrades to match-by-worktree, not skip-discovery.
 */
export function resolveSliceSession(
  sessions: any[],
  sliceId: string,
  s: { sessionId?: string; branch?: string; worktreePath?: string },
): any | null {
  const recordedId = String(s.sessionId || "");
  if (recordedId) {
    // Authoritative: match the session id EXACTLY. The result's `id` is used as
    // the effective sessionId for PR/output reads, so matching `title`/`name`
    // here (as `sessionMatchesSlice` does) could attach the slice to the wrong
    // steward if another live session's title happened to equal the recorded id.
    return sessions.find((sx) => String(sx?.id ?? "") === recordedId) ?? null;
  }
  const byMeta = sessions.find((sx) => sx?.metadata?.sliceId === sliceId);
  if (byMeta) return byMeta;
  const loose = { sliceId, branch: s.branch, worktree_path: s.worktreePath };
  return sessions.find((sx) => looseSessionMatch(sx, loose)) ?? null;
}

/**
 * Stage 1 for the Herald observation service (#176): assemble the observed
 * {@link LoopState} the diff folds into events, sourcing the slices-to-observe
 * from Herald's OWN projection (`prev`, fed by the legate's `slice.dispatched`
 * transition events) instead of reading the legate's `state.json`. For every
 * non-terminal slice with a live worker session it reads the PR/CI/review state
 * and recent session output — the per-slice surface the legate then drains from
 * the inbox. The world reads (sessions, workers, smithy) are unchanged; the git
 * sync runs through `deps.syncDefaultBranch`, itself a no-op unless Herald is in
 * sync mode.
 */
export async function senseObserved(deps: SenseDeps, prev: SystemState): Promise<LoopState> {
  const ts = deps.now();
  const repoPath = deps.meta.repo?.path;
  // Synthetic working-state shell carrying only the repo identity the gh/git
  // reads need (owner discovery, PR queries). There is no state.json to read.
  const state = { repo: { path: repoPath } };

  const sessionList = await deps.listSessions();
  const sessions = Array.isArray(sessionList) ? sessionList : [];
  const sessionsById = new Map<string, any>();
  for (const s of sessions) {
    if (s?.id) sessionsById.set(String(s.id), s);
    if (s?.title) sessionsById.set(String(s.title), s);
    if (s?.name) sessionsById.set(String(s.name), s);
  }
  const workers = summarizeWorkers(sessionList, deps.meta.worker_group);

  // Per-slice external state for slices the projection knows are live and
  // non-terminal — the union of what cleanup (PR terminal?) and babysit (PR/CI/
  // output) need, mirroring the former state.json-sourced loop.
  const perSlice: Record<string, SliceExternalState> = {};
  for (const [sliceId, s] of Object.entries(prev.slices)) {
    if (s.archived) continue;
    // Resolve the steward session for this slice. A slice with a recorded
    // sessionId (#213 push / #214 metadata / handoff transition) matches by exact
    // id; a slice WITHOUT one degrades to Castra's self-described metadata (#214)
    // and then a worktree/branch/title match (#210 gate) instead of skipping
    // discovery entirely — which is what stranded stewards whose PRs were never
    // adopted (the #210 bug). If nothing resolves, there is no live session to
    // observe, so skip.
    const session = resolveSliceSession(sessions, sliceId, s);
    // #173: PR observation needs only the slice's branch, not a live steward. An
    // escalated slice whose original steward died (no session resolves) but whose
    // branch still has an open PR is the exact adopt case, so do NOT bail on
    // !session for it. Implementing/babysit observation still depends on a live
    // session (it reads session output), so a non-escalated slice with no session
    // is skipped as before.
    const observeEscalatedNoSession = !session && s.stage === "escalated" && !!s.branch && !s.recovered;
    if (!session && !observeEscalatedNoSession) continue;
    const sessionId = session ? String(session.id) : "";
    const sliceLike = {
      pr: s.pr,
      branch: s.branch,
      worktree_path: s.worktreePath,
      worker_session_id: sessionId,
      stage: s.stage,
    };
    // #173: escalated slices are "terminal" for in-flight purposes (isTerminalSlice),
    // but Herald must still OBSERVE an open PR on an escalated slice's branch so the
    // legate can adopt it from the fold on the next branch-collision. So keep an
    // escalated slice that still has a branch (and isn't recovered/tombstoned) in
    // the observation set; every other terminal slice (merged / terminal PR) is
    // skipped as before.
    const observeEscalated = sliceLike.stage === "escalated" && !!sliceLike.branch && !s.recovered;
    if (isTerminalSlice(sliceLike) && !observeEscalated) continue;
    const entry: SliceExternalState = {};
    try {
      let pr = await deps.queryPr(sliceLike, state, repoPath);
      // No PR snapshot yet: queryPr skips (no number to query), so fall back to
      // branch/output-based discovery so the legate sees the PR appear in its
      // inbox uniformly. Observe for an implementing slice (the original case) AND
      // for an escalated slice with a known branch (#173): an escalated/diverged
      // slice may have an open PR from an EARLIER dispatch that the legate must
      // adopt on the next branch-collision — and it only learns of it from this
      // observation. Recovered (tombstoned, #238/#239) slices are excluded; they
      // are re-observed once the recovery's fresh dispatch lands them back in
      // hatchery-pending → implementing.
      const needsPrObservation =
        (!pr || pr.skipped) &&
        !(s.pr as any)?.number &&
        (s.stage === "implementing" || (s.stage === "escalated" && !!s.branch && !s.recovered));
      if (needsPrObservation && deps.discoverPr) {
        pr = (await deps.discoverPr(sliceLike, state, repoPath, sessionId)) ?? pr;
      }
      entry.pr = pr;
    } catch (err: any) {
      entry.pr = { error: err?.message || String(err) };
    }
    // Output observation needs a live session (Castra session output). Skip it
    // gracefully for an escalated slice with no session — there is no worker to
    // read from; the PR observation above is enough for the adopt path, and output
    // deltas resume once a fresh steward attaches.
    if (session) {
      try {
        entry.recentOutput = await deps.sessionOutput(sessionId);
      } catch (err: any) {
        entry.recentOutput = { output: "", error: err?.message || String(err) };
      }
    }
    perSlice[sliceId] = entry;
  }

  return {
    ts,
    statePresent: true,
    stateError: null,
    raw: state,
    slices: {},
    archived: {},
    repoPath,
    workerGroup: deps.meta.worker_group,
    sessions,
    sessionsById,
    workers,
    smithy: await senseSmithy(deps, state, repoPath),
    perSlice,
  };
}
