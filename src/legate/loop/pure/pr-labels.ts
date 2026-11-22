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
  /** Reason-comment intent: `{body}` = upsert; `"clear"` = mark resolved. */
  reason?: { body: string } | "clear";
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

/** Hidden marker identifying March's single needs-human reason comment on a PR. */
export const NEEDS_HUMAN_REASON_MARKER = "<!-- march:needs-human-reason -->";

const ESCALATED_REASONS: Record<string, string> = {
  steward_awaiting_input: "The steward is waiting on an answer from a human.",
  steward_stuck: "The steward appears stuck and needs a human to look at it.",
};

const MERGE_CODE_REASONS: Record<string, string> = {
  "not-pr-open": "The pull request is not open, so it cannot be merged.",
  "checks:not-green": "Waiting on checks: they are not all passing yet.",
  conflict: "The pull request has merge conflicts that need to be resolved.",
  "threads:owed": "Review threads are still unresolved or awaiting a reply.",
  "approval:missing": "Waiting on approval: this pull request has not been approved yet.",
  "approval:no-review-evidence":
    "Waiting on approval: the observer published no per-review evidence for this head. It may be older than the dispatcher; rebuild it or merge manually.",
  "approval:evidence-incomplete":
    "Waiting on approval: the review evidence for this head is incomplete, so approval cannot be confirmed.",
  "approval:stale-head": "Waiting on approval: the existing approval is for an older commit, not the current head.",
  "changes-requested": "A reviewer requested changes that have not been addressed.",
  "merge-state:unknown": "GitHub has not reported a merge state for this pull request yet.",
  "head-sha:missing": "March could not determine the head commit of this pull request.",
};

function codeReason(code: string): string {
  const known = MERGE_CODE_REASONS[code];
  if (known) return known;
  if (code.startsWith("merge-state:")) {
    const status = code.slice("merge-state:".length).toUpperCase();
    return `GitHub reports the merge state as ${status}, so this pull request cannot be merged automatically.`;
  }
  return `March is blocked on ${code}.`;
}

/** Codes in the order they are most actionable; unknown codes sort last. */
function relevantCode(codes: string[]): string | undefined {
  const rank = (c: string) => {
    const i = Object.keys(MERGE_CODE_REASONS).indexOf(c);
    return i === -1 ? Object.keys(MERGE_CODE_REASONS).length : i;
  };
  const approval = codes.find((c) => c.startsWith("approval:"));
  if (approval) return approval;
  return [...codes].sort((a, b) => rank(a) - rank(b))[0];
}

function failingCodes(slice: any): string[] {
  return Array.isArray(slice?.merge_failing) ? slice.merge_failing.filter((c: unknown) => typeof c === "string") : [];
}

/** One plain sentence on why March needs a human here; null when it does not. */
export function needsHumanReason(slice: any): string | null {
  if (!sliceNeedsHuman(slice)) return null;
  if (slice?.stage === "escalated") {
    const r = typeof slice?.escalated_reason === "string" ? slice.escalated_reason : "";
    if (ESCALATED_REASONS[r]) return ESCALATED_REASONS[r];
    return r
      ? `March escalated this slice (${r}) and needs a human to look at it.`
      : "March escalated this slice and needs a human to look at it.";
  }
  const codes = failingCodes(slice);
  const code = relevantCode(codes);
  if (code) return codeReason(code);
  return slice?.merge_gate === "waiting-approval"
    ? "Waiting on approval before this pull request can merge."
    : "GitHub reports a blocking merge state, so this pull request cannot be merged automatically.";
}

export function needsHumanReasonBody(slice: any): string | null {
  const reason = needsHumanReason(slice);
  if (reason === null) return null;
  const codes = failingCodes(slice);
  const lines = [NEEDS_HUMAN_REASON_MARKER, reason];
  if (codes.length) lines.push("", `Conditions: ${codes.map((c) => `\`${c}\``).join(", ")}`);
  return lines.join("\n");
}

export function resolvedReasonBody(): string {
  return `${NEEDS_HUMAN_REASON_MARKER}\nResolved: March no longer needs a human on this PR.`;
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
 * slice linked to it. Only PRs with a change (or a reason comment to reconcile) are returned.
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
    let reason: LabelDiffEntry["reason"];
    if (want.needsHuman === true) {
      const body = needsHumanReasonBody(linked?.slice);
      if (body !== null) reason = { body };
    } else if (want.needsHuman === false && have.has(NEEDS_HUMAN_LABEL)) {
      reason = "clear";
    }
    if (add.length || remove.length || reason !== undefined) {
      out.push({ pr: pr.number, ...(linked ? { sliceId: linked.sliceId } : {}), add, remove, ...(reason !== undefined ? { reason } : {}) });
    }
  }
  return out;
}
