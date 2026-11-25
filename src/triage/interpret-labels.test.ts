/** @l0 @deterministic @ci */
import { describe, expect, it } from "vitest";
import { interpretTriageLabels, type TriageHistory, type TriageIssueSnapshot } from "./interpret-labels.js";
import { hashTriageContent, TRIAGE_LABEL_CATALOG, TRIAGE_LABELS } from "./labels.js";

const { state, outcome, confidence, signal } = TRIAGE_LABELS;
const original: TriageIssueSnapshot = {
  open: true,
  labels: [state.triaged, outcome.mark, confidence.high],
  contentHash: hashTriageContent("Issue", "Body"),
};
const edited = { ...original, contentHash: hashTriageContent("Issue", "New body") };
const closed = { ...original, open: false };
const accepted = withLabels(original, signal.accepted);
const verdict = { contentHash: original.contentHash, verdict: { outcome: "mark", confidence: "high" } } as const;

function withLabels(snapshot: TriageIssueSnapshot, ...labels: string[]): TriageIssueSnapshot {
  return { ...snapshot, labels: [...snapshot.labels, ...labels] };
}

function history(baseline: TriageIssueSnapshot, ...snapshots: TriageIssueSnapshot[]): TriageHistory {
  return { baseline, complete: true, changes: snapshots.map((snapshot, index) => ({ id: String(index + 1), snapshot })) };
}

describe("triage label interpretation", () => {
  it("maps the contract vocabulary exactly and keeps signals separate", () => {
    expect(TRIAGE_LABEL_CATALOG).toEqual([
      "triage:untriaged", "triage:triaged", "triage:errored", "triage:spark", "triage:ignite",
      "triage:render", "triage:mark", "triage:strike", "triage:needs-definition", "triage:controversial",
      "triage:close", "triage:confidence-high", "triage:confidence-medium", "triage:confidence-low",
      "triage:accepted", "triage:resubmit",
    ]);
    expect(signal).toEqual({ accepted: "triage:accepted", resubmit: "triage:resubmit" });
  });

  it("hashes ordered text with distinct field boundaries and normalizes an absent body", () => {
    expect(hashTriageContent("a")).toBe(hashTriageContent("a", ""));
    expect(hashTriageContent("a", null)).toBe(hashTriageContent("a"));
    expect(hashTriageContent("ab", "c")).not.toBe(hashTriageContent("a", "bc"));
    expect(hashTriageContent("a", "b")).not.toBe(hashTriageContent("b", "a"));
  });

  it.each([
    [[], "untriaged"],
    [[state.untriaged], "untriaged"],
    [[state.errored], "errored"],
    [[state.triaged], "triaged"],
    [[state.triaged, state.errored], "unresolved"],
    [[outcome.mark, outcome.close], "unresolved"],
    [[confidence.high, confidence.low], "unresolved"],
  ])("decodes live state for %j while the mirror lags", (labels, expected) => {
    expect(interpretTriageLabels({ ...original, labels }, history(original)).state).toBe(expected);
  });

  it("protects live removals, conflicts, and replacements as whole groups", () => {
    const live = { ...original, labels: [state.errored, outcome.mark, outcome.close] };
    expect(interpretTriageLabels(live, history(original), { baseline: verdict })).toMatchObject({
      state: "unresolved", protectedGroups: ["state", "outcome", "confidence"], overrideStatus: "resolved",
    });
  });

  it("protects an override already visible at the verdict baseline", () => {
    const live = { ...original, labels: [state.triaged, outcome.mark] };
    expect(interpretTriageLabels(live, history(live), { baseline: verdict }).protectedGroups)
      .toEqual(["confidence"]);
  });

  it("preserves same-content groups across reopen, resubmit, and a newer verdict", () => {
    const removed = { ...original, labels: [state.triaged] };
    const reopened = withLabels(removed, signal.resubmit);
    const writer = withLabels(reopened, confidence.low);
    expect(interpretTriageLabels(writer, history(original, removed, { ...removed, open: false }, reopened, writer), {
      baseline: verdict,
      writes: new Map([["4", { ...verdict, verdict: { outcome: "strike", confidence: "low" } }]]),
    }).protectedGroups).toEqual(["outcome", "confidence"]);
  });

  it("uses written values as evidence only for groups matched at the linked observation", () => {
    const live = { ...original, labels: [state.triaged, outcome.strike, confidence.low] };
    const record = { ...verdict, verdict: { outcome: "strike", confidence: "medium" } } as const;
    expect(interpretTriageLabels(live, history(original, live), {
      baseline: verdict, writes: new Map([["1", record]]),
    }).protectedGroups).toEqual(["confidence"]);
    expect(interpretTriageLabels(live, history(original, live))).toMatchObject({
      protectedGroups: ["outcome", "confidence"], overrideStatus: "unresolved",
    });
  });

  it("retires overrides even when content later returns to its original hash", () => {
    const removed = { ...original, labels: [state.triaged, outcome.mark] };
    const editedWithoutConfidence = { ...removed, contentHash: edited.contentHash };
    expect(interpretTriageLabels(removed, history(original, removed, editedWithoutConfidence, removed), {
      baseline: verdict,
    })).toMatchObject({ protectedGroups: [], overrideStatus: "resolved" });
    expect(interpretTriageLabels(editedWithoutConfidence, history(original, removed), {
      baseline: verdict,
    })).toMatchObject({ protectedGroups: [], overrideStatus: "unresolved" });
  });
});

