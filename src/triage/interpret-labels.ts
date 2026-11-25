import { TRIAGE_LABELS, TRIAGE_LABEL_CATALOG } from "./labels.js";
import { isBuildOutcome, TRIAGE_OUTCOMES, type BuildOutcome, type TriageVerdictV1 } from "./verdict.js";

const MANAGED_GROUPS = ["state", "outcome", "confidence"] as const;
type ManagedGroup = typeof MANAGED_GROUPS[number];
type State = keyof typeof TRIAGE_LABELS.state;
type Recommendation = Pick<TriageVerdictV1, "outcome" | "confidence">;

export interface TriageIssueSnapshot {
  readonly open: boolean;
  readonly contentHash: string;
  readonly labels: readonly string[];
}

export interface TriageObservation {
  readonly id: string;
  readonly snapshot: TriageIssueSnapshot;
}

export interface TriageHistory {
  readonly baseline: TriageIssueSnapshot;
  /** Distinct observations, in chronological order after the baseline. */
  readonly changes: readonly TriageObservation[];
  readonly complete: boolean;
  readonly handledChangeIds?: ReadonlySet<string>;
}

interface RecordedVerdict {
  readonly contentHash: string;
  readonly verdict: Recommendation;
}

export interface TriageVerdictProvenance {
  /** Verdict in effect at the history baseline, if known. */
  readonly baseline?: RecordedVerdict;
  /** Only link writes whose observation identity is known independently of the actor. */
  readonly writes?: ReadonlyMap<string, RecordedVerdict>;
}

type ReentryTrigger = "content-changed" | "reopened" | "resubmit-added";
type Reentry =
  | { readonly status: "notQualified" | "unresolved" }
  | { readonly status: "qualified"; readonly trigger: ReentryTrigger; readonly changeId: string };

interface AcceptanceEvidence {
  readonly outcome: BuildOutcome;
  readonly contentHash: string;
  readonly additionId: string;
}

export type TriageInterpretation = {
  readonly state: State | "unresolved";
  readonly protectedGroups: readonly ManagedGroup[];
  readonly overrideStatus: "resolved" | "unresolved";
  readonly reentry: Reentry;
} & (
  | { readonly intakeAuthorized: false }
  | { readonly intakeAuthorized: true; readonly acceptance: AcceptanceEvidence }
);

function groupLabels(snapshot: TriageIssueSnapshot, group: ManagedGroup): string[] {
  const labels: readonly string[] = Object.values(TRIAGE_LABELS[group]);
  return labels.filter((label) => snapshot.labels.includes(label));
}

function groupChanged(before: TriageIssueSnapshot, after: TriageIssueSnapshot, group: ManagedGroup): boolean {
  return Object.values(TRIAGE_LABELS[group])
    .some((label) => before.labels.includes(label) !== after.labels.includes(label));
}

function matchesVerdict(snapshot: TriageIssueSnapshot, record: RecordedVerdict, group: ManagedGroup): boolean {
  if (record.contentHash !== snapshot.contentHash) return false;
  const expected = {
    state: TRIAGE_LABELS.state.triaged,
    outcome: TRIAGE_LABELS.outcome[record.verdict.outcome],
    confidence: TRIAGE_LABELS.confidence[record.verdict.confidence],
  }[group];
  const labels = groupLabels(snapshot, group);
  return labels.length === 1 && labels[0] === expected;
}

function decodeState(snapshot: TriageIssueSnapshot): TriageInterpretation["state"] {
  if (MANAGED_GROUPS.some((group) => groupLabels(snapshot, group).length > 1)) return "unresolved";
  return (Object.keys(TRIAGE_LABELS.state) as State[])
    .find((state) => snapshot.labels.includes(TRIAGE_LABELS.state[state])) ?? "untriaged";
}

function buildOutcome(snapshot: TriageIssueSnapshot): BuildOutcome | undefined {
  if (decodeState(snapshot) !== "triaged" || groupLabels(snapshot, "confidence").length !== 1) return;
  const outcome = TRIAGE_OUTCOMES.find((value) => snapshot.labels.includes(TRIAGE_LABELS.outcome[value]));
  if (outcome && isBuildOutcome(outcome)) return outcome;
}

function reentryTrigger(before: TriageIssueSnapshot, after: TriageIssueSnapshot): ReentryTrigger | undefined {
  if (before.contentHash !== after.contentHash) return "content-changed";
  if (!before.open) return "reopened";
  const { resubmit } = TRIAGE_LABELS.signal;
  if (!before.labels.includes(resubmit) && after.labels.includes(resubmit)) return "resubmit-added";
}

export function interpretTriageLabels(
  issue: TriageIssueSnapshot,
  history: TriageHistory,
  provenance?: TriageVerdictProvenance,
): TriageInterpretation {
  const { accepted } = TRIAGE_LABELS.signal;
  const protectedGroups = new Set<ManagedGroup>();
  let previous = history.baseline;
  const baselineVerdict = provenance?.baseline;
  let overrideAnchored = baselineVerdict?.contentHash === previous.contentHash;
  if (baselineVerdict && overrideAnchored) {
    for (const group of MANAGED_GROUPS) {
      if (!matchesVerdict(previous, baselineVerdict, group)) protectedGroups.add(group);
    }
  }

  let reentry: Reentry = { status: "notQualified" };
  let acceptance: AcceptanceEvidence | undefined;
  for (const { id, snapshot } of history.changes) {
    const contentChanged = previous.contentHash !== snapshot.contentHash;
    if (contentChanged) {
      protectedGroups.clear();
      overrideAnchored = true;
    } else {
      const writer = provenance?.writes?.get(id);
      for (const group of MANAGED_GROUPS) {
        if (groupChanged(previous, snapshot, group) && !(writer && matchesVerdict(snapshot, writer, group))) {
          protectedGroups.add(group);
        }
      }
    }

    if (!snapshot.open) {
      reentry = { status: "notQualified" };
    } else if (!history.handledChangeIds?.has(id)) {
      const trigger = reentryTrigger(previous, snapshot);
      if (trigger) reentry = { status: "qualified", trigger, changeId: id };
    }

    const recommendationChanged = contentChanged ||
      MANAGED_GROUPS.some((group) => groupChanged(previous, snapshot, group));
    if (recommendationChanged || !snapshot.labels.includes(accepted)) {
      acceptance = undefined;
    } else if (!previous.labels.includes(accepted)) {
      const outcome = buildOutcome(snapshot);
      if (outcome) acceptance = { outcome, contentHash: snapshot.contentHash, additionId: id };
    }
    previous = snapshot;
  }

  // The live snapshot wins for labels, but a lagging mirror cannot establish an unseen edge.
  const currentHistory = history.complete && previous.open === issue.open &&
    previous.contentHash === issue.contentHash &&
    TRIAGE_LABEL_CATALOG.every((label) => previous.labels.includes(label) === issue.labels.includes(label));
  if (previous.contentHash !== issue.contentHash) {
    protectedGroups.clear();
  } else {
    for (const group of MANAGED_GROUPS) {
      if (groupChanged(previous, issue, group)) protectedGroups.add(group);
    }
  }

  const result = {
    state: decodeState(issue),
    protectedGroups: MANAGED_GROUPS.filter((group) => protectedGroups.has(group)),
    overrideStatus: history.complete && overrideAnchored && previous.contentHash === issue.contentHash
      ? "resolved" : "unresolved",
    reentry: currentHistory ? reentry : { status: "unresolved" } as const,
  } as const;
  return currentHistory && issue.open && acceptance
    ? { ...result, intakeAuthorized: true, acceptance }
    : { ...result, intakeAuthorized: false };
}
