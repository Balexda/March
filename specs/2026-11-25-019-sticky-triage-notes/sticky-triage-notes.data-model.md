# Data Model: Sticky Triage Notes

**Feature**: [Specification](sticky-triage-notes.spec.md)
**Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md)
**Source RFC**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)

## Entities
<!-- audience: builder+ai-input; mode: reference -->

| Entity | Identity | Data and ownership |
|---|---|---|
| Triage note | One per GitHub repository identity and issue number | The trusted triage writer owns the comment. GitHub assigns its stable comment ID. The note pairs public explanation with one hidden marker. |
| Evaluation provenance | The evaluation recorded in the note | Replaced as a unit with the explanation when a new evaluation is recorded. Readers recover the original recommendation from the marker and current triage state from GitHub labels. |

## Marker Payload
<!-- audience: builder+ai-input; mode: reference -->

| Field | Type | Constraint |
|---|---|---|
| `rubricVersion` | Nonblank string | Rubric revision used by judgment. Independent of marker and verdict schema versions. |
| `issueContentHash` | Nonblank string | Hash of the exact title and body supplied to judgment, using the shared issue content identity. [Hash inputs](../2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.data-model.md#relationships-and-state) |
| `originalVerdict` | Verdict object | Complete validated verdict as produced for the evaluation, including `needsDefinition.grade` and `needsDefinition.explanation` when applicable. [Verdict data model](../2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.data-model.md#entities) |
| `repositoryContext` | Array of nonblank strings | Ordered publishable context added to the note for this evaluation. Empty when none was added. |

The marker records one evaluation. An edit to the issue or its labels leaves its stored values intact until a new evaluation replaces the note.
