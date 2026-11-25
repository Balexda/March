/** @l0 @deterministic @ci */
import { expect, it } from "vitest";
import { TRIAGE_LABEL_CATALOG } from "./labels.js";
import { TRIAGE_CONFIDENCES, TRIAGE_OUTCOMES } from "./verdict.js";

it("defines every contract name exactly once and keeps signals operator-owned", () => {
  const names = TRIAGE_LABEL_CATALOG.map(label => label.name);
  expect(names).toEqual([
    "triage:untriaged", "triage:triaged", "triage:errored",
    "triage:spark", "triage:ignite", "triage:render", "triage:mark", "triage:strike",
    "triage:needs-definition", "triage:controversial", "triage:close",
    "triage:confidence-high", "triage:confidence-medium", "triage:confidence-low",
    "triage:accepted", "triage:resubmit",
  ]);
  expect(new Set(names).size).toBe(names.length);
  expect(TRIAGE_LABEL_CATALOG.filter(item => item.group === "outcome").map(item => item.value))
    .toEqual(TRIAGE_OUTCOMES);
  expect(TRIAGE_LABEL_CATALOG.filter(item => item.group === "confidence").map(item => item.value))
    .toEqual(TRIAGE_CONFIDENCES);
  expect(TRIAGE_LABEL_CATALOG.filter(item => item.owner === "operator").map(item => [item.group, item.value]))
    .toEqual([["signal", "accepted"], ["signal", "resubmit"]]);
});
