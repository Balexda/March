import type { LoopMeta } from "../meta.js";
import type { LoopState, SliceExternalState, SmithyView } from "./types.js";
import { looseSessionMatch, summarizeWorkers } from "../pure/session.js";
import { dispatchableReady, isTerminalSlice } from "../pure/slice.js";
import { readySmithyItems } from "../pure/smithy-graph.js";
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
  const ready = readySmithyItems(status);
  const candidates = Array.isArray(status?.records)
    ? status.records.filter((r: any) => r && r.next_action && !r.virtual)
    : [];
  // "Dispatchable now" is what the loop would actually dispatch this tick: ready
  // MINUS in-flight/archived, the same dedup the dispatcher's assess() applies
  // (#219). Raw `ready.length` over-counts — smithy keeps a slice ready until its
  // PR merges, so stewarded and escalated slices stay in the ready set. Keep
  // blocked/total as the smithy planning view.
  const dispatchable = dispatchableReady(state, ready).length;
  return {
    ok: true,
    status,
    ready,
    queue: {
      dispatchable,
      total: candidates.length,
      blocked: Math.max(0, candidates.length - ready.length),
    },
  };
}

/** A consumer of the Herald inbox — drains + folds, returning the projection. */
export interface HeraldInbox {
  consume(): Promise<SystemState>;
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
    if (!session) continue;
    const sessionId = String(session.id);
    const sliceLike = {
      pr: s.pr,
      branch: s.branch,
      worktree_path: s.worktreePath,
      worker_session_id: sessionId,
      stage: s.stage,
    };
    if (isTerminalSlice(sliceLike)) continue;
    const entry: SliceExternalState = {};
    try {
      let pr = await deps.queryPr(sliceLike, state, repoPath);
      // Implementing slice with no PR yet: queryPr skips (no number to query),
      // so fall back to branch/output-based discovery so the legate sees the PR
      // appear in its inbox uniformly.
      if ((!pr || pr.skipped) && s.stage === "implementing" && !(s.pr as any)?.number && deps.discoverPr) {
        pr = (await deps.discoverPr(sliceLike, state, repoPath, sessionId)) ?? pr;
      }
      entry.pr = pr;
    } catch (err: any) {
      entry.pr = { error: err?.message || String(err) };
    }
    try {
      entry.recentOutput = await deps.sessionOutput(sessionId);
    } catch (err: any) {
      entry.recentOutput = { output: "", error: err?.message || String(err) };
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
