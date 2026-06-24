# Tasks: Keep Operator Documentation Aligned With The New Taxonomy

**Source**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.spec.md` - User Story 4
**Data Model**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.data-model.md`
**Contracts**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.contracts.md`
**Story Number**: 04

---

## Slice 1: Align Operator Testing Documentation
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Operator-facing testing documentation describes the frozen tag tuple, corrected day-one baseline, and strategic handoff without claiming later staged-pipeline work is already delivered.

**Justification**: This slice delivers the whole User Story 4 documentation contract as one coherent PR because the contributor guidance, baseline correction, and strategic testing document must agree on what Feature 1 has delivered and what remains delegated.

**Addresses**: FR-012, FR-013; Acceptance Scenario 4.1, Acceptance Scenario 4.2, Acceptance Scenario 4.3

### Tasks

- [ ] **Update operator testing documentation**

  Update `CONTRIBUTING.md` and `docs/testing-strategy.md` so day-to-day contributor guidance names the required leading tag tuple for new Vitest files, the baseline documentation records the existing L2-shaped vitest tests as `node:child_process`-mocked tests rather than real Docker exercises, and the strategy document remains principles-level while delegating tactical sequencing to the RFC and feature specs.

  _Acceptance criteria:_
  - `CONTRIBUTING.md` tells contributors that new `*.test.ts` files need exactly one scope tag, one determinism tag, and one execution-channel tag in the leading Test File Tag Block.
  - The day-one baseline documentation names the existing L2-shaped vitest tests as mocked child-process tests and does not describe them as exercising real Docker.
  - `docs/testing-strategy.md` stays strategic and points milestone-level tactics to the layered testing RFC and feature specs.
  - The documentation does not present staged layer scripts, CI fan-out, quarantine routing, runtime tag guards, Cucumber.js ports, stochastic tests, or scheduled tests as delivered by this feature.

**PR Outcome**: Contributors can find the taxonomy convention in operator docs, and strategic testing guidance reflects the corrected mocked-L2 baseline without getting ahead of later staged-pipeline features.

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
| S1 | Align Operator Testing Documentation | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Declare the Frozen Test Tag Vocabulary | depends on | Documentation describes the canonical leading tag block convention declared by this story. |
| User Story 3: Preserve Existing Test Scope While Tagging the Baseline | depends on | Documentation records the corrected day-one baseline after the baseline classification is complete. |
