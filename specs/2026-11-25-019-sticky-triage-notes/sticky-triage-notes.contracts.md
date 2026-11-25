# Contracts: Sticky Triage Notes

**Feature**: [Specification](sticky-triage-notes.spec.md)
**Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md)
**Source RFC**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)

## Note Format
<!-- audience: builder+ai-input; mode: reference -->

| Section | Contract |
|---|---|
| Public explanation | Show the recommended outcome and confidence, then the rationale. Include any added repository context and identify it as repository context. |
| Needs-definition feedback | Include the grade and the concrete clarification from the verdict in language that meets the tone standard below. |
| Hidden marker | End the comment with a single standalone HTML comment of the form `<!-- march-triage-note:v1 PAYLOAD -->`. `PAYLOAD` is standard padded Base64 of the UTF-8 JSON [marker payload](sticky-triage-notes.data-model.md#marker-payload). |

The renderer emits the same body for identical inputs. Render free text as inert Markdown text so issue-derived content cannot introduce marker syntax or active mentions. Treat the note and marker as public through comment source and include only material suitable for that audience.

## Note Selection
<!-- audience: builder+ai-input; mode: reference -->

The input is one issue's complete comment set, the trusted triage writer identity, and the proposed note body from a validated verdict. A candidate is a comment by that identity with the reserved `march-triage-note` HTML comment prefix. A valid candidate has exactly one marker with a supported version and a payload that satisfies the data model. Ignore markers from other authors.

| Observed state | Result |
|---|---|
| No candidate | No existing note. Return the body for a new note. |
| One valid candidate, body differs | Return the existing comment ID and replacement body. |
| One valid candidate, body matches | Return unchanged. |
| Multiple candidates or a malformed or unsupported candidate | Return an explicit failure with no proposed change. |

These results describe note selection. They convey no authority to accept a verdict or change issue state.

## Published Tone Standard
<!-- audience: builder+ai-input; mode: reference -->

Assess the information available in the issue. Use neutral, specific language and give the author a practical next step. State which details would let triage proceed. Keep the request proportionate to the gaps. Avoid personal judgments, blame, and guesses about the author's intent.

| Verdict grade | Public wording | Example request |
|---|---|---|
| `minor-gaps` | Minor gaps | “Please include the March version and the command that produced this error.” |
| `major-gaps` | Major gaps | “Please share the expected result, what happened instead, and the steps that reproduce it.” |
| `insufficient` | More definition needed | “Please describe the problem you encountered or the change you want, and what a successful result would look like.” |
