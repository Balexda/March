/**
 * The "steering required" PR signal (launch-failure recovery plan, step 1).
 *
 * A planning PR (a `cut`, `render`, `mark`, …) whose artifacts gate a slice on an
 * open, unresolved decision ("slice 1 must not be forged until SD-001 is
 * resolved") must not auto-merge until a human answers. The steward reports that
 * case to Hatchery with a `steering` review receipt; Hatchery opens the PR with
 * {@link NEEDS_STEERING_LABEL}; Herald observes the label as
 * `pr.needs_steering`; the legate's merge gate refuses `pr-auto-merge` while it
 * is set, whatever the profile's merge policy. Removing the label re-arms it.
 *
 * The legate's owned-label reconciler (`legate/loop/pure/pr-labels.ts`) never
 * touches this label: only the steward (after applying the human's answer) or a
 * human removes it.
 */

export const NEEDS_STEERING_LABEL = "march:needs-steering";

export const NEEDS_STEERING_LABEL_SPEC = {
  color: "fbca04",
  description: "A steering decision is open — March will not auto-merge this PR until a human answers",
} as const;

/** Smithy verbs whose output is a plan rather than code. Their stewards check for
 *  slice gates on unresolved decisions before reporting. */
export const PLANNING_VERBS = ["cut", "render", "mark", "strike", "ignite"] as const;

/** Does a `gh pr view --json labels` value carry the steering label? */
export function labelsNeedSteering(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => {
    const name = typeof label === "string" ? label : (label as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.toLowerCase() === NEEDS_STEERING_LABEL;
  });
}

/** Is this observed PR snapshot held for a steering decision? */
export function prNeedsSteering(pr: unknown): boolean {
  return (pr as { needs_steering?: unknown } | null | undefined)?.needs_steering === true;
}

export type PlanningVerb = (typeof PLANNING_VERBS)[number];
