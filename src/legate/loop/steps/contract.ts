/**
 * Step library — the shared step contract (#463).
 *
 * A *step* is a leaf action the legate can take on one slice/session, factored out
 * of the handler that used to inline it so it can be named, tested in isolation,
 * and reused by more than one control policy (self-heal, the recovery ladder, the
 * driver loop). Each step advertises a {@link StepContract} to the policies that
 * compose it.
 */

/** The contract a step advertises to the policies that compose it. */
export interface StepContract {
  readonly name: string;
  /**
   * True when the step throws away un-recreatable state (a slice incarnation, a
   * worktree, uncommitted work) and therefore needs operator authority — the
   * self-heal policy must refuse to wrap it. False when the step preserves
   * everything (PR / branch / worktree intact) and is safe to run automatically
   * with backoff.
   *
   * This turns the self-heal invariant
   *
   *     automatic ⟺ non-destructive    (authorized ⟺ destructive)
   *
   * from a rule we have to remember into one a policy can enforce mechanically — a
   * self-heal policy refuses to wrap a `destructive` step, so it is structurally
   * impossible to put (say) a tombstone on the automatic backoff path. See #463 for
   * the full step-library / state-machine direction this seeds.
   */
  readonly destructive: boolean;
}
