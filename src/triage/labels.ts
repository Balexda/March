import { TRIAGE_CONFIDENCES, TRIAGE_OUTCOMES } from "./verdict.js";

export const TRIAGE_LABEL_CATALOG = [
  ...(["untriaged", "triaged", "errored"] as const).map(value => ({
    group: "state" as const, value, name: `triage:${value}` as const, owner: "triage" as const,
  })),
  ...TRIAGE_OUTCOMES.map(value => ({
    group: "outcome" as const, value, name: `triage:${value}` as const, owner: "triage" as const,
  })),
  ...TRIAGE_CONFIDENCES.map(value => ({
    group: "confidence" as const, value, name: `triage:confidence-${value}` as const, owner: "triage" as const,
  })),
  { group: "signal", value: "accepted", name: "triage:accepted", owner: "operator" },
  { group: "signal", value: "resubmit", name: "triage:resubmit", owner: "operator" },
] as const;
