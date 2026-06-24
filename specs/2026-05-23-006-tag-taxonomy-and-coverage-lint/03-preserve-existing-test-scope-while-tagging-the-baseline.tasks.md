# Tasks: Preserve Existing Test Scope While Tagging The Baseline

**Source**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.spec.md` - User Story 3
**Data Model**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.data-model.md`
**Contracts**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.contracts.md`
**Story Number**: 03

---

## Slice 1: Classify The Existing Test Baseline In Place
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Every existing Vitest test file has a behavior-preserving baseline classification that reflects the boundary it already exercises.

**Justification**: This slice delivers the whole User Story 3 baseline-preservation promise as one coherent PR because the classification review and tag updates must be checked across the complete current test inventory to avoid silent scope drift.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-010, FR-011, FR-013; Acceptance Scenario 3.1, Acceptance Scenario 3.2, Acceptance Scenario 3.3

### Tasks

- [x] **Tag the baseline tests in place**

  Review the current repo `*.test.ts` inventory and adjust only leading Test File Tag Blocks so each file's scope tag matches the boundary it already exercises. Preserve all imports, mocks, helpers, test bodies, assertions, and framework choices while satisfying AS 3.1-3.3.

  _Acceptance criteria:_
  - Every existing `*.test.ts` file has a complete leading tag tuple.
  - Unit-style files are tagged `@l0 @deterministic @ci` unless a stronger existing boundary is evident.
  - Single-subsystem files are tagged `@l1 @deterministic @ci`.
  - The L2 baseline named by AS 3.3 is tagged `@l2 @deterministic @ci` where the files exist.
  - Existing child-process mocks in the L2 baseline remain mocked and do not exercise real Docker.
  - No test behavior, assertions, framework, staged script, quarantine route, or Cucumber.js port is introduced.

**PR Outcome**: The current Vitest baseline is fully tagged according to the frozen taxonomy while preserving the suite's existing behavioral surface.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | The spec names `src/hatchery/legate-container.test.ts` in AS 3.3 and FR-011, but the current repository inventory does not contain that path; implementation must confirm whether an existing renamed Hatchery L2 test is the intended baseline member or whether the spec needs a follow-up correction. | Scope Edges | Medium | High | open | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Classify The Existing Test Baseline In Place | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Declare the Frozen Test Tag Vocabulary | depends on | This story uses the canonical leading tag block convention declared by User Story 1. |
| User Story 2: Fail Loudly on Untagged or Mis-tagged Test Files | depends on | This story uses the taxonomy lint to confirm baseline coverage and detect missing or conflicting axes. |
| User Story 4: Keep Operator Documentation Aligned With the New Taxonomy | depended upon by | Documentation can describe the corrected baseline after this story classifies it in code. |
