import { createHash } from "node:crypto";
import { TRIAGE_CONFIDENCES, TRIAGE_OUTCOMES } from "./verdict.js";

export const TRIAGE_LABELS = {
  state: {
    untriaged: "triage:untriaged",
    triaged: "triage:triaged",
    errored: "triage:errored",
  },
  outcome: Object.fromEntries(TRIAGE_OUTCOMES.map((outcome) => [outcome, `triage:${outcome}`] as const)) as {
    readonly [Outcome in typeof TRIAGE_OUTCOMES[number]]: `triage:${Outcome}`;
  },
  confidence: Object.fromEntries(TRIAGE_CONFIDENCES.map((level) => [level, `triage:confidence-${level}`] as const)) as {
    readonly [Confidence in typeof TRIAGE_CONFIDENCES[number]]: `triage:confidence-${Confidence}`;
  },
  signal: {
    accepted: "triage:accepted",
    resubmit: "triage:resubmit",
  },
} as const;

export const TRIAGE_LABEL_CATALOG: readonly string[] = Object.values(TRIAGE_LABELS)
  .flatMap((group) => Object.values(group));

export function hashTriageContent(title: string, body?: string | null): string {
  return createHash("sha256").update(JSON.stringify([title, body ?? ""])).digest("hex");
}
