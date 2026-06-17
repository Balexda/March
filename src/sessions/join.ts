import { prSnapshotNumber, type SliceState } from "../herald/events.js";
import type { CastraSession } from "../castra/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import type { SessionSources } from "./gather.js";
import type {
  Divergence,
  SessionState,
  UnifiedSession,
} from "./types.js";

/**
 * The join + divergence classification — the pure core `march sessions` (and,
 * later, `march doctor`) build on. It takes the raw cross-service snapshot from
 * `gatherSessions` and folds it into one row per unit of work, matching the same
 * three ways Brood's reconciler matches a live Castra session to a tracked record
 * (exact session id, exact worktree path per #155, then branch), so the unified
 * view and the `march_brood_sessions_*` gauges agree on what "tracked" means.
 */

/** Brood record kinds that represent a real unit of work (legates are infra). */
const WORK_KINDS = new Set<SessionRecord["kind"]>(["spawn", "steward"]);

/** Herald stages where a steward is actively driving the slice. */
const STEWARD_STAGES = new Set<string>([
  "implementing",
  "pr-in-fix",
  "pr-resolving-conflicts",
  "pr-rebasing",
  "pr-in-rerun",
]);

/** A mutable join accumulator before it is frozen into a {@link UnifiedSession}. */
interface RowAccumulator {
  profile: string;
  sliceId?: string;
  slice?: SliceState;
  castra?: CastraSession;
  /** Active Brood records (spawn + steward) attached to this unit. */
  brood: SessionRecord[];
}

/** Does this live Castra session realize the given fold slice? */
function sessionMatchesSlice(
  session: CastraSession,
  slice: SliceState,
  sliceId: string,
): boolean {
  if (session.metadata?.sliceId && session.metadata.sliceId === sliceId) return true;
  if (slice.sessionId && session.sessionId === slice.sessionId) return true;
  if (slice.worktreePath && session.worktreePath === slice.worktreePath) return true;
  if (!slice.worktreePath && slice.branch && session.branch && session.branch === slice.branch) {
    return true;
  }
  return false;
}

/** The session ids a Brood record may be addressed by (tracked id + steward id). */
function broodIds(rec: SessionRecord): string[] {
  return [rec.id, rec.agentDeckSessionId].filter((v): v is string => !!v);
}

/** Does this active Brood record back the accumulated unit of work? */
function broodMatchesRow(rec: SessionRecord, row: RowAccumulator): boolean {
  const ids = broodIds(rec);
  const sessionIds = [row.castra?.sessionId, row.slice?.sessionId, row.slice?.spawnId].filter(
    (v): v is string => !!v,
  );
  if (sessionIds.some((id) => ids.includes(id))) return true;

  const worktrees = [row.slice?.worktreePath, row.castra?.worktreePath].filter(
    (v): v is string => !!v,
  );
  if (rec.worktreePath && worktrees.includes(rec.worktreePath)) return true;

  const branches = [row.slice?.branch, row.castra?.branch].filter(
    (v): v is string => !!v && v.length > 0,
  );
  if (rec.branch && rec.branch.length > 0 && branches.includes(rec.branch)) return true;

  return false;
}

/**
 * Map a fold slice (plus any live Castra/Brood status) to the operator-meaningful
 * lifecycle vocabulary. Driven primarily by the Herald stage; a steward's
 * self-reported `awaiting_input` overrides to `waiting-on-approval` (the loop
 * can't deliver operator input). Falls back to the live session status when no
 * slice is in the fold (a Castra-only leak or a Brood-only orphan).
 */
function deriveState(row: RowAccumulator): SessionState {
  const slice = row.slice;
  if (slice) {
    if (slice.archived) return "archived";
    if (slice.stewardReport?.status === "awaiting_input") return "waiting-on-approval";
    const stage = slice.stage;
    if (stage === "escalated") return "errored";
    if (stage === "hatchery-pending") return "dispatched";
    if (stage === "pr-open") return "waiting-for-merge";
    if (stage && STEWARD_STAGES.has(stage)) return "in-steward";
    if (stage === "merged") return "waiting-for-merge";
    // A slice with a steward session but no stage yet is implementing.
    if (slice.sessionId) return "in-steward";
    return "unknown";
  }

  // No fold slice — classify from the live session status instead.
  const status = (row.castra?.status ?? row.brood[0]?.status ?? "").trim().toLowerCase();
  if (status === "error" || status === "failed") return "errored";
  if (status === "running" || status === "waiting" || status === "idle" || status === "created") {
    return "in-steward";
  }
  return "unknown";
}

/**
 * States where a live Castra session is EXPECTED to back the slice — so a
 * fold-only slice in one of these is a genuine stale projection (a ghost), while
 * a `waiting-for-merge` / `waiting-on-approval` slice legitimately has no live
 * session (its steward is done) and must NOT be flagged. Mirrors the loop's
 * `STEWARD_STAGES`/dispatched notion of "a session should be attached here".
 */
const SESSION_EXPECTED_STATES = new Set<SessionState>(["dispatched", "in-steward"]);

