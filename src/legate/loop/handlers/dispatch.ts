import type { HandlerContext, HandlerResult, LoopState } from "../state/types.js";
import { emptyHandlerResult } from "../state/types.js";
import { dispatchSliceId } from "../pure/dispatch-id.js";
import { dispatchableReady } from "../pure/slice.js";

/**
 * Dispatch: turn smithy's layer-0 ready items into Hatchery codex spawns.
 *
 * Two-stage: assess() is PURE selection over the smithy-ready set that Stage 1
 * already computed (`state.smithy.ready`) plus the live-slice/archive dedup
 * matchers — it decides which items dispatch fresh, emitting nothing for items
 * already in-flight or archived (a prior MERGED archive that collides counts as
 * archived, so it is skipped, not auto-recovered: the partial-merge recovery
 * dispatch was deleted in #144 along with the rest of the loop's recovery
 * surgery). apply() first drains completed Hatchery jobs, then launches the
 * selected spawns. The spawn/completion I/O stays behind injected seams
 * ({@link DispatchDeps}) so the selection logic is unit-testable and the
 * orchestration is wired to the Hatchery client at the seam.
 */

export type DispatchDecision =
  | { kind: "dispatch"; sliceId: string; item: any };

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
  syncDefaultBranch?: (state: any) => Promise<void>;
  /** Drain pending Hatchery result files: complete / recover / escalate. */
  completePending: (state: any, ts: string) => Promise<CompletionResult>;
  /** Launch a fresh Hatchery codex spawn for a ready item; creates the slice. */
  launchDispatch: (state: any, ts: string, item: any, sliceId: string) => Promise<LaunchResult>;
  /** Fire a legate-judgement request (idempotent by requestKey). */
  requestJudgement: (input: { ts: string; slice: any; sliceId: string; requestKey: string; reason: string; detail: string }) => Promise<any | null>;
}

/**
 * Pure: which ready items to dispatch. Live-slice dedup first, then the archive
 * skip (which subsumes the former partial-merge recovery case — a colliding
 * MERGED archive matches `alreadyArchivedSlice`, so it is skipped rather than
 * re-dispatched); everything else dispatches fresh. The selection is the shared
 * {@link dispatchableReady} (`pure/slice.ts`) so the "dispatchable now" metric
 * (#219) reports the same set this handler launches.
 */
export function assess(state: LoopState): DispatchDecision[] {
  if (!state.smithy.ok) return [];
  return dispatchableReady(state.raw, state.smithy.ready).map((item) => ({
    kind: "dispatch",
    sliceId: dispatchSliceId(item),
    item,
  }));
}

export async function apply(_decisions: DispatchDecision[], ctx: HandlerContext, state: LoopState, deps: DispatchDeps): Promise<HandlerResult> {
  const res = emptyHandlerResult();
  if (!state.raw) return res;
  if (!state.raw.slices || typeof state.raw.slices !== "object") state.raw.slices = {};
  const ts = ctx.ts;

  // Best-effort: keep local default fresh before re-deriving selection (sense
  // already synced; this is a cheap safety re-run and swallows failures).
  try {
    await deps.syncDefaultBranch?.(state.raw);
  } catch {
    /* fetch failures are noise on a healthy system — never escalate */
  }

  // 1. Drain pending Hatchery dispatches (complete / recover / escalate).
  const completed = await deps.completePending(state.raw, ts);
  res.actions.push(...completed.actions);
  res.failures.push(...completed.failures);
  if (completed.mutated) res.mutated = true;
  await fireNotifications(deps, ts, completed.notifications, res);

  // 2. Re-derive selection AFTER completion so a slice freed this tick isn't
  //    blocked by its own stale in-flight entry.
  for (const decision of assess(state)) {
    const out = await deps.launchDispatch(state.raw, ts, decision.item, decision.sliceId);
    res.actions.push(...out.actions);
    res.failures.push(...out.failures);
    if (out.mutated) res.mutated = true;
    await fireNotifications(deps, ts, out.notifications, res);
  }

  return res;
}

async function fireNotifications(
  deps: DispatchDeps,
  ts: string,
  notifications: { slice: any; sliceId: string; requestKey: string; reason: string; detail: string }[] | undefined,
  res: HandlerResult,
): Promise<void> {
  for (const n of notifications || []) {
    const event = await deps.requestJudgement({ ts, slice: n.slice, sliceId: n.sliceId, requestKey: n.requestKey, reason: n.reason, detail: n.detail });
    if (event) {
      res.requests.push(event);
      res.mutated = true;
    }
  }
}
