import { emitTriageNoteSelectionFailure } from "../observability/triage-trace.js";
import { parseJsonWithUniqueKeys, validateTriageVerdict, type TriageVerdictV1 } from "./verdict.js";

const MARKER_PREFIX = /<!--[ \t\r\n]*march-triage-note/g;
// The marker must stand on its own line and terminate the comment (trailing
// whitespace aside); a marker followed by more text is malformed.
const V1_MARKER = /(?:^|\n)<!-- march-triage-note:v1 ([A-Za-z0-9+/]+={0,2}) -->\s*$/;
const GRADE_LABELS = {
  "minor-gaps": "Minor gaps",
  "major-gaps": "Major gaps",
  insufficient: "More definition needed",
} as const;

export interface TriageNoteEvaluation {
  readonly rubricVersion: string;
  readonly issueContentHash: string;
  readonly originalVerdict: TriageVerdictV1;
  readonly repositoryContext: readonly string[];
}

export interface TriageIssueComment {
  readonly id: number;
  readonly authorId: number | null;
  readonly body: string;
}

type SelectionFailure = "invalid-marker" | "multiple-candidates";

export type TriageNoteSelection =
  | { readonly kind: "create"; readonly body: string }
  | { readonly kind: "replace"; readonly commentId: number; readonly body: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failure"; readonly reason: SelectionFailure };

function markdownText(text: string): string {
  // Encode Markdown syntax and keep references inside code tags so GitHub's
  // mention and reference processors leave them alone after entity decoding.
  return text.trim().split(/\s+/).map((word) => {
    const escaped = word.replace(/[!-/:-@\[-`{-~]/g, (character) =>
      `&#${character.charCodeAt(0)};`);
    return /[@#]|:\/\/|^www\./i.test(word) ? `<code>${escaped}</code>` : escaped;
  }).join(" ");
}

export function renderTriageNote(evaluation: TriageNoteEvaluation): string {
  const { rubricVersion, issueContentHash, originalVerdict, repositoryContext } = evaluation;
  const { outcome, confidence, rationale, needsDefinition } = originalVerdict;
  const sections = [
    `**Recommended outcome:** ${outcome}\n\n**Confidence:** ${confidence}`,
    markdownText(rationale),
  ];
  if (needsDefinition) {
    sections.push(`**${GRADE_LABELS[needsDefinition.grade]}**\n\n${markdownText(needsDefinition.explanation)}`);
  }
  if (repositoryContext.length) {
    sections.push(`**Repository context**\n\n${repositoryContext.map((entry) => `- ${markdownText(entry)}`).join("\n")}`);
  }

  const payload = Buffer.from(JSON.stringify({
    rubricVersion, issueContentHash, originalVerdict, repositoryContext,
  }), "utf8").toString("base64");
  sections.push(`<!-- march-triage-note:v1 ${payload} -->`);
  return sections.join("\n\n");
}

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidMarker(body: string): boolean {
  const encoded = V1_MARKER.exec(body)?.[1];
  if (!encoded || Array.from(body.matchAll(MARKER_PREFIX)).length !== 1) return false;

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return false;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
  // Reject repeated keys anywhere in the payload: JSON.parse would keep only the
  // last value, letting a conflicting verdict pass re-validation.
  const parsed = parseJsonWithUniqueKeys(text);
  if (!parsed.ok) return false;
  const payload = parsed.value;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const { rubricVersion, issueContentHash, originalVerdict, repositoryContext } =
    payload as Record<string, unknown>;
  return Object.keys(payload).length === 4
    && isNonblank(rubricVersion)
    && isNonblank(issueContentHash)
    && Array.isArray(repositoryContext)
    && repositoryContext.every(isNonblank)
    && originalVerdict !== undefined
    && validateTriageVerdict(JSON.stringify(originalVerdict)).ok;
}

function selectionFailure(reason: SelectionFailure): TriageNoteSelection {
  emitTriageNoteSelectionFailure(reason);
  return { kind: "failure", reason };
}

export function selectTriageNote(
  comments: readonly TriageIssueComment[],
  writerId: number,
  proposedBody: string,
): TriageNoteSelection {
  const candidates = comments.filter((comment) =>
    comment.authorId === writerId && comment.body.search(MARKER_PREFIX) !== -1);
  if (candidates.length > 1) return selectionFailure("multiple-candidates");
  const existing = candidates[0];
  if (!existing) return { kind: "create", body: proposedBody };
  if (!hasValidMarker(existing.body)) return selectionFailure("invalid-marker");
  if (existing.body === proposedBody) return { kind: "unchanged" };
  return { kind: "replace", commentId: existing.id, body: proposedBody };
}
