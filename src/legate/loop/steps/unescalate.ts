/**
 * Step library — seed (#463).
 *
 * A *step* is a leaf action the legate can take on one slice/session, factored
 * out of the handler that used to inline it so it can be named, tested in
 * isolation, and reused by more than one control policy (self-heal, the recovery
 * ladder, the driver loop). The first extracted step is `unescalate`, which was
 * copy-pasted between `recovery.ts` and `relaunch.ts` (inlined to dodge a
 * relaunch↔recovery import cycle) — exactly the duplication the step library
 * exists to remove.
 *
 * Each step carries a {@link StepContract}. The load-bearing field is
 * `destructive`: it turns the self-heal invariant
 *
 *     automatic ⟺ non-destructive    (authorized ⟺ destructive)
 *
 * from a rule we have to remember into one a policy can enforce mechanically — a
 * self-heal policy refuses to wrap a `destructive` step, so it is structurally
 * impossible to put (say) a tombstone on the automatic backoff path. See #463 for
 * the full step-library / state-machine direction this seeds.
 */

/** The contract a step advertises to the policies that compose it. */
export interface StepContract {
  readonly name: string;
  /**
   * True when the step throws away un-recreatable state (a slice incarnation, a
   * worktree, uncommitted work) and therefore needs operator authority — the
   * self-heal policy must refuse to wrap it. False when the step preserves
   * everything (PR / branch / worktree intact) and is safe to run automatically
   * with backoff. `unescalate` only rewrites in-memory slice working state, so it
   * is non-destructive.
   */
  readonly destructive: boolean;
}

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
