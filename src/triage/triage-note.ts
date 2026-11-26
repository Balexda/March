import { emitTriageNoteReadFailure } from "../observability/triage-trace.js";
import type { TriageIssueComment, TriageNoteEvaluation } from "./note.js";
import { parseJsonWithUniqueKeys, validateTriageVerdict } from "./verdict.js";

/** The evaluation recovered from a note marker; same shape the renderer encodes. */
export type TriageNoteProvenance = TriageNoteEvaluation;

type MarkerFailure = "malformed-marker" | "unsupported-version" | "invalid-payload";
type NoteFailure = MarkerFailure | "multiple-markers" | "multiple-candidates";
type Failure<Code extends NoteFailure> = { readonly ok: false; readonly code: Code };

type MarkerRead =
  | { readonly ok: true; readonly provenance: TriageNoteProvenance }
  | Failure<MarkerFailure>;

export type TriageNoteRead =
  | { readonly ok: true; readonly kind: "absent" }
  | { readonly ok: true; readonly kind: "found"; readonly commentId: number; readonly provenance: TriageNoteProvenance }
  | Failure<NoteFailure>;

const RESERVED_PREFIX = /<!--[ \t\r\n]*march-triage-note/g;
const MARKER_LINE = /^<!-- march-triage-note:([^\s]+) ([A-Za-z0-9+/=]+) -->$/;
const PAYLOAD_FIELDS = ["rubricVersion", "issueContentHash", "originalVerdict", "repositoryContext"] as const;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail<Code extends NoteFailure>(code: Code): Failure<Code> {
  emitTriageNoteReadFailure(code);
  return { ok: false, code };
}

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readProvenance(value: unknown): TriageNoteProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).length !== PAYLOAD_FIELDS.length ||
      !PAYLOAD_FIELDS.every((field) => Object.hasOwn(value, field))) return undefined;

  const { rubricVersion, issueContentHash, originalVerdict, repositoryContext } =
    value as Record<typeof PAYLOAD_FIELDS[number], unknown>;
  if (!isNonblank(rubricVersion) || !isNonblank(issueContentHash) ||
      !Array.isArray(repositoryContext) || !Array.from(repositoryContext).every(isNonblank) ||
      originalVerdict === undefined) return undefined;

  const validated = validateTriageVerdict(JSON.stringify(originalVerdict));
  if (!validated.ok) return undefined;
  return { rubricVersion, issueContentHash, originalVerdict: validated.verdict, repositoryContext };
}

/** Encode one standalone marker line using canonical payload field order. */
export function encodeTriageNoteMarker(provenance: TriageNoteProvenance): string {
  const validated = readProvenance(provenance);
  if (!validated) throw new TypeError("Invalid triage note provenance");
  const encoded = Buffer.from(JSON.stringify(validated), "utf8").toString("base64");
  return `<!-- march-triage-note:v1 ${encoded} -->`;
}

export function decodeTriageNoteMarker(marker: string): MarkerRead {
  const match = MARKER_LINE.exec(marker);
  if (!match || match[0] !== marker) return fail("malformed-marker");
  const [, version, encoded] = match;
  if (version !== "v1") return fail("unsupported-version");

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return fail("invalid-payload");

  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return fail("invalid-payload");
  }
  const parsed = parseJsonWithUniqueKeys(text);
  if (!parsed.ok) return fail("invalid-payload");
  const provenance = readProvenance(parsed.value);
  return provenance ? { ok: true, provenance } : fail("invalid-payload");
}

/** Recover provenance from the complete comment set using a trusted author ID. */
export function readTriageNote(comments: readonly TriageIssueComment[], writerId: number): TriageNoteRead {
  let candidate: { comment: TriageIssueComment; markerCount: number } | undefined;
  for (const comment of comments) {
    if (comment.authorId !== writerId) continue;
    const markers = comment.body.match(RESERVED_PREFIX);
    if (!markers) continue;
    if (candidate) return fail("multiple-candidates");
    candidate = { comment, markerCount: markers.length };
  }

  if (!candidate) return { ok: true, kind: "absent" };
  if (candidate.markerCount > 1) return fail("multiple-markers");

  const { body, id: commentId } = candidate.comment;
  const end = body.trimEnd();
  const marker = end.slice(end.lastIndexOf("\n") + 1);
  const decoded = decodeTriageNoteMarker(marker);
  if (!decoded.ok) return decoded;
  return { ok: true, kind: "found", commentId, provenance: decoded.provenance };
}
