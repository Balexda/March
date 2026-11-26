/** @l0 @deterministic @ci */
import { describe, expect, it } from "vitest";
import {
  decodeTriageNoteMarker,
  encodeTriageNoteMarker,
  readTriageNote,
  type TriageNoteProvenance,
} from "./triage-note.js";
import { renderTriageNote } from "./note.js";

const evaluation = {
  rubricVersion: "baseline-1",
  issueContentHash: "hash-of-original-title-and-body",
  originalVerdict: { schemaVersion: 1, outcome: "mark", confidence: "high", rationale: "Add a spec." },
  repositoryContext: ["See naïve café ☕", "設計の概要 🚀"],
} satisfies TriageNoteProvenance;

function markerFor(json: string | Buffer): string {
  const bytes = typeof json === "string" ? Buffer.from(json) : json;
  const payload = bytes.toString("base64");
  return `<!-- march-triage-note:v1 ${payload} -->`;
}

describe("triage note marker", () => {
  it.each(["minor-gaps", "major-gaps", "insufficient"] as const)("round-trips grade %s", (grade) => {
    const provenance: TriageNoteProvenance = {
      ...evaluation,
      originalVerdict: {
        ...evaluation.originalVerdict,
        outcome: "needs-definition",
        needsDefinition: { explanation: "環境を教えてください。", grade },
      },
    };
    const marker = encodeTriageNoteMarker(provenance);
    expect(marker).toMatch(/^<!-- march-triage-note:v1 [A-Za-z0-9+/]+={0,2} -->$/);
    expect(decodeTriageNoteMarker(marker)).toEqual({ ok: true, provenance });
  });

  it("preserves context order and produces identical bytes for equivalent evaluations", () => {
    const { rubricVersion, issueContentHash, originalVerdict, repositoryContext } = evaluation;
    const marker = encodeTriageNoteMarker(evaluation);
    expect(encodeTriageNoteMarker({
      repositoryContext: [...repositoryContext],
      originalVerdict: {
        rationale: originalVerdict.rationale,
        confidence: originalVerdict.confidence,
        outcome: originalVerdict.outcome,
        schemaVersion: originalVerdict.schemaVersion,
      },
      issueContentHash,
      rubricVersion,
    })).toBe(marker);
    expect(decodeTriageNoteMarker(marker)).toEqual({ ok: true, provenance: evaluation });
    const empty = { ...evaluation, repositoryContext: [] };
    expect(decodeTriageNoteMarker(encodeTriageNoteMarker(empty))).toEqual({ ok: true, provenance: empty });
  });

  it.each([
    ["unsupported version", "<!-- march-triage-note:v2 e30= -->", "unsupported-version"],
    ["nonstandard Base64", "<!-- march-triage-note:v1 -_8= -->", "malformed-marker"],
    ["missing Base64 padding", "<!-- march-triage-note:v1 e30 -->", "invalid-payload"],
    ["nonzero Base64 pad bits", "<!-- march-triage-note:v1 e31= -->", "invalid-payload"],
    ["invalid UTF-8 inside otherwise valid JSON", markerFor(Buffer.concat([
      Buffer.from(JSON.stringify(evaluation).slice(0, -1).replace(/\]$/, ', "')),
      Buffer.from([0xff]),
      Buffer.from('"]}'),
    ])), "invalid-payload"],
    ["invalid JSON", markerFor("{"), "invalid-payload"],
    ["unknown payload field", markerFor(JSON.stringify({ ...evaluation, extra: true })), "invalid-payload"],
    ["blank rubric", markerFor(JSON.stringify({ ...evaluation, rubricVersion: " " })), "invalid-payload"],
    ["missing hash", markerFor(JSON.stringify({ ...evaluation, issueContentHash: undefined })), "invalid-payload"],
    ["blank context", markerFor(JSON.stringify({ ...evaluation, repositoryContext: [" "] })), "invalid-payload"],
    ["invalid verdict", markerFor(JSON.stringify({
      ...evaluation, originalVerdict: { ...evaluation.originalVerdict, outcome: "needs-definition" },
    })), "invalid-payload"],
    ["duplicate verdict key", markerFor(JSON.stringify(evaluation)
      .replace('"outcome":"mark"', '"outcome":"close","outcome":"mark"')), "invalid-payload"],
  ])("rejects %s", (_name, marker, code) => {
    expect(decodeTriageNoteMarker(marker)).toEqual({ ok: false, code });
  });
});

describe("trusted triage note", () => {
  const writerId = 123;
  const marker = encodeTriageNoteMarker(evaluation);
  const owned = { id: 42, authorId: writerId as number | null, body: `Public explanation.\n\n${marker}` };
  const lookalike = { ...owned, id: 41, authorId: 321 };

  it("ignores other authors and treats ordinary owned comments as absence", () => {
    expect(readTriageNote([
      lookalike,
      { ...owned, body: "An ordinary comment mentioning march-triage-note." },
    ], writerId)).toEqual({ ok: true, kind: "absent" });
  });

  it("recovers provenance from a note rendered by renderTriageNote", () => {
    const body = renderTriageNote(evaluation);
    expect(body.endsWith(marker)).toBe(true);
    expect(readTriageNote([{ ...owned, body }], writerId)).toEqual({
      ok: true, kind: "found", commentId: owned.id, provenance: evaluation,
    });
  });

  it("recovers the original recommendation and hash after live issue edits", () => {
    const initial = {
      title: "Original issue", body: "Original text", labels: ["triage:mark"],
      comments: [lookalike, owned],
    };
    const edited = {
      ...initial, title: "Edited issue", body: "Edited text", labels: ["triage:close"],
    };
    for (const issue of [initial, edited]) {
      expect(readTriageNote(issue.comments, writerId)).toEqual({
        ok: true, kind: "found", commentId: owned.id, provenance: evaluation,
      });
    }
  });

  it.each([
    ["unterminated", "<!-- march-triage-note:v1 e30=", "malformed-marker"],
    ["inline", `Explanation ${marker}`, "malformed-marker"],
    ["followed by text", `${marker}\nExplanation`, "malformed-marker"],
    ["unsupported", marker.replace(":v1", ":v2"), "unsupported-version"],
    ["invalid payload", markerFor("{}"), "invalid-payload"],
    ["repeated", `${marker}\n${marker}`, "multiple-markers"],
    ["valid with malformed duplicate", `<!-- march-triage-note\n${marker}`, "multiple-markers"],
  ])("fails without a target for an owned %s marker", (_name, body, code) => {
    expect(readTriageNote([lookalike, { ...owned, body }], writerId)).toEqual({ ok: false, code });
  });

  it("fails without a target when more than one owned candidate exists", () => {
    const second = { ...owned, id: 43, body: "<!-- march-triage-note" };
    for (const comments of [[owned, second], [second, owned]]) {
      expect(readTriageNote(comments, writerId)).toEqual({ ok: false, code: "multiple-candidates" });
    }
  });
});
