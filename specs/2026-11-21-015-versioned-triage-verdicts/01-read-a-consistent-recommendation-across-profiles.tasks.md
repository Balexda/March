# Tasks: Read a consistent recommendation across profiles

**Source**: `specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.spec.md` — User Story 1
**Data Model**: `specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.data-model.md`
**Contracts**: `specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.contracts.md`
**Story Number**: 01

## Slice 1: Deliver the shared v1 triage verdict contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give every profile one validation boundary for untrusted triage candidates and one interpretation of validated recommendations.

**Justification**: A single PR delivers the vocabulary, strict validation, and route interpretation together so consumers can use the whole contract at merge.

**Addresses**: FR-001, FR-002, FR-003, FR-004; AS 1.1, AS 1.2, AS 1.3, AS 1.4.

### Tasks

- [ ] **Define the shared v1 verdict and rubric**

  Define the verdict vocabulary in the triage domain using the data model and rubric for AS 1.1 and AS 1.2. Keep the rubric revision independent of the wire schema version.

  _Acceptance criteria:_
  - All profiles use the same v1 vocabulary of eight outcomes, three confidence levels, and three needs-definition grades. The verdict type expresses the conditional needs-definition details.
  - The published rubric describes the outcomes, confidence levels, and grades, including when questions and support requests resolve to `close` or `needs-definition`. Recommender execution and calibration belong to the later recommender milestone.

- [ ] **Validate the complete candidate before it becomes eligible for writes**

  Add the verdict validation boundary in the triage domain for AS 1.3. Emit the validation failure through the existing observability subsystem in accordance with [operating philosophy rule 3](../../docs/operating-philosophy.md#3-failures-are-clean-exits-not-hangs).

  _Acceptance criteria:_
  - Validate raw candidate JSON so duplicate keys at any depth are detectable. Admit only a single object with the exact v1 schema, including nonblank strings and needs-definition details required for that outcome and forbidden for all others.
  - Reject malformed JSON, unsupported versions, duplicate or unknown keys, invalid types and values, and missing fields. Return a field or document diagnostic with no eligible verdict on failure, and emit an errored span when tracing is enabled.
  - Exercise the same corpus for march and smithycli. Cover all eight outcomes, all three confidence levels and grades, all five contract rejection fixtures, and the additional invalid cases above.

- [ ] **Expose the Smithy destination for each build outcome**

  Surface the named destination from validated build verdicts for AS 1.4. Document the validation and recommendation surfaces in the owning subsystem contract.

  _Acceptance criteria:_
  - Each build outcome maps to its one named Smithy entry point with the issue and triage note as the intended freeform inputs. The handoff documentation records the explicit acceptance requirement and milestone 6 compatibility checks that will determine any upstream mapping or seed-only handoff.
  - Resolving a recommendation is read-only. Tests cover each build route and confirm that non-build outcomes carry no build destination, including high-confidence `close`. A verdict alone has no authority to dispatch, close, or otherwise mutate an issue.

**PR Outcome**: A consumer can validate a v1 candidate consistently across profiles, inspect its recommendation, or receive a diagnostic and an errored span for rejected input when tracing is enabled.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|---|---|---|---|---|
| IQ-001 | Which JSON parsing approach detects duplicate keys before object construction? | S1 | building | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| S1 | Deliver the shared v1 triage verdict contract | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|---|---|---|
| US2 — Use a compatible judgment provider | depended upon by | US2 reuses the verdict validation boundary for provider compatibility. |
