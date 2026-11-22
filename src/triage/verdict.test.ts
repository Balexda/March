/** @l0 @deterministic @ci */
import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { getActiveOtel } from "../observability/otel.js";
import { resolveTriageDestination, validateTriageVerdict } from "./verdict.js";

vi.mock("../observability/otel.js", () => ({
  getActiveOtel: vi.fn(() => ({ enabled: false })),
}));

const base = {
  schemaVersion: 1,
  outcome: "mark",
  confidence: "high",
  rationale: "The feature needs a spec.",
};
const details = { grade: "minor-gaps", explanation: "Describe the expected behavior." };
const needsDefinition = { ...base, outcome: "needs-definition", needsDefinition: details };

describe.each(["march", "smithycli"])("shared verdict corpus for %s", () => {
  it.each([
    ["spark", "smithy.spark"],
    ["ignite", "smithy.ignite"],
    ["render", "smithy.render"],
    ["mark", "smithy.mark"],
    ["strike", "smithy.strike"],
    ["controversial", undefined],
    ["close", undefined],
  ])("resolves %s with high confidence", (outcome, destination) => {
    // Punctuation in a string must not be mistaken for nested JSON.
    const candidate = { ...base, outcome, rationale: 'Reason includes {"confidence":"low"}.' };
    const result = validateTriageVerdict(JSON.stringify(candidate));
    expect(result).toEqual({ ok: true, verdict: candidate });
    if (result.ok) expect(resolveTriageDestination(result.verdict)).toBe(destination);
  });

  it.each(["minor-gaps", "major-gaps", "insufficient"])("accepts %s at every confidence", (grade) => {
    for (const confidence of ["high", "medium", "low"]) {
      const candidate = { ...needsDefinition, confidence, needsDefinition: { ...details, grade } };
      const result = validateTriageVerdict(JSON.stringify(candidate));
      expect(result).toEqual({ ok: true, verdict: candidate });
      if (result.ok) expect(resolveTriageDestination(result.verdict)).toBeUndefined();
    }
  });

  it.each([
    ["cut fixture", '{"schemaVersion":1,"outcome":"cut","confidence":"high","rationale":"A task breakdown is needed."}', "$.outcome", "invalid-value"],
    ["forge fixture", '{"schemaVersion":1,"outcome":"forge","confidence":"high","rationale":"The implementation looks ready."}', "$.outcome", "invalid-value"],
    ["unknown outcome fixture", '{"schemaVersion":1,"outcome":"defer","confidence":"high","rationale":"The issue can wait."}', "$.outcome", "invalid-value"],
    ["missing confidence fixture", '{"schemaVersion":1,"outcome":"mark","rationale":"The feature needs a spec."}', "$.confidence", "missing-field"],
    ["multiple outcomes fixture", '{"schemaVersion":1,"outcome":["mark","strike"],"confidence":"high","rationale":"Two routes seem plausible."}', "$.outcome", "invalid-value"],
    ["empty input", "", "$", "invalid-json"],
    ["malformed JSON", '{"outcome":"mark",}', "$", "invalid-json"],
    ["unterminated string", '{"outcome":"mark', "$", "invalid-json"],
    ["multiple documents", "{} {}", "$", "invalid-json"],
    ["array", JSON.stringify([base]), "$", "invalid-value"],
    ["null", "null", "$", "invalid-value"],
    ["unsupported version", JSON.stringify({ ...base, schemaVersion: 2 }), "$.schemaVersion", "unsupported-version"],
    ["version type", JSON.stringify({ ...base, schemaVersion: "1" }), "$.schemaVersion", "unsupported-version"],
    ["missing version", JSON.stringify({ ...base, schemaVersion: undefined }), "$.schemaVersion", "missing-field"],
    ["unknown field", JSON.stringify({ ...base, rubricRevision: "baseline-1" }), "$", "unknown-field"],
    ["duplicate field", '{"schemaVersion":1,"outcome":"mark","confidence":"high","rationale":"Reason","outcome":"strike"}', "$", "duplicate-key"],
    ["escaped duplicate field", String.raw`{"schemaVersion":1,"outcome":"mark","confidence":"high","rationale":"Reason","\u006futcome":"strike"}`, "$", "duplicate-key"],
    ["deep duplicate field", '{"extra":[[{"key":0,"key":1}]]}', "$", "duplicate-key"],
    ["missing outcome", JSON.stringify({ ...base, outcome: undefined }), "$.outcome", "missing-field"],
    ["invalid confidence", JSON.stringify({ ...base, confidence: "certain" }), "$.confidence", "invalid-value"],
    ["confidence type", JSON.stringify({ ...base, confidence: 1 }), "$.confidence", "invalid-value"],
    ["missing rationale", JSON.stringify({ ...base, rationale: undefined }), "$.rationale", "missing-field"],
    ["blank rationale", JSON.stringify({ ...base, rationale: " \n\t " }), "$.rationale", "invalid-value"],
    ["rationale type", JSON.stringify({ ...base, rationale: false }), "$.rationale", "invalid-value"],
    ["forbidden details", JSON.stringify({ ...base, needsDefinition: null }), "$", "unknown-field"],
    ["missing details", JSON.stringify({ ...needsDefinition, needsDefinition: undefined }), "$.needsDefinition", "missing-field"],
    ["details type", JSON.stringify({ ...needsDefinition, needsDefinition: [] }), "$.needsDefinition", "invalid-value"],
    ["unknown detail", JSON.stringify({ ...needsDefinition, needsDefinition: { ...details, extra: true } }), "$.needsDefinition", "unknown-field"],
    ["missing grade", JSON.stringify({ ...needsDefinition, needsDefinition: { explanation: details.explanation } }), "$.needsDefinition.grade", "missing-field"],
    ["invalid grade", JSON.stringify({ ...needsDefinition, needsDefinition: { ...details, grade: "high" } }), "$.needsDefinition.grade", "invalid-value"],
    ["missing explanation", JSON.stringify({ ...needsDefinition, needsDefinition: { grade: details.grade } }), "$.needsDefinition.explanation", "missing-field"],
    ["blank explanation", JSON.stringify({ ...needsDefinition, needsDefinition: { ...details, explanation: " " } }), "$.needsDefinition.explanation", "invalid-value"],
    ["explanation type", JSON.stringify({ ...needsDefinition, needsDefinition: { ...details, explanation: 1 } }), "$.needsDefinition.explanation", "invalid-value"],
  ])("rejects %s", (_case, raw, field, code) => {
    expect(validateTriageVerdict(raw)).toEqual({ ok: false, diagnostic: { field, code } });
  });
});

it("validates long strings without exhausting the scanner stack", () => {
  const candidate = { ...base, rationale: "a".repeat(16_000_000) };
  expect(validateTriageVerdict(JSON.stringify(candidate))).toEqual({ ok: true, verdict: candidate });
});

it("emits an ended, errored span for a rejection when tracing is enabled", () => {
  const span = { setStatus: vi.fn(), end: vi.fn() };
  const startSpan = vi.fn(() => span);
  vi.mocked(getActiveOtel).mockReturnValueOnce({
    enabled: true,
    getTracer: () => ({ startSpan }),
  } as unknown as ReturnType<typeof getActiveOtel>);

  expect(validateTriageVerdict('{"private":"issue content"}').ok).toBe(false);
  expect(startSpan).toHaveBeenCalledExactlyOnceWith("triage.verdict.validate", {
    attributes: { "triage.validation.code": "missing-field" },
  });
  expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({ code: SpanStatusCode.ERROR });
  expect(span.end).toHaveBeenCalledTimes(1);
});
