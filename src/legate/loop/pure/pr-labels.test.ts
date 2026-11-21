/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  desiredLabels,
  labelDiff,
  LABEL_SPECS,
  NEEDS_HUMAN_LABEL,
  OPENED_LABEL,
  OWNED_LABELS,
  type LabelPr,
} from "./pr-labels.js";

const pr = (over: Partial<LabelPr> = {}): LabelPr => ({
  number: 10,
  headRefName: "tessera/thing",
  author: { login: "JMBattista" },
  labels: [],
  ...over,
});
const link = (n: number, slice: any, sliceId = "s1") => new Map([[n, { sliceId, slice }]]);

describe("constants", () => {
  it("owns exactly the two labels, each with a spec", () => {
    expect(OWNED_LABELS).toEqual([OPENED_LABEL, NEEDS_HUMAN_LABEL]);
    expect(LABEL_SPECS[NEEDS_HUMAN_LABEL].color).toBe("d93f0b");
    for (const l of OWNED_LABELS) expect(LABEL_SPECS[l].description).toBeTruthy();
  });
});

describe("desiredLabels", () => {
  it("slice-linked PR is opened", () => {
    expect(desiredLabels(pr(), { stage: "pr-open" })).toEqual({ opened: true, needsHuman: false });
  });
  it.each(["smithy/cut/x", "feature/smithy/forge/y", "march/spawn/abc"])("branch %s is opened without a slice", (b) => {
    expect(desiredLabels(pr({ headRefName: b }))).toEqual({ opened: true, needsHuman: false });
  });
  it("foreign PR is neither", () => {
    expect(desiredLabels(pr({ headRefName: "feature/other" }))).toEqual({ opened: false, needsHuman: false });
  });
  it.each([
    ["escalated", { stage: "escalated" }],
    ["waiting-approval", { stage: "pr-open", merge_gate: "waiting-approval" }],
    ["blocked-merge-state", { stage: "pr-open", merge_gate: "blocked-merge-state" }],
  ])("needs-human on %s", (_n, slice) => {
    expect(desiredLabels(pr(), slice).needsHuman).toBe(true);
  });
  it("needs-human clears for a ready slice", () => {
    expect(desiredLabels(pr(), { stage: "pr-open", merge_gate: "ready" }).needsHuman).toBe(false);
  });
  it("dependabot: needs-human skipped; opened only when slice-linked", () => {
    const d = pr({ author: { login: "app/dependabot" }, headRefName: "dependabot/npm/x" });
    expect(desiredLabels(d)).toEqual({ opened: false, needsHuman: "skip" });
    expect(desiredLabels(d, { stage: "escalated" })).toEqual({ opened: true, needsHuman: "skip" });
  });
});

describe("labelDiff", () => {
  it("adds missing owned labels, with the slice id", () => {
    const out = labelDiff([pr()], link(10, { stage: "escalated" }));
    expect(out).toEqual([{ pr: 10, sliceId: "s1", add: [OPENED_LABEL, NEEDS_HUMAN_LABEL], remove: [] }]);
  });
  it("is empty in steady state", () => {
    const p = pr({ labels: [{ name: OPENED_LABEL }] });
    expect(labelDiff([p], link(10, { stage: "pr-open", merge_gate: "ready" }))).toEqual([]);
  });
  it("removes stale owned labels from a non-March PR", () => {
    const p = pr({ labels: [{ name: OPENED_LABEL }, { name: NEEDS_HUMAN_LABEL }] });
    expect(labelDiff([p], new Map())).toEqual([{ pr: 10, add: [], remove: [OPENED_LABEL, NEEDS_HUMAN_LABEL] }]);
  });
  it("removes needs-human from a branch-matched orphan", () => {
    const p = pr({ headRefName: "smithy/cut/x", labels: [{ name: OPENED_LABEL }, { name: NEEDS_HUMAN_LABEL }] });
    expect(labelDiff([p], new Map())).toEqual([{ pr: 10, add: [], remove: [NEEDS_HUMAN_LABEL] }]);
  });
  it("never touches foreign labels", () => {
    const p = pr({ labels: [{ name: "bug" }, { name: "area:cli" }] });
    expect(labelDiff([p], new Map())).toEqual([]);
    const q = pr({ headRefName: "smithy/x", labels: [{ name: "bug" }] });
    const all = labelDiff([q], new Map()).flatMap((e) => [...e.add, ...e.remove]);
    expect(all.every((l) => OWNED_LABELS.includes(l))).toBe(true);
  });
  it("leaves a dependabot PR's needs-human alone", () => {
    const d = pr({ author: { login: "dependabot[bot]" }, labels: [{ name: NEEDS_HUMAN_LABEL }] });
    expect(labelDiff([d], new Map())).toEqual([]);
  });
});
