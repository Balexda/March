import type { SpawnOutputEnvelope } from "./output-capture.js";

export interface CandidatePatch {
  readonly spawnId: string;
  readonly backend: string;
  readonly patchText: string;
  readonly summary?: string;
  readonly parser: "claude-code" | "codex";
}

export type BackendEnvelopeParseFailureReason =
  | "backend-unsupported"
  | "json-malformed"
  | "patch-absent"
  | "patch-ambiguous";

export interface BackendEnvelopeParseSucceeded {
  readonly ok: true;
  readonly candidate: CandidatePatch;
}

export interface BackendEnvelopeParseFailed {
  readonly ok: false;
  readonly spawnId: string;
  readonly backend: string;
  readonly failureReason: BackendEnvelopeParseFailureReason;
  readonly diagnostic: string;
}

export type BackendEnvelopeParseResult =
  | BackendEnvelopeParseSucceeded
  | BackendEnvelopeParseFailed;

type ParsedEnvelope = unknown;

const DIAGNOSTIC_TAIL_CHARS = 1_024;
const SUMMARY_LIMIT_CHARS = 2_048;
const PATCH_FIELD_NAMES = new Set([
  "patch",
  "patchText",
  "diff",
  "unifiedDiff",
]);
const SUMMARY_FIELD_NAMES = new Set(["summary", "message", "description"]);

export function parseBackendEnvelope(
  envelope: SpawnOutputEnvelope,
): BackendEnvelopeParseResult;
export function parseBackendEnvelope(
  backend: string,
  rawJson: string,
): BackendEnvelopeParseResult;
export function parseBackendEnvelope(
  envelopeOrBackend: SpawnOutputEnvelope | string,
  rawJson?: string,
): BackendEnvelopeParseResult {
  const envelope =
    typeof envelopeOrBackend === "string"
      ? {
          spawnId: "",
          backend: envelopeOrBackend,
          source: "container" as const,
          rawJson: rawJson ?? "",
          truncated: false,
          capturedAt: "",
        }
      : envelopeOrBackend;

  if (envelope.backend === "claude-code") {
    return parseWithAdapter(envelope, "claude-code", parseSingleJson);
  }
  if (envelope.backend === "codex") {
    return parseWithAdapter(envelope, "codex", parseJsonOrJsonLines);
  }
  return failed(
    envelope,
    "backend-unsupported",
    `No backend output parser is registered for backend "${envelope.backend}".`,
  );
}

function parseWithAdapter(
  envelope: SpawnOutputEnvelope,
  parser: "claude-code" | "codex",
  parse: (rawJson: string) => ParsedEnvelope,
): BackendEnvelopeParseResult {
  let parsed: ParsedEnvelope;
  try {
    parsed = parse(envelope.rawJson);
  } catch (err) {
    return failed(
      envelope,
      "json-malformed",
      boundedDiagnostic(
        `Backend "${envelope.backend}" output is not valid ${parser} JSON`,
        err,
      ),
    );
  }

  const candidates = findPatchCandidates(parsed);
  if (candidates.length === 0) {
    return failed(
      envelope,
      "patch-absent",
      `Backend "${envelope.backend}" output did not contain a candidate patch field.`,
    );
  }
  if (candidates.length > 1) {
    return failed(
      envelope,
      "patch-ambiguous",
      `Backend "${envelope.backend}" output contained ${candidates.length} candidate patch fields.`,
    );
  }

  const summary = firstSummary(parsed);
  return {
    ok: true,
    candidate: {
      spawnId: envelope.spawnId,
      backend: envelope.backend,
      patchText: candidates[0],
      ...(summary === undefined ? {} : { summary }),
      parser,
    },
  };
}

function parseSingleJson(rawJson: string): ParsedEnvelope {
  return JSON.parse(rawJson);
}

function parseJsonOrJsonLines(rawJson: string): ParsedEnvelope {
  try {
    return JSON.parse(rawJson);
  } catch (singleJsonErr) {
    const lines = rawJson
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) throw singleJsonErr;
    return lines.map((line) => JSON.parse(line));
  }
}

function findPatchCandidates(value: unknown): string[] {
  const candidates: string[] = [];
  visit(value, (key, entry) => {
    if (
      key !== undefined &&
      PATCH_FIELD_NAMES.has(key) &&
      typeof entry === "string" &&
      entry.trim().length > 0
    ) {
      candidates.push(entry);
    }
  });
  return candidates;
}

function firstSummary(value: unknown): string | undefined {
  let summary: string | undefined;
  visit(value, (key, entry) => {
    if (
      summary === undefined &&
      key !== undefined &&
      SUMMARY_FIELD_NAMES.has(key) &&
      typeof entry === "string" &&
      entry.trim().length > 0
    ) {
      summary = boundText(entry, SUMMARY_LIMIT_CHARS);
    }
  });
  return summary;
}

function visit(
  value: unknown,
  visitor: (key: string | undefined, value: unknown) => void,
  key?: string,
): void {
  visitor(key, value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    visit(entryValue, visitor, entryKey);
  }
}

function failed(
  envelope: SpawnOutputEnvelope,
  failureReason: BackendEnvelopeParseFailureReason,
  diagnostic: string,
): BackendEnvelopeParseFailed {
  return {
    ok: false,
    spawnId: envelope.spawnId,
    backend: envelope.backend,
    failureReason,
    diagnostic,
  };
}

function boundedDiagnostic(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${boundText(message.trimEnd(), DIAGNOSTIC_TAIL_CHARS)}`;
}

function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return "..." + text.slice(-(limit - 3));
}
