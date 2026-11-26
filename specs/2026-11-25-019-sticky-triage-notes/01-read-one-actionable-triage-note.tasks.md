# Tasks: Read One Actionable Triage Note

**Source**: `specs/2026-11-25-019-sticky-triage-notes/sticky-triage-notes.spec.md` — User Story 1
**Data Model**: `specs/2026-11-25-019-sticky-triage-notes/sticky-triage-notes.data-model.md`
**Contracts**: `specs/2026-11-25-019-sticky-triage-notes/sticky-triage-notes.contracts.md`
**Story Number**: 01

---

## Slice 1: Prepare and select the sticky triage note
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Prepare an actionable comment from a validated verdict and determine whether the issue needs a new comment, a replacement, or no change.

**Justification**: Rendering and selection together deliver a complete note proposal using the same marker contract.

**Addresses**: FR-001, FR-002, FR-004 and AS 1.1, AS 1.2, AS 1.3.

### Tasks

- [x] **Render the public note and its marker**

  Add deterministic rendering under `src/triage/` using the validated verdict vocabulary in `src/triage/verdict.ts` and the supplied evaluation metadata. Follow the Note Format and Published Tone Standard for AS 1.1 and AS 1.2.

  _Acceptance criteria:_
  - Tests cover all eight outcomes, all three needs-definition grades, and notes with and without repository context.
  - The public explanation includes outcome and confidence before rationale, identifies added repository context, and presents the needs-definition grade and concrete clarification in the published tone.
  - Identical inputs yield byte-identical bodies. Free text renders as inert Markdown, including inputs containing mention or marker syntax.
  - The body ends with exactly one standalone hidden marker using the contracted v1 format and payload.

- [x] **Select a change using the trusted writer identity**

  Use the complete comment set for one issue and the expected writer identity to select a note change in `src/triage/`. Apply the Note Selection contract for AS 1.1 and AS 1.3. Reuse the verdict validator when checking marker validity and follow March’s [clean failure rule](../../docs/operating-philosophy.md#3-failures-are-clean-exits-not-hangs).

  _Acceptance criteria:_
  - Tests cover a new note with no owned candidate, replacement at the same comment ID when the proposed body differs, and an unchanged result on an exact match.
  - Tests cover untrusted lookalikes, owned markers with malformed syntax or invalid payloads, unsupported versions, repeated markers, and multiple owned candidates. Untrusted lookalikes are ignored and owned conflicts return an explicit failure with no change proposal.
  - Selection produces only a comment proposal, an unchanged result, or a failure. The issue title, body, labels, and state stay intact.

**PR Outcome**: A caller can prepare a public note and determine the comment change from an issue’s existing comments.

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
| S1 | Prepare and select the sticky triage note | — | — |

### Cross-Story Dependencies

None required for this slice. Story 2 covers provenance recovery. Both stories use the same marker contract and can share marker logic as it lands.
