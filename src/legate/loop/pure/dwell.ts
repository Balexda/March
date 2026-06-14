import { OTHER_STAGE, SLICE_STAGES, STAGE_ALLOWLIST } from "./slice.js";

/**
 * Time-in-state (dwell) tracking for the loop's slices. Pure + mutating: each
 * tick {@link stampDwell} maintains a per-slice `stage_entered_at` (and, for
 * pr-open slices, a `merge_gate_since`), detecting transitions to record the
 * COMPLETED dwell of the stage just left, and returns the current max age per
 * stage / per merge-gate.
 *
 * Two shapes come out of this (see observability/loop-metrics.ts):
 *   - max-age gauges (`stage_age_max{stage}` / `merge_gate_age_max{gate}`) — the
 *     oldest slice in each state. These drive the dwell ALARMS (spawn too long,
 *     steward too long, ready/blocked-merge-state not draining).
 *   - a dwell histogram (`stage_dwell_seconds{stage}`) from the completed
 *     transitions — for p50/p95 analysis, NOT alarmed.
 *
 * Restart-robustness: on a cold start the in-memory `stage_entered_at` is gone,
 * so a NEW stage entry seeds from a fold-durable per-stage timestamp when one
 * exists (`implementing_started_at`, `pr_open_at`) rather than "now" — otherwise
 * a long-stuck slice would reset to age 0 after every legate restart and never
 * trip its alarm. The book-keeping fields are private (`_dwell_*`).
 */

/** Merge-gate values whose pr-open dwell we track (matches pure/slice MergeReadiness). */
export const TRACKED_MERGE_GATES = ["ready", "waiting-approval", "blocked-merge-state"] as const;

export interface DwellObservation {
  /** Max age (seconds) of any slice currently in each lifecycle stage. */
  readonly stageAgeMaxSeconds: Record<string, number>;
  /** Max age (seconds) of any pr-open slice currently in each merge-gate. */
  readonly mergeGateAgeMaxSeconds: Record<string, number>;
  /** Completed stage dwells (seconds) observed this tick (a slice changed stage). */
  readonly completedStageDwells: ReadonlyArray<{ stage: string; seconds: number }>;
}

function normalizeStage(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return STAGE_ALLOWLIST.has(s) ? s : OTHER_STAGE;
}

/** Fold-durable entry-time hint for a stage, so age survives a legate restart. */
function stageEntryHint(slice: any, stage: string, nowMs: number): number {
  const raw =
    stage === "implementing" ? slice.implementing_started_at :
    stage === "pr-open" ? slice.pr_open_at :
    undefined;
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : nowMs;
}

/** Durable lower-bound for a merge-gate's entry time (pr_open_at), so gate age
 *  survives a restart instead of resetting to 0. */
function gateEntryHint(slice: any, nowMs: number): number {
  const ms = typeof slice.pr_open_at === "string" ? Date.parse(slice.pr_open_at) : NaN;
  return Number.isFinite(ms) ? ms : nowMs;
}

const secondsSince = (nowMs: number, thenMs: number): number => Math.max(0, (nowMs - thenMs) / 1000);

/**
 * Maintain dwell book-keeping on `slices` and return the current max-age view +
 * any completed dwells. Mutates each slice's `stage_entered_at` / `merge_gate_since`
 * (+ private `_dwell_*`); call once per tick on the working slices so the stamps
 * persist across ticks.
 */
export function stampDwell(slices: Record<string, any> | undefined, nowMs: number): DwellObservation {
  const stageAgeMaxSeconds: Record<string, number> = {};
  for (const stage of SLICE_STAGES) stageAgeMaxSeconds[stage] = 0; // pre-seed → stable series at 0
  const mergeGateAgeMaxSeconds: Record<string, number> = {};
  for (const gate of TRACKED_MERGE_GATES) mergeGateAgeMaxSeconds[gate] = 0;
  const completedStageDwells: Array<{ stage: string; seconds: number }> = [];

  for (const slice of Object.values(slices ?? {})) {
    if (!slice || typeof slice !== "object") continue;
    const stage = normalizeStage(slice.stage);

    // Stage transition → record the dwell of the stage just left, re-stamp entry.
    if (slice._dwell_stage !== stage) {
      if (slice._dwell_stage != null && typeof slice.stage_entered_at === "number") {
        completedStageDwells.push({ stage: slice._dwell_stage, seconds: secondsSince(nowMs, slice.stage_entered_at) });
      }
      slice._dwell_stage = stage;
      slice.stage_entered_at = stageEntryHint(slice, stage, nowMs);
    }
    const stageAge = secondsSince(nowMs, slice.stage_entered_at ?? nowMs);
    // `?? 0` because an unexpected stage normalizes to OTHER_STAGE, which is not
    // pre-seeded — without the fallback the comparison is against `undefined` and
    // the `other` age is never recorded (and the record value is undefined).
    if (stageAge > (stageAgeMaxSeconds[stage] ?? 0)) stageAgeMaxSeconds[stage] = stageAge;

    // Merge-gate dwell only applies while pr-open; clear the book-keeping otherwise.
    if (stage === "pr-open" && (TRACKED_MERGE_GATES as readonly string[]).includes(slice.merge_gate)) {
      const gate = slice.merge_gate as string;
      if (slice._dwell_gate !== gate) {
        // First observation after a (re)start: the gate may have already held for
        // a long time, so seed from a durable lower bound (pr_open_at) rather than
        // resetting age to 0 each restart (which would keep the >30m dwell alarms
        // green for a full window). A real gate TRANSITION starts fresh at nowMs.
        const firstObservation = slice._dwell_gate === undefined;
        slice._dwell_gate = gate;
        slice.merge_gate_since = firstObservation ? gateEntryHint(slice, nowMs) : nowMs;
      }
      const gateAge = secondsSince(nowMs, slice.merge_gate_since ?? nowMs);
      if (gateAge > mergeGateAgeMaxSeconds[gate]) mergeGateAgeMaxSeconds[gate] = gateAge;
    } else if (slice._dwell_gate != null) {
      slice._dwell_gate = undefined;
      slice.merge_gate_since = undefined;
    }
  }

  return { stageAgeMaxSeconds, mergeGateAgeMaxSeconds, completedStageDwells };
}
