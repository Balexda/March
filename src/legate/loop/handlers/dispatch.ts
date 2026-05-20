import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { dispatchSliceId } from "../pure/dispatch-id.js";
import { alreadyArchivedSlice, blockingMergedArchive, inFlightSliceMatches } from "../pure/slice.js";

/**
 * Dispatch: turn smithy's layer-0 ready items into Hatchery codex spawns.
 *
 * Two-stage: assess() is PURE selection over the smithy-ready set that Stage 1
 * already computed (`state.smithy.ready`) plus the live-slice/archive dedup
 * matchers — it decides which items dispatch fresh and which need partial-merge
 * recovery, emitting nothing for items already in-flight or archived. apply()
 * first drains completed Hatchery result files, then launches the selected
 * spawns. The intricate spawn/completion/recovery I/O stays behind injected
 * seams ({@link DispatchDeps}) so the selection logic is unit-testable and the
 * orchestration is wired to the Hatchery client at the seam.
 */

export type DispatchDecision =
  | { kind: "dispatch"; sliceId: string; item: any }
  | { kind: "recovery"; sliceId: string; item: any; mergedArchive: any };

/** Result of draining the pending Hatchery dispatches (run inside apply). */
export interface CompletionResult {
  actions: any[];
  failures: any[];
  mutated: boolean;
  notifications?: { slice: any; sliceId: string; requestKey: string; reason: string; detail: string }[];
}

export interface LaunchResult {
  actions: any[];
  failures: any[];
  mutated: boolean;
  notifications?: { slice: any; sliceId: string; requestKey: string; reason: string; detail: string }[];
}

/** I/O seams — wired to the Hatchery client + git/events at the coordinator. */
export interface DispatchDeps {
  /** Best-effort default-branch sync (already done in sense; re-run is cheap/no-op-safe). */
  syncDefaultBranch?: (state: any) => void;
  /** Drain pending Hatchery result files: complete / recover / escalate. */
  completePending: (state: any, ts: string) => CompletionResult;
  /** Launch a fresh Hatchery codex spawn for a ready item; creates the slice. */
  launchDispatch: (state: any, ts: string, item: any, sliceId: string) => LaunchResult;
  /** Partial-merge recovery dispatch for a ready item colliding with a MERGED archive. */
  recoveryDispatch: (state: any, ts: string, item: any, sliceId: string, mergedArchive: any) => LaunchResult;
  /** Fire a legate-judgement request (idempotent by requestKey). */
  requestJudgement: (input: { ts: string; slice: any; sliceId: string; requestKey: string; reason: string; detail: string }) => any | null;
}

/**
 * Pure: which ready items to act on, and how. Mirrors the runDispatch ready loop
 * — live-slice dedup first, then partial-merge recovery (MERGED archive
 * collision), then the catch-all archive skip; everything else dispatches fresh.
 */
export function assess(state: LoopState): DispatchDecision[] {
  const out: DispatchDecision[] = [];
  if (!state.smithy.ok) return out;
  for (const item of state.smithy.ready) {
    const sliceId = dispatchSliceId(item);
    if (inFlightSliceMatches(state.raw, item, sliceId)) continue;
    const blockingMerged = blockingMergedArchive(state.raw, item, sliceId);
    if (blockingMerged) {
      out.push({ kind: "recovery", sliceId, item, mergedArchive: blockingMerged });
      continue;
    }
    if (alreadyArchivedSlice(state.raw, item, sliceId)) continue;
    out.push({ kind: "dispatch", sliceId, item });
  }
  return out;
}

export function apply(_decisions: DispatchDecision[], ctx: HandlerContext, state: LoopState, deps: DispatchDeps): HandlerResult {
  const res = emptyHandlerResult();
  if (!state.raw) return res;
  if (!state.raw.slices || typeof state.raw.slices !== "object") state.raw.slices = {};
  const ts = ctx.ts;

  // Best-effort: keep local default fresh before re-deriving selection (sense
  // already synced; this is a cheap safety re-run and swallows failures).
  try {
    deps.syncDefaultBranch?.(state.raw);
  } catch {
    /* fetch failures are noise on a healthy system — never escalate */
  }

  // 1. Drain pending Hatchery dispatches (complete / recover / escalate).
  const completed = deps.completePending(state.raw, ts);
  res.actions.push(...completed.actions);
  res.failures.push(...completed.failures);
  if (completed.mutated) res.mutated = true;
  fireNotifications(deps, ts, completed.notifications, res);

  // 2. Re-derive selection AFTER completion so a just-freed slice (runner-silent
  //    auto-recovery) isn't blocked by its own stale in-flight entry this tick.
  for (const decision of assess(state)) {
    const out = decision.kind === "recovery"
      ? deps.recoveryDispatch(state.raw, ts, decision.item, decision.sliceId, decision.mergedArchive)
      : deps.launchDispatch(state.raw, ts, decision.item, decision.sliceId);
    res.actions.push(...out.actions);
    res.failures.push(...out.failures);
    if (out.mutated) res.mutated = true;
    fireNotifications(deps, ts, out.notifications, res);
  }

  if (res.mutated) ctx.persist(state);
  return res;
}

function fireNotifications(
  deps: DispatchDeps,
  ts: string,
  notifications: { slice: any; sliceId: string; requestKey: string; reason: string; detail: string }[] | undefined,
  res: HandlerResult,
): void {
  for (const n of notifications || []) {
    const event = deps.requestJudgement({ ts, slice: n.slice, sliceId: n.sliceId, requestKey: n.requestKey, reason: n.reason, detail: n.detail });
    if (event) {
      res.requests.push(event);
      res.mutated = true;
    }
  }
}
