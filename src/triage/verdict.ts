import { emitTriageValidationFailure } from "../observability/triage-trace.js";

export const TRIAGE_SCHEMA_VERSION = 1;
export const TRIAGE_RUBRIC_REVISION = "baseline-1";

const BUILD_OUTCOMES = ["spark", "ignite", "render", "mark", "strike"] as const;
export const TRIAGE_OUTCOMES = [...BUILD_OUTCOMES, "needs-definition", "controversial", "close"] as const;
export const TRIAGE_CONFIDENCES = ["high", "medium", "low"] as const;
const GRADES = ["minor-gaps", "major-gaps", "insufficient"] as const;

export type BuildOutcome = typeof BUILD_OUTCOMES[number];
type Outcome = typeof TRIAGE_OUTCOMES[number];

export type TriageVerdictV1 = {
  readonly schemaVersion: typeof TRIAGE_SCHEMA_VERSION;
  readonly confidence: typeof TRIAGE_CONFIDENCES[number];
  readonly rationale: string;
} & (
  | {
      readonly outcome: "needs-definition";
      readonly needsDefinition: {
        readonly grade: typeof GRADES[number];
        readonly explanation: string;
      };
    }
  | {
      readonly outcome: Exclude<Outcome, "needs-definition">;
      readonly needsDefinition?: never;
    }
);

type Diagnostic = {
  readonly field: string;
  readonly code: "invalid-json" | "duplicate-key" | "unknown-field" |
    "unsupported-version" | "missing-field" | "invalid-value";
};

export type VerdictValidation =
  | { readonly ok: true; readonly verdict: TriageVerdictV1 }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

class InvalidVerdict extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}

function reject(field: string, code: Diagnostic["code"]): never {
  throw new InvalidVerdict({ field, code });
}

function endOfString(raw: string, start: number): number {
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === '"') return index + 1;
    if (raw[index] === "\\") index++;
  }
  reject("$", "invalid-json");
}

function parseCandidate(raw: string): unknown {
  // Consume whole strings so punctuation inside a string never changes scope.
  // In valid JSON, a string followed by a colon is always an object member key.
  // JSON.parse remains responsible for checking the full grammar.
  const objects: Set<string>[] = [];
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (token === "{") {
      objects.push(new Set());
    } else if (token === "}") {
      objects.pop();
    } else if (token === '"') {
      const end = endOfString(raw, index);
      let next = end;
      while (next < raw.length && " \t\r\n".includes(raw[next])) next++;
      const keys = objects.at(-1);
      if (raw[next] === ":" && keys) {
        const key: string = JSON.parse(raw.slice(index, end));
        if (keys.has(key)) reject("$", "duplicate-key");
        keys.add(key);
      }
      index = end - 1;
    }
  }
  return JSON.parse(raw);
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(field, "invalid-value");
  }
  return value as Record<string, unknown>;
}

function exactFields(object: Record<string, unknown>, fields: readonly string[], path: string): void {
  for (const field of fields) {
    if (!Object.hasOwn(object, field)) reject(`${path}.${field}`, "missing-field");
  }
  if (Object.keys(object).length !== fields.length) reject(path, "unknown-field");
}

function isMember<T extends string>(choices: readonly T[], value: unknown): value is T {
  return choices.some((choice) => choice === value);
}

function nonblank(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) reject(field, "invalid-value");
  return value;
}

function readVerdict(raw: string): TriageVerdictV1 {
  const candidate = readObject(parseCandidate(raw), "$");
  const { schemaVersion, outcome, confidence } = candidate;
  const fields = ["schemaVersion", "outcome", "confidence", "rationale"];
  if (outcome === "needs-definition") fields.push("needsDefinition");
  exactFields(candidate, fields, "$");

  if (schemaVersion !== TRIAGE_SCHEMA_VERSION) reject("$.schemaVersion", "unsupported-version");
  if (!isMember(TRIAGE_OUTCOMES, outcome)) reject("$.outcome", "invalid-value");
  if (!isMember(TRIAGE_CONFIDENCES, confidence)) reject("$.confidence", "invalid-value");
  const rationale = nonblank(candidate.rationale, "$.rationale");
  const base = { schemaVersion, confidence, rationale } as const;

  if (outcome !== "needs-definition") return { ...base, outcome };

  const details = readObject(candidate.needsDefinition, "$.needsDefinition");
  exactFields(details, ["grade", "explanation"], "$.needsDefinition");
  const { grade } = details;
  if (!isMember(GRADES, grade)) reject("$.needsDefinition.grade", "invalid-value");
  const explanation = nonblank(details.explanation, "$.needsDefinition.explanation");
  return { ...base, outcome, needsDefinition: { grade, explanation } };
}

export function validateTriageVerdict(raw: string): VerdictValidation {
  try {
    return { ok: true, verdict: readVerdict(raw) };
  } catch (error) {
    if (!(error instanceof InvalidVerdict || error instanceof SyntaxError)) throw error;
    const diagnostic: Diagnostic = error instanceof InvalidVerdict
      ? error.diagnostic
      : { field: "$", code: "invalid-json" };
    emitTriageValidationFailure(diagnostic.code);
    return { ok: false, diagnostic };
  }
}

export function isBuildOutcome(outcome: TriageVerdictV1["outcome"]): outcome is BuildOutcome {
  return isMember(BUILD_OUTCOMES, outcome);
}

/** Resolve the recommended Smithy entry point for a validated verdict. */
export function resolveTriageDestination(verdict: TriageVerdictV1): `smithy.${BuildOutcome}` | undefined {
  return isBuildOutcome(verdict.outcome) ? `smithy.${verdict.outcome}` : undefined;
}
