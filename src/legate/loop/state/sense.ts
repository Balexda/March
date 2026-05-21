import type { LoopMeta } from "../meta.js";
import type { LoopState, SliceExternalState, SmithyView } from "./types.js";
import { sessionMatchesSlice, summarizeWorkers } from "../pure/session.js";
import { isTerminalSlice } from "../pure/slice.js";
import { readySmithyItems } from "../pure/smithy-graph.js";
import type { ObservedSession, SystemState } from "../../../herald/events.js";

/**
 * Stage 1: gather every external read into one {@link LoopState} snapshot —
 * state.json, Castra sessions (the source of agent-deck activity status),
 * smithy readiness, and the per-slice PR/output state for active slices. This is
 * the surface Herald will later push instead of poll; the I/O is injected via
 * {@link SenseDeps} so it's fully unit-testable.
 */

export interface SenseDeps {
  readonly meta: LoopMeta;
  readonly now: () => string;
  /** Read + parse state.json; return null when absent, throw on a real error. */
  readonly readStateJson: () => any;
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
  // The Herald sense path passes `sync:false` — Herald owns the default-branch
  // sync once it's deployed (`MARCH_HERALD_SYNC=1`), so the legate must not also
  // fetch and fight it. The legacy self-poll path keeps syncing (default true).
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
  return {
    ok: true,
    status,
    ready,
    queue: {
      dispatchable: ready.length,
      total: candidates.length,
      blocked: Math.max(0, candidates.length - ready.length),
    },
  };
}

export async function senseState(deps: SenseDeps): Promise<LoopState> {
  const ts = deps.now();
  let raw: any = null;
  let stateError: string | null = null;
  try {
    raw = deps.readStateJson();
  } catch (err: any) {
    stateError = err?.message || String(err);
  }
  const slices = raw?.slices && typeof raw.slices === "object" ? raw.slices : {};
  const archived = raw?.archived_slices && typeof raw.archived_slices === "object" ? raw.archived_slices : {};
  const repoPath = raw?.repo?.path || deps.meta.repo?.path;

  const sessionList = await deps.listSessions();
  const sessions = Array.isArray(sessionList) ? sessionList : [];
  const sessionsById = new Map<string, any>();
  for (const s of sessions) {
    if (s?.id) sessionsById.set(String(s.id), s);
    if (s?.title) sessionsById.set(String(s.title), s);
    if (s?.name) sessionsById.set(String(s.name), s);
  }
  const workers = summarizeWorkers(sessionList, deps.meta.worker_group);

  // Per-slice external state for slices with a live, non-terminal session — the
  // union of what cleanup (PR terminal?) and babysit (PR/CI/output) need.
  const perSlice: Record<string, SliceExternalState> = {};
  if (raw) {
    for (const [sliceId, slice] of Object.entries(slices) as [string, any][]) {
      if (!slice || typeof slice !== "object") continue;
      const sessionId = String(slice.worker_session_id || "");
      if (!sessionId) continue;
      const sessionPresent = sessions.some((s) => sessionMatchesSlice(s, slice));
      if (!sessionPresent) continue;
      if (isTerminalSlice(slice)) continue;
      const entry: SliceExternalState = {};
      try {
        let pr = await deps.queryPr(slice, raw, repoPath);
        // Implementing slice with no PR yet: queryPr skips (no number to query),
        // so fall back to branch/output-based discovery — Stage 1 owns the read
        // so babysit's assess can treat "discovered" and "queried" uniformly.
        if ((!pr || pr.skipped) && slice.stage === "implementing" && !slice.pr?.number && deps.discoverPr) {
          pr = (await deps.discoverPr(slice, raw, repoPath, sessionId)) ?? pr;
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
  }

  return {
    ts,
    statePresent: Boolean(raw),
    stateError,
    raw,
    slices,
    archived,
    repoPath,
    workerGroup: deps.meta.worker_group,
    sessions,
    sessionsById,
    workers,
    smithy: await senseSmithy(deps, raw, repoPath),
    perSlice,
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
 * Stage 1, Herald cutover (#175): build the same {@link LoopState} snapshot the
 * Stage-2 handlers consume, but sourced from the Herald event inbox instead of
 * the legate's own polling. The expensive per-slice PR/output reads, the Castra
 * session list, and the worker buckets all come from the folded projection
 * ({@link HeraldInbox.consume}); the default-branch sync is dropped (Herald owns
 * it). Two things are still read locally during the PR2 soak:
 *
 *   - `raw` / `slices` / `archived` from **state.json** — the legate-owned
 *     working state, dual-written by the handlers (PR3 retires it for the fold).
 *   - the smithy **ready records** — the dispatch-ordered set is not yet
 *     event-sourced (the fold carries only the queue counts), so it's read via
 *     `smithy status`, but WITHOUT the sync.
 *
 * Gated by the runtime on `heraldConfigured(env)` so an unset deployment keeps
 * {@link senseState} byte-for-byte.
 */
export async function senseFromHerald(deps: SenseDeps, herald: HeraldInbox): Promise<LoopState> {
  const ts = deps.now();
  let raw: any = null;
  let stateError: string | null = null;
  try {
    raw = deps.readStateJson();
  } catch (err: any) {
    stateError = err?.message || String(err);
  }
  const slices = raw?.slices && typeof raw.slices === "object" ? raw.slices : {};
  const archived = raw?.archived_slices && typeof raw.archived_slices === "object" ? raw.archived_slices : {};
  const repoPath = raw?.repo?.path || deps.meta.repo?.path;

  // Drain + fold the Herald inbox: the observed world (sessions, workers,
  // per-slice PR/output) instead of polling gh/git/Castra directly.
  const sys = await herald.consume();

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
    statePresent: Boolean(raw),
    stateError,
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