/**
 * Classify the cross-service divergence. A live Castra session with no Brood
 * record is always a leak; an active Brood record with no live session is always
 * a dead orphan. A fold-only slice is only `stale` when its state expects a live
 * session — otherwise (waiting-for-merge / waiting-on-approval / errored) the
 * absence of a session is normal, not a ghost.
 */
function classifyDivergence(
  presence: { herald: boolean; castra: boolean; brood: boolean },
  state: SessionState,
): Divergence {
  if (presence.castra && !presence.brood) return "castra-only";
  if (presence.brood && !presence.castra) return "brood-only";
  if (presence.herald && !presence.castra && !presence.brood) {
    return SESSION_EXPECTED_STATES.has(state) ? "fold-only" : "ok";
  }
  return "ok";
}

/** Steward record's status wins over the spawn's (it is the live unit). */
function pickBroodRecord(records: readonly SessionRecord[]): SessionRecord | undefined {
  return records.find((r) => r.kind === "steward") ?? records[0];
}

/** Earliest ms timestamp among the candidate ISO strings, or undefined. */
function earliestMs(...isoTimes: Array<string | undefined>): number | undefined {
  let earliest: number | undefined;
  for (const iso of isoTimes) {
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (earliest === undefined || ms < earliest) earliest = ms;
  }
  return earliest;
}

/** Freeze one accumulator into the immutable row the renderers consume. */
function finalizeRow(row: RowAccumulator, now: number): UnifiedSession {
  const slice = row.slice;
  const broodRec = pickBroodRecord(row.brood);
  const spawnRec = row.brood.find((r) => r.containerId) ?? broodRec;
  // A steward row's `id` IS its agent-deck session id (per SessionRecord), so it
  // is the right fallback identity when no live Castra session is attached.
  const stewardRec = row.brood.find((r) => r.kind === "steward");
  const broodSessionId = stewardRec?.agentDeckSessionId ?? stewardRec?.id;

  const presence = {
    herald: !!slice,
    castra: !!row.castra,
    brood: row.brood.length > 0,
  };
  const state = deriveState(row);
  const divergence = classifyDivergence(presence, state);

  const branch = slice?.branch ?? (row.castra?.branch || broodRec?.branch || undefined);
  const worktreePath =
    slice?.worktreePath ?? (row.castra?.worktreePath || broodRec?.worktreePath || undefined);
  const createdMs = earliestMs(row.castra?.createdAt, ...row.brood.map((r) => r.createdAt));

  return {
    sliceId: row.sliceId,
    profile: row.profile,
    state,
    stage: slice?.stage,
    pr: slice ? (prSnapshotNumber(slice.pr) ?? undefined) : undefined,
    branch: branch && branch.length > 0 ? branch : undefined,
    worktreePath,
    containerId: spawnRec?.containerId,
    castraSessionId: row.castra?.sessionId ?? broodSessionId,
    broodStatus: broodRec?.status,
    broodKind: broodRec?.kind,
    ageMs: createdMs !== undefined ? Math.max(0, now - createdMs) : undefined,
    presence,
    divergence,
    escalatedReason: slice?.escalatedReason,
  };
}

/**
 * Join the cross-service snapshot into one row per unit of work. Seeds rows from
 * the Herald fold's (non-archived) slices, attaches each live Castra session to
 * its slice (or opens a Castra-anchored row when it matches none — a leak), then
 * attaches active spawn/steward Brood records by the same id/worktree/branch
 * match (or opens a Brood-anchored row — a dead orphan). `legate` records and
 * torndown rows are excluded: this is the in-flight *work* view.
 *
 * `now` is injected (defaults to wall-clock) so age rendering is deterministic
 * in tests.
 */
export function joinSessions(
  sources: SessionSources,
  now: number = Date.now(),
): UnifiedSession[] {
  const rows: RowAccumulator[] = [];

  // 1. Seed from the fold — one row per live slice.
  for (const [profile, state] of Object.entries(sources.fold.byProfile)) {
    for (const [sliceId, slice] of Object.entries(state.slices)) {
      if (slice.archived) continue; // not in-flight
      rows.push({ profile, sliceId, slice, brood: [] });
    }
  }

  // 2. Attach Castra sessions to their slice, or open a leak row.
  for (const [profile, sessions] of sources.castraByProfile) {
    for (const session of sessions) {
      const match = rows.find(
        (r) =>
          r.profile === profile &&
          !r.castra &&
          r.slice !== undefined &&
          r.sliceId !== undefined &&
          sessionMatchesSlice(session, r.slice, r.sliceId),
      );
      if (match) {
        match.castra = session;
      } else {
        rows.push({
          profile,
          sliceId: session.metadata?.sliceId,
          castra: session,
          brood: [],
        });
      }
    }
  }

  // 3. Attach active spawn/steward Brood records, or open an orphan row.
  for (const rec of sources.brood) {
    if (!WORK_KINDS.has(rec.kind)) continue; // legates are infra, not work
    if (rec.status === "torndown") continue; // not in-flight
    const profile = rec.profile ?? "";
    const match = rows.find((r) => r.profile === profile && broodMatchesRow(rec, r));
    if (match) {
      match.brood.push(rec);
    } else {
      rows.push({ profile, brood: [rec] });
    }
  }

  return rows.map((row) => finalizeRow(row, now));
}
