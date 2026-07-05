/**
 * Step library — the first extracted step (#463).
 *
 * `unescalate` was copy-pasted between `recovery.ts` and `relaunch.ts` (inlined to
 * dodge a relaunch↔recovery import cycle) — exactly the duplication the step
 * library exists to remove. The shared {@link StepContract} it advertises lives in
 * `./contract.ts`, alongside the CI-fix step and any future leaves.
 */
import type { StepContract } from "./contract.js";

/** The `unescalate` step's contract: a pure in-memory slice mutation, no I/O. */
export const unescalateStep: StepContract = { name: "unescalate", destructive: false };

/**
 * Pure: the working stage an un-escalated slice returns to — `pr-open` when it
 * carries a live PR (so babysit drives it to merge), else `implementing`.
 */
export function deriveUnescalateStage(slice: any): string {
  const n = slice?.pr?.number;
  return typeof n === "number" && n > 0 ? "pr-open" : "implementing";
}

/**
 * Un-escalate a slice in place: move it to the working `stage` and clear the
 * escalation reason + babysit's escalation latches so babysit resumes cleanly.
 * Preserves the PR / branch / worktree — this is the gentle, non-destructive way
 * back onto the working path, used by both the automatic relaunch (infra-fault
 * escalations) and the operator recovery ladder.
 *
 * Returns whether the STAGE actually changed, so the caller emits a durable
 * `slice.stage.changed` only on a real transition (not every maintain tick —
 * that would spam the event log re-announcing an already-`pr-open` slice).
 */
export function unescalate(slice: any, stage: string, ts: string, note: string): boolean {
  const changed = slice.stage !== stage;
  slice.stage = stage;
  slice.escalated_reason = undefined;
  delete slice.steward_awaiting_input_at;
  delete slice.steward_stuck_at;
  delete slice.steward_stuck_head_sha;
  slice.last_action = ts;
  slice.last_action_note = note;
  return changed;
}
