# Tasks: Refresh The Mechanical Parts Of A Contract Deterministically

**Source**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.spec.md` - User Story 2
**Data Model**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.data-model.md`
**Contracts**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.contracts.md`
**Story Number**: 02

---

## Slice 1: Codify Deterministic Autogen Handoff
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make the contract-maintenance convention explicitly delegate mechanically-derivable contract regions to Feature 7's deterministic extractor while preserving manual edit-time upkeep when the extractor is unavailable.

**Justification**: User Story 2 is documentation-boundary work: this feature defines the convention and references the extractor, while Feature 7 owns the extractor implementation. A single slice is the smallest coherent increment because the deterministic handoff, non-AI boundary, stable ordering expectation, and fallback behavior must land together to avoid implying either manual generated-region authorship or a new freshness gate.

**Addresses**: FR-003, FR-004, FR-005, FR-007, FR-011; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [ ] **Document the deterministic extractor handoff**

  Update the contract-authoring convention in `docs/subsystems/contract-scaffold.md` so mechanically-derivable public-interface regions point to Feature 7's `docs:contracts:extract` tool. The guidance should satisfy AS 2.1 and AS 2.3 without implementing extraction logic, adding a gate, or moving contributor-guide coverage from US3 into this story.

  _Acceptance criteria:_
  - Mechanical contract regions are described as refreshed by Feature 7's deterministic extractor.
  - The guidance names the extractor as a convention reference, not as functionality implemented by this feature.
  - If the extractor is absent, the convention degrades to manual edit-time upkeep with no gate.
  - No `.github/workflows/contract-freshness.yml` workflow, CI job, or AI-on-check-in step is introduced.
  - `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` are not broadened beyond the already-planned US3 contributor-guide coverage.

- [ ] **State generated-region stability expectations**

  Extend the same contract-authoring convention to record the stability boundary for generated regions. The guidance should satisfy AS 2.2 by requiring deterministic, ordered output that avoids churn from cosmetic source moves, while leaving parser, replacement, check-mode, and write-mode behavior to Feature 7.

  _Acceptance criteria:_
  - Generated-region output is expected to be deterministic and ordered.
  - Cosmetic source moves alone are not treated as a reason for generated-region churn.
  - Feature 7 remains the owner of extraction, replacement, and command-mode behavior.
  - Feature 5's `docs:contracts:check` remains opt-in and advisory if referenced.
  - No runtime subsystem behavior, service route, Herald event, Hatchery job, Brood record, Castra session, Legate loop action, or autonomous prompt is introduced.

**PR Outcome**: Contract maintainers have an explicit convention-level handoff for mechanical contract regions: Feature 7's deterministic extractor refreshes generated public-interface content when available, manual edit-time upkeep remains the fallback, and no enforcement gate or per-check-in AI validation is introduced.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None - all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Codify Deterministic Autogen Handoff | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Maintain a subsystem's contract doc as part of the change that alters its surface | depends on | US2 builds on the same-change maintenance convention established by US1 before adding the generated-region handoff. |
| User Story 3: Document the convention in the contributor guides | depended upon by | US3 broadens discoverability in `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` after US2 settles the deterministic extractor language. |
| User Story 4: Record the SD-002 "no enforcement gate" decision | depended upon by | US4 records the overall vehicle decision after the edit-time and deterministic-autogen convention details are in place. |
