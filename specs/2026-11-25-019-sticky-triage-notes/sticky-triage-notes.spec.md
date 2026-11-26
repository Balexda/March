# Feature Specification: Sticky Triage Notes

**Spec Folder**: `2026-11-25-019-sticky-triage-notes`
**Branch**: `feature/smithy/mark/issue-triage-m1-f3`
**Created**: 2026-11-25
**Status**: Draft
**Input**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)
**Source Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md#feature-3-sticky-triage-notes) — Feature 3: Sticky Triage Notes

## Clarifications
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Session 2026-11-25

- The note records the recommendation produced for its evaluation. GitHub labels continue to represent current triage state.
- A hidden marker is omitted from the rendered comment. Its contents are readable through the comment source.

## Artifact Hierarchy
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: optional -->

### User Story 1: Read One Actionable Triage Note (Priority: P1)

As an issue author, I want one comment explaining the recommendation and what I can clarify so that I can respond to feedback on my issue.

**Why this priority**: The note is the author's explanation of the verdict.

**Independent Test**: Render notes for the verdict vocabulary, including each needs-definition grade, and evaluate note selection against issue comment fixtures.

**Acceptance Scenarios**

1. **Given** a validated verdict for an issue without a triage note, **when** the note is prepared, **then** its public text shows the recommendation, confidence, rationale, and any publishable repository context used in the evaluation. The issue title and body stay intact.
2. **Given** a needs-definition verdict, **when** the note is rendered, **then** it communicates the grade, names the gaps in the issue, and gives concrete details the author can supply using the published tone standard.
3. **Given** an issue with one recognized triage note, **when** a fresh evaluation is recorded, **then** the note contract identifies the same comment for replacement. If the proposed body is identical, the contract returns an unchanged result.

### User Story 2: Trace the Original Verdict (Priority: P1)

As a maintainer, I want to recover the verdict and the inputs it was based on so that I can interpret the recommendation after labels or issue text change.

**Why this priority**: Later consumers need the original recommendation to interpret operator overrides.

**Independent Test**: Round-trip provenance through the note contract and read it against fixtures with edited labels, edited text, and untrusted comments.

**Acceptance Scenarios**

1. **Given** an evaluation with a rubric version, issue content hash, original verdict, and added repository context, **when** its marker is read, **then** each value is recovered, including the grade for needs-definition, while the marker remains hidden in rendered Markdown.
2. **Given** a subsequent label or issue text edit, **when** the stored marker is read, **then** it still yields the recommendation and hash for the evaluation recorded in the note.
3. **Given** a lookalike marker posted by a different author, an invalid marker on an owned triage comment, or multiple owned triage candidates, **when** comments are inspected, **then** the lookalike is ignored and either owned conflict yields a failure without a replacement target.

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| US1 | Read One Actionable Triage Note | — | specs/2026-11-25-019-sticky-triage-notes/01-read-one-actionable-triage-note.tasks.md |
| US2 | Trace the Original Verdict | — | specs/2026-11-25-019-sticky-triage-notes/02-trace-the-original-verdict.tasks.md |

## Requirements
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: recommended -->

| ID | Story | Requirement |
|---|---|---|
| FR-001 | US1 | Define a single March-owned note per repository issue. Preserve comment identity on refresh and preserve the issue title and body. |
| FR-002 | US1 | Show the outcome, confidence, rationale, and any added publishable context. Apply the published tone standard to the grade and explanation for needs-definition. |
| FR-003 | US2 | Preserve the rubric revision, evaluated issue content hash, original validated verdict, and added context in a hidden marker. Preserve the grade in the original verdict when applicable. |
| FR-004 | US1, US2 | Recognize a note using its marker and trusted author identity. Surface malformed or ambiguous owned notes as explicit failures. [March operating philosophy](../../docs/operating-philosophy.md#3-failures-are-clean-exits-not-hangs) |

### Key Entities

- **Triage note** — The issue comment that explains the recorded recommendation.
- **Evaluation provenance** — The marker payload that ties the recommendation to its inputs.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- Consumers receive the expected writer identity and the complete issue comment set.
- Added repository context is suitable for the issue audience, including when read from comment source.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Out of Scope
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- GitHub comment writes and updates linking to merged intake artifacts.

## Success Criteria
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- **SC-001** — All eight verdict outcomes yield readable notes. All three needs-definition grades yield a concrete clarification request.
- **SC-002** — An unchanged repeat yields zero proposed changes, and a refreshed evaluation targets the existing comment ID.
- **SC-003** — All provenance fields round-trip, and malformed or ambiguous owned markers yield zero proposed changes.
