/**
 * Shared Hatchery defaults. Factored out of `spawn-handoff.ts` so the Brood
 * registration helpers can import the agent-deck profile fallback without a
 * runtime import cycle (`spawn-handoff` now imports the launch-time registrar
 * from `service/brood-registration`, which in turn needs these constants).
 */

export const DEFAULT_MANAGER_GROUP = "march-spawn-managers";
// Stewards need agent-deck's session-level auto-mode to keep babysit
// /smithy.fix nudges flowing without pausing the classifier. Empirically,
// sonnet sessions in agent-deck v1.9.17 surface "auto mode unavailable
// for this model" in the TUI even when auto-mode=true is set on the
// session row, leaving the steward stalled mid-workflow. opus has the
// auto-mode capability and reaches the same workflow steps in fewer
// turns, so the per-spawn cost premium is acceptable.
export const DEFAULT_MANAGER_MODEL = "opus";
// Castra requires a concrete agent-deck profile on every request, but the
// Hatchery's `agentDeckProfile` is optional (the deterministic loop always sets
// it; ad-hoc spawns may not). Fall back to agent-deck's conventional default
// profile so a profile-less spawn still resolves to a real session store.
export const DEFAULT_AGENT_DECK_PROFILE = "default";
