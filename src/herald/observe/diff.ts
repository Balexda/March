import type { LoopState } from "../../legate/loop/state/types.js";
import { isWorkerSession, type WorkerSummary } from "../../legate/loop/pure/session.js";
import type {
  EventBody,
  ObservedSession,
  SystemState,
  WorkerCounts,
} from "../events.js";

/**
 * Pure change detection: compare a freshly-observed {@link LoopState} against the
 * current {@link SystemState} projection and emit one event per delta. Emits
 * NOTHING when nothing changed — that idempotency is what keeps the unified
 * event log change-driven instead of growing one record per heartbeat.
 *
 * Returns event bodies (no `source`/`seq`/`id`); the observer stamps `source`
 * and the observation `ts` and hands them to the store, which assigns `seq`.
 */

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function toObservedSession(s: any): ObservedSession {
  return {
    id: String(s.id),
    present: true,
    status: s.status,
    group: s.group,
    worktreePath: s.worktree_path,
    branch: s.branch,
    title: s.title,
    createdAt: s.created_at,
  };
}

export function diffObserved(prev: SystemState, loop: LoopState): EventBody[] {
  const out: EventBody[] = [];

  // state.json read error (only on transition into error).
  if (loop.stateError && loop.stateError !== prev.stateError) {
    out.push({ type: "state.error", message: loop.stateError });
  }

  // Worker bucket counts. summarizeWorkers returns either the buckets or the
  // `{error: string}` unavailable sentinel — the buckets always carry a numeric
  // `running`, so discriminate on that (the buckets also have a numeric `error`).
  if (loop.workers && typeof (loop.workers as { running?: unknown }).running === "number") {
    const w = loop.workers as WorkerSummary;
    if (!prev.workers || !jsonEq(prev.workers, w)) {
      out.push({ type: "workers.changed", workers: { ...w } as WorkerCounts });
    }
  }

  // Smithy readiness queue (only when smithy read succeeded). Compared
  // field-by-field — the sense queue and the projection order their keys
  // differently, so a JSON compare would false-positive every tick.
  if (loop.smithy?.ok) {
    const q = loop.smithy.queue;
    const p = prev.smithy;
    if (p.dispatchable !== q.dispatchable || p.blocked !== q.blocked || p.total !== q.total) {
      out.push({
        type: "smithy.queue.changed",
        dispatchable: q.dispatchable,
        blocked: q.blocked,
        total: q.total,
      });
    }
  }

  // Worker-group sessions: appearances + status/field changes, then departures.
  const observedIds = new Set<string>();
  for (const s of loop.sessions) {
    if (!isWorkerSession(s, loop.workerGroup)) continue;
    const obs = toObservedSession(s);
    observedIds.add(obs.id);
    const prior = prev.sessions[obs.id];
    if (!prior || !jsonEq(prior, obs)) {
      out.push({ type: "session.changed", session: obs });
    }
  }
  for (const id of Object.keys(prev.sessions)) {
    if (!observedIds.has(id)) {
      out.push({ type: "session.changed", session: { id, present: false } });
    }
  }

  // Per-slice PR + recent-output observations.
  for (const [sliceId, ext] of Object.entries(loop.perSlice)) {
    const prior = prev.slices[sliceId];
    if (ext.pr !== undefined && !jsonEq(prior?.pr, ext.pr)) {
      out.push({ type: "slice.pr.changed", sliceId, pr: ext.pr });
    }
    if (ext.recentOutput !== undefined && !jsonEq(prior?.recentOutput, ext.recentOutput)) {
      out.push({ type: "slice.output.changed", sliceId, recentOutput: ext.recentOutput });
    }
  }

  return out;
}
