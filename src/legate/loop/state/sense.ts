import type { LoopMeta } from "../meta.js";
import type { LoopState, SliceExternalState, SmithyView } from "./types.js";
import { sessionMatchesSlice, summarizeWorkers } from "../pure/session.js";
import { isTerminalSlice } from "../pure/slice.js";
import { readySmithyItems } from "../pure/smithy-graph.js";

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
  readonly listSessions: () => any[] | { error: string };
  /** Best-effort default-branch sync before reading smithy (keeps status fresh). */
  readonly syncDefaultBranch: (repoPath: string, knownDefault?: string) => void;
  readonly readSmithyStatus: (repoPath: string) => any;
  /** Per-slice PR state (queryPrForBabysit) for an active slice. */
  readonly queryPr: (slice: any, state: any, repoPath: string | undefined) => any;
  /** Recent session output for login/error detection. */
  readonly sessionOutput: (sessionId: string) => { output: string; error?: string };
  /** Sink for non-fatal sync/sense warnings (so they surface in the action log). */
  readonly warn?: (message: string) => void;
}

function senseSmithy(deps: SenseDeps, state: any, repoPath: string | undefined): SmithyView {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { ok: false, error: "repo path is missing", ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } };
  }
  try {
    deps.syncDefaultBranch(repoPath, state?.repo?.default_branch);
  } catch (err: any) {
    deps.warn?.("sync warning: " + (err?.message || String(err)) + " — proceeding against stale local repo");
  }
  let status: any;
  try {
    status = deps.readSmithyStatus(repoPath);
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

export function senseState(deps: SenseDeps): LoopState {
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

  const sessionList = deps.listSessions();
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
        entry.pr = deps.queryPr(slice, raw, repoPath);
      } catch (err: any) {
        entry.pr = { error: err?.message || String(err) };
      }
      try {
        entry.recentOutput = deps.sessionOutput(sessionId);
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
    sessions,
    sessionsById,
    workers,
    smithy: senseSmithy(deps, raw, repoPath),
    perSlice,
  };
}
