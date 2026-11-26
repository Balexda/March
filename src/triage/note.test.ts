/** @l0 @deterministic @ci */
import { describe, expect, it } from "vitest";
import { renderTriageNote, selectTriageNote, type TriageNoteEvaluation } from "./note.js";
import { TRIAGE_OUTCOMES, validateTriageVerdict } from "./verdict.js";

const basic = { schemaVersion: 1, confidence: "high", rationale: "The issue describes a specific change" };
const clarification = "Please share the command and the expected result";

function evaluationFor(verdict: unknown): TriageNoteEvaluation {
  const result = validateTriageVerdict(JSON.stringify(verdict));
  if (!result.ok) throw new Error("Invalid verdict fixture");
  return {
    rubricVersion: "baseline-1",
    issueContentHash: "evaluated-content-hash",
    originalVerdict: result.verdict,
    repositoryContext: [],
  };
}

const evaluation = evaluationFor({ ...basic, outcome: "mark" });
const proposed = renderTriageNote(evaluation);
const writerId = 42;

function comment(body: string, authorId: number | null = writerId, id = 17) {
  return { body, authorId, id };
}

function marker(payload: unknown, version = "v1") {
  return `<!-- march-triage-note:${version} ${Buffer.from(JSON.stringify(payload)).toString("base64")} -->`;
}

function rawMarker(json: string) {
  return `<!-- march-triage-note:v1 ${Buffer.from(json).toString("base64")} -->`;
}

describe("renderTriageNote", () => {
  it.each(TRIAGE_OUTCOMES)("publishes the %s outcome and confidence before the rationale", (outcome) => {
    const needsDefinition = outcome === "needs-definition"
      ? { needsDefinition: { grade: "minor-gaps", explanation: clarification } }
      : {};
    const body = renderTriageNote(evaluationFor({ ...basic, outcome, ...needsDefinition }));
    expect(body).toContain(`**Recommended outcome:** ${outcome}\n\n**Confidence:** high\n\n${basic.rationale}`);
    expect(body).not.toContain("Repository context");
  });

  it.each([
    ["minor-gaps", "Minor gaps"],
    ["major-gaps", "Major gaps"],
    ["insufficient", "More definition needed"],
  ])("publishes the %s grade and the supplied clarification", (grade, label) => {
    const input = evaluationFor({
      ...basic, outcome: "needs-definition", needsDefinition: { grade, explanation: clarification },
    });
    expect(renderTriageNote(input)).toContain(`**${label}**\n\n${clarification}`);
  });

  it("renders inert text and preserves the original UTF-8 evaluation in one final marker", () => {
    const hostileText = "@octocat <!-- march-triage-note:v9 fake -->\n# Heading **bold** [link](https://example.com)";
    const input = {
      ...evaluationFor({
        ...basic, outcome: "needs-definition", rationale: hostileText,
        needsDefinition: { grade: "major-gaps", explanation: hostileText },
      }),
      repositoryContext: [hostileText, "The repository uses café fixtures"],
    };
    const body = renderTriageNote(input);
    const lines = body.split("\n");
    const encoded = /^<!-- march-triage-note:v1 ([A-Za-z0-9+/]+={0,2}) -->$/.exec(lines.at(-1) ?? "")?.[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"))).toEqual(input);
    expect(body).toBe(renderTriageNote(input));
    expect(body.match(/<!-- march-triage-note/g)).toHaveLength(1);

    const publicText = lines.slice(0, -1).join("\n");
    expect(publicText).toContain("**Repository context**");
    expect(publicText).toContain("- The repository uses café fixtures");
    expect(publicText.match(/<code>&#64;octocat<\/code>/g)).toHaveLength(3);
    for (const syntax of ["@octocat", "<!--", "\n# Heading", "**bold**", "[link]", "https://"]) {
      expect(publicText).not.toContain(syntax);
    }
  });
});

describe("selectTriageNote", () => {
  it("proposes a new note when there is no owned candidate", () => {
    expect(selectTriageNote([], writerId, proposed)).toEqual({ kind: "create", body: proposed });
    expect(selectTriageNote([
      comment("Ordinary comment"),
      comment(proposed, 99),
      comment("<!-- march-triage-note:v9 invalid -->", null),
    ], writerId, proposed)).toEqual({ kind: "create", body: proposed });
  });

  it("targets the original comment ID on refresh and returns unchanged on exact match", () => {
    const refreshed = renderTriageNote({ ...evaluation, issueContentHash: "new-hash" });
    const owned = comment(proposed);
    const issue = {
      title: "Original title",
      body: "Original body",
      labels: ["triage:mark"],
      state: "open",
      comments: Object.freeze([Object.freeze(owned), Object.freeze(comment(proposed, 99, 18))]),
    };
    const snapshot = structuredClone(issue);
    expect(selectTriageNote(issue.comments, writerId, refreshed))
      .toEqual({ kind: "replace", commentId: owned.id, body: refreshed });
    expect(selectTriageNote(issue.comments, writerId, proposed)).toEqual({ kind: "unchanged" });
    expect(issue).toEqual(snapshot);
  });

  it.each([
    ["malformed syntax", "<!-- march-triage-note:v1"],
    ["inline marker", `prefix ${marker(evaluation)}`],
    ["unsupported version", marker(evaluation, "v2")],
    ["invalid Base64", "<!-- march-triage-note:v1 abc -->"],
    ["invalid UTF-8", "<!-- march-triage-note:v1 /w== -->"],
    ["invalid JSON", "<!-- march-triage-note:v1 bm90LWpzb24= -->"],
    ["blank rubric", marker({ ...evaluation, rubricVersion: " " })],
    ["missing hash", marker({ ...evaluation, issueContentHash: undefined })],
    ["extra field", marker({ ...evaluation, extra: true })],
    ["blank context", marker({ ...evaluation, repositoryContext: [""] })],
    ["invalid verdict", marker({ ...evaluation, originalVerdict: { ...basic, outcome: "unknown" } })],
    ["duplicate verdict key", rawMarker(JSON.stringify({ ...evaluation, originalVerdict: { ...basic, outcome: "mark" } })
      .replace('"outcome":"mark"', '"outcome":"close","outcome":"mark"'))],
    ["duplicate payload key", rawMarker(JSON.stringify(evaluation).replace('{', '{"rubricVersion":"other",'))],
    ["trailing text after marker", `${proposed}\nAdditional text`],
    ["repeated marker", `${proposed}\n\n${marker(evaluation)}`],
    ["valid and malformed markers", `${proposed}\n\n<!-- march-triage-note:v1`],
  ])("fails without a proposal for an owned note with %s", (_case, body) => {
    expect(selectTriageNote([comment(body)], writerId, proposed))
      .toEqual({ kind: "failure", reason: "invalid-marker" });
  });

  it("fails without a proposal when multiple comments are owned candidates", () => {
    expect(selectTriageNote([comment(proposed), comment(proposed, writerId, 18)], writerId, proposed))
      .toEqual({ kind: "failure", reason: "multiple-candidates" });
  });
});
