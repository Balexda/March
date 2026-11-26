# Tasks: Trace the original verdict

**Source**: `specs/2026-11-25-019-sticky-triage-notes/sticky-triage-notes.spec.md` — User Story 2
**Data Model**: `specs/2026-11-25-019-sticky-triage-notes/sticky-triage-notes.data-model.md`
**Contracts**: `specs/2026-11-25-019-sticky-triage-notes/sticky-triage-notes.contracts.md`
**Story Number**: 02

---

## Slice 1: Recover trusted triage provenance
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give triage consumers a deterministic way to encode an evaluation and recover it from the issue's trusted note.

**Justification**: Encoding, validation, and trusted comment selection share the marker contract. One slice delivers a reader that can recover provenance safely from comment fixtures.

**Addresses**: FR-003, FR-004 and AS 2.1–2.3.

### Tasks

- [ ] **Encode and validate evaluation provenance**

  Build the marker codec in `src/triage/` from the note format and marker payload contracts. Reuse the validator in `src/triage/verdict.ts` when reading the original verdict for AS 2.1 and AS 2.2.

  _Acceptance criteria:_
  - Encode the rubric revision, evaluated issue hash, complete validated verdict, and ordered publishable repository context in the standalone, hidden v1 marker.
  - Reject unsupported versions, invalid Base64 or UTF-8 JSON, and payloads that violate the marker data model or verdict contract.
  - Verify deterministic encoding and exact round-trips for Unicode context, empty context, and all needs-definition grades. Recover the original recommendation and hash after edits to live labels or issue text.

- [ ] **Identify the trusted note and report owned conflicts**

  Apply the note selection contract to the complete issue comment set and expected writer identity for AS 2.3. Expose the comment identity and decoded provenance for a valid owned note and document the mapped interface in `docs/subsystems/triage/contract.md`.

  _Acceptance criteria:_
  - Ignore reserved markers from other authors. Distinguish absence from a single valid owned note and preserve the valid note's comment ID.
  - Return an explicit failure without a replacement target or proposed change for a malformed or unsupported owned marker, multiple markers on one owned candidate, or multiple owned candidates.
  - Verify these cases with deterministic comment fixtures. Keep comment writes outside the interface.

**PR Outcome**: Consumers can recover the evaluated recommendation and its inputs from a trusted note and detect owned conflicts before proposing a change.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| S1 | Recover trusted triage provenance | — | — |

### Cross-Story Dependencies

US1 and US2 share marker validation and trusted candidate recognition under FR-004. Either story can introduce the shared logic first. Reuse it if present. US2 verifies provenance against comment fixtures independently of US1's public rendering and replacement proposal.

### Cross-Repo Notes

None — single repo.