describe("re-entry", () => {
  it.each([
    ["content-changed", original, edited],
    ["reopened", closed, original],
    ["resubmit-added", original, withLabels(original, signal.resubmit)],
  ])("qualifies %s once, including on an automated issue", (trigger, before, after) => {
    const live = withLabels(after, "automated");
    const observed = history(withLabels(before, "automated"), live);
    expect(interpretTriageLabels(live, observed).reentry)
      .toEqual({ status: "qualified", trigger, changeId: "1" });
    expect(interpretTriageLabels(live, { ...observed, handledChangeIds: new Set(["1"]) }).reentry)
      .toEqual({ status: "notQualified" });
  });

  it("reports one trigger for co-occurring changes and consumes the entire observation", () => {
    const live = withLabels(edited, signal.resubmit);
    const observed = history(closed, live);
    expect(interpretTriageLabels(live, observed).reentry)
      .toEqual({ status: "qualified", trigger: "content-changed", changeId: "1" });
    expect(interpretTriageLabels(live, { ...observed, handledChangeIds: new Set(["1"]) }).reentry)
      .toEqual({ status: "notQualified" });
  });

  it("requires a new resubmit addition and ignores persistent labels", () => {
    const live = withLabels(original, signal.resubmit);
    expect(interpretTriageLabels(live, history(live, live)).reentry).toEqual({ status: "notQualified" });
    expect(interpretTriageLabels(live, {
      ...history(original, live, original, live), handledChangeIds: new Set(["1"]),
    }).reentry).toEqual({ status: "qualified", trigger: "resubmit-added", changeId: "3" });
  });

  it.each(["comment", "timestamp", "rubric revision", "March note write"])("ignores %s activity", () => {
    expect(interpretTriageLabels(original, history(original, original)).reentry)
      .toEqual({ status: "notQualified" });
  });

  it("ignores March label writes and transitions ending on a closed issue", () => {
    const writer = { ...original, labels: [state.triaged, outcome.strike, confidence.medium] };
    expect(interpretTriageLabels(writer, history(original, writer)).reentry).toEqual({ status: "notQualified" });
    const live = withLabels({ ...edited, open: false }, signal.resubmit);
    expect(interpretTriageLabels(live, history(original, live)).reentry).toEqual({ status: "notQualified" });
  });

  it("defers on incomplete history and does not invent an edge from live drift", () => {
    expect(interpretTriageLabels(edited, { ...history(original, edited), complete: false }).reentry)
      .toEqual({ status: "unresolved" });
    expect(interpretTriageLabels(edited, history(original)).reentry).toEqual({ status: "unresolved" });
  });
});

describe("explicit acceptance", () => {
  it.each(["spark", "ignite", "render", "mark", "strike"] as const)("authorizes a verified %s addition", (value) => {
    const before = { ...original, labels: [state.triaged, outcome[value], confidence.low] };
    const live = withLabels(before, signal.accepted);
    expect(interpretTriageLabels(live, history(before, live))).toMatchObject({
      intakeAuthorized: true, acceptance: { outcome: value, contentHash: live.contentHash, additionId: "1" },
    });
  });

  it.each([
    [outcome["needs-definition"], state.triaged, confidence.high],
    [outcome.controversial, state.triaged, confidence.high],
    [outcome.close, state.triaged, confidence.high],
    [confidence.high],
    [outcome.mark, state.triaged],
    [outcome.mark, confidence.high],
    [outcome.mark, state.errored, confidence.high],
    [outcome.mark, state.triaged, state.errored, confidence.high],
    [outcome.mark, outcome.strike, state.triaged, confidence.high],
    [outcome.mark, state.triaged, confidence.high, confidence.medium],
  ].map((labels) => ({ labels })))("denies acceptance of an ineligible recommendation with $labels", ({ labels }) => {
    const before = { ...original, labels };
    const live = withLabels(before, signal.accepted);
    expect(interpretTriageLabels(live, history(before, live)).intakeAuthorized).toBe(false);
  });

  it("denies absent, unobserved, ambiguous, incomplete, and closed acceptance", () => {
    expect(interpretTriageLabels(original, history(original)).intakeAuthorized).toBe(false);
    expect(interpretTriageLabels(accepted, history(accepted)).intakeAuthorized).toBe(false);
    expect(interpretTriageLabels(accepted, history(edited, accepted)).intakeAuthorized).toBe(false);
    expect(interpretTriageLabels(accepted, history({ ...original, labels: [] }, accepted)).intakeAuthorized).toBe(false);
    expect(interpretTriageLabels(accepted, { ...history(original, accepted), complete: false }).intakeAuthorized).toBe(false);
    const live = { ...accepted, open: false };
    expect(interpretTriageLabels(live, history(original, accepted, live)).intakeAuthorized).toBe(false);
  });

  it("invalidates acceptance across content, outcome, confidence, or state changes and reversals", () => {
    const invalidations = [
      { ...accepted, contentHash: edited.contentHash },
      { ...accepted, labels: [state.triaged, outcome.strike, confidence.high, signal.accepted] },
      { ...accepted, labels: [state.triaged, outcome.mark, confidence.low, signal.accepted] },
      { ...accepted, labels: [state.errored, outcome.mark, confidence.high, signal.accepted] },
    ];
    for (const changed of invalidations) {
      expect(interpretTriageLabels(changed, history(original, accepted, changed)).intakeAuthorized).toBe(false);
      expect(interpretTriageLabels(accepted, history(original, accepted, changed, accepted)).intakeAuthorized).toBe(false);
    }
  });

  it("invalidates a removed signal even with mirror lag and verifies each later addition independently", () => {
    expect(interpretTriageLabels(original, history(original, accepted)).intakeAuthorized).toBe(false);
    expect(interpretTriageLabels(original, history(original, accepted, original)).intakeAuthorized).toBe(false);
    expect(interpretTriageLabels(accepted, history(original, accepted, original, accepted))).toMatchObject({
      intakeAuthorized: true, acceptance: { additionId: "3" },
    });
  });
});
