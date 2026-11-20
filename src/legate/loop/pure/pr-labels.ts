/**
 * Pure rules for the two GitHub PR labels the legate owns:
 *   - `march:opened`      — March is managing this PR; leave it to the legate.
 *   - `march:needs-human` — March needs a human to act on this PR.
 * The reconciler adds an owned label where it is missing and removes it where it
 * does not apply, and never touches any other label.
 */

export const OPENED_LABEL = "march:opened";
export const NEEDS_HUMAN_LABEL = "march:needs-human";

/** The labels the legate reconciles. Nothing outside this list is ever emitted. */
export const OWNED_LABELS: readonly string[] = [OPENED_LABEL, NEEDS_HUMAN_LABEL];

export const LABEL_SPECS: Record<string, { color: string; description: string }> = {
  [OPENED_LABEL]: {
    color: "1d76db",
    description: "Opened and managed by March — leave it to the legate",
  },
  [NEEDS_HUMAN_LABEL]: {
    color: "d93f0b",
    description: "March legate needs a human to act on this PR",
  },
};

/** The `gh pr list --json` fields the reconciler reads. */
export interface LabelPr {
  number: number;
  headRefName?: string;
  author?: { login?: string };
  labels?: Array<{ name?: string }>;
}

export interface LabelDiffEntry {
  pr: number;
  sliceId?: string;
  add: string[];
  remove: string[];
}

/** Head-branch prefixes March itself creates (dispatchBranch, its `feature/`
 *  local ref, and the hatchery manager branch). */
const MARCH_BRANCH_PREFIXES = ["smithy/", "feature/smithy/", "march/spawn/"];

export function isMarchBranch(branch: string | undefined): boolean {
  const b = String(branch ?? "");
  return MARCH_BRANCH_PREFIXES.some((p) => b.startsWith(p));
}

export function isDependabotAuthor(pr: LabelPr): boolean {
  return String(pr.author?.login ?? "").toLowerCase().includes("dependabot");
}

/** Does this slice need a human? `merge_gate` is babysit's live verdict stamp. */
export function sliceNeedsHuman(slice: any): boolean {
  return (
    slice?.stage === "escalated" ||
    slice?.merge_gate === "waiting-approval" ||
    slice?.merge_gate === "blocked-merge-state"
  );
}

/**
 * Desired owned-label state for one open PR. `slice` is the slice linked to the
 * PR, if any. `needsHuman` is `"skip"` for Dependabot PRs: dependency-merge owns
 * that label there, so the reconciler neither adds nor removes it.
 */
export function desiredLabels(pr: LabelPr, slice?: any): { opened: boolean; needsHuman: boolean | "skip" } {
  const linked = slice !== undefined && slice !== null;
  const opened = linked || (!isDependabotAuthor(pr) && isMarchBranch(pr.headRefName));
  const needsHuman: boolean | "skip" = isDependabotAuthor(pr) ? "skip" : linked ? sliceNeedsHuman(slice) : false;
  return { opened, needsHuman };
}

/**
 * Diff of owned labels for every open PR. `slicesByPr` maps PR number → the
 * slice linked to it. Only PRs with a change are returned.
 */
export function labelDiff(
  prs: LabelPr[],
  slicesByPr: Map<number, { sliceId: string; slice: any }> | Record<number, { sliceId: string; slice: any }>,
): LabelDiffEntry[] {
  const lookup = (n: number) => (slicesByPr instanceof Map ? slicesByPr.get(n) : slicesByPr[n]);
  const out: LabelDiffEntry[] = [];
  for (const pr of prs) {
    const linked = lookup(pr.number);
    const want = desiredLabels(pr, linked?.slice);
    const have = new Set((pr.labels ?? []).map((l) => String(l?.name ?? "")));
    const add: string[] = [];
    const remove: string[] = [];
    const reconcile = (label: string, desired: boolean) => {
      if (desired && !have.has(label)) add.push(label);
      else if (!desired && have.has(label)) remove.push(label);
    };
    reconcile(OPENED_LABEL, want.opened);
    if (want.needsHuman !== "skip") reconcile(NEEDS_HUMAN_LABEL, want.needsHuman);
    if (add.length || remove.length) out.push({ pr: pr.number, ...(linked ? { sliceId: linked.sliceId } : {}), add, remove });
  }
  return out;
}
