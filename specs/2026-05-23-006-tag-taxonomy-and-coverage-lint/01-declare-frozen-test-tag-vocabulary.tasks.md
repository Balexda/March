# Tasks: Declare the Frozen Test Tag Vocabulary

**Source**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.spec.md` - User Story 1
**Data Model**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.data-model.md`
**Contracts**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.contracts.md`
**Story Number**: 01

---

## Slice 1: Add Leading Test Taxonomy Declarations
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Every current Vitest `*.test.ts` file declares a complete leading tag tuple from the frozen vocabulary before imports.

**Justification**: This slice delivers the visible declaration convention that later linting, staged scripts, and documentation consume without adding those downstream mechanisms.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-013; Acceptance Scenario 1.1, Acceptance Scenario 1.2, Acceptance Scenario 1.3

### Tasks

- [ ] **Add taxonomy blocks to Vitest files**

  Add the leading tag block required by the Test File Tag Block contract to every current `*.test.ts` file outside generated dependency directories. Classify each file with exactly one scope tag, one determinism tag, and one execution-channel tag, using the spec's baseline assumptions and preserving all existing imports, mocks, test bodies, and assertions.

  _Acceptance criteria:_
  - Every current `*.test.ts` file has a leading comment block before imports.
  - Each leading block contains exactly one scope tag satisfying AS 1.1.
  - Each leading block contains exactly one determinism tag satisfying AS 1.2.
  - Each leading block contains exactly one execution-channel tag satisfying AS 1.3.
  - No staged scripts, coverage lint command, quarantine routing, or Cucumber.js migration is introduced.
  - Existing test behavior remains unchanged apart from the added declarations.

**PR Outcome**: The repository's existing Vitest suite visibly declares the frozen taxonomy tuple in the canonical leading location, ready for the coverage lint in User Story 2.

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
| S1 | Add Leading Test Taxonomy Declarations | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Fail Loudly on Untagged or Mis-tagged Test Files | depended upon by | The coverage lint consumes the tag tuple declared by this story. |
| User Story 3: Preserve Existing Test Scope While Tagging the Baseline | depended upon by | The baseline classification story depends on these canonical declarations while preserving test behavior. |
| User Story 4: Keep Operator Documentation Aligned With the New Taxonomy | depended upon by | Operator documentation can describe the convention after the vocabulary is declared in tests. |
