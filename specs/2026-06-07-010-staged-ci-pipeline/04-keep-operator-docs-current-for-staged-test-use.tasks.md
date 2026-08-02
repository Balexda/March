# Tasks: Keep Operator Docs Current For Staged Test Use

**Source**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.spec.md` — User Story 4
**Data Model**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.data-model.md`
**Contracts**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.contracts.md`
**Story Number**: 04

---

## Slice 1: Align Staged Test Operator Docs
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Contributor-facing testing guidance names the staged deterministic commands, maps them to their layers, and keeps release guidance aligned with the rebuilt aggregate gate.

**Justification**: User Story 4 is documentation-only and can land as one coherent PR because the day-to-day command guidance and pre-release checklist must describe the same command surface.

**Addresses**: FR-006, FR-010, FR-011, FR-012; Acceptance Scenario 4.1, Acceptance Scenario 4.2, Acceptance Scenario 4.3

### Tasks

- [x] **Update staged testing guidance**

  Update `CONTRIBUTING.md` so its `## Testing` day-to-day commands and Pre-Release Checklist describe the staged npm command surface from the Layered Npm Scripts contract. The documentation should satisfy AS 4.1-AS 4.3 without changing scripts, CI, quarantine routing, cassette runtime behavior, or scheduled workflow behavior.

  _Acceptance criteria:_
  - `CONTRIBUTING.md` names `npm run test:l0`, `npm run test:l1`, `npm run test:l2-cassette`, and `npm run test:l3-cassette`.
  - The day-to-day testing guidance maps each staged command to L0, L1, L2 cassette-ready, or L3 cassette-ready coverage.
  - The `npm test` guidance identifies it as the sequential fail-fast aggregate deterministic PR gate over the staged scripts.
  - The Pre-Release Checklist's `npm test` step reflects the rebuilt aggregate gate from AS 4.2.
  - The documentation makes clear that future Cucumber.js runs, scheduled/stochastic runs, live cassette-backed L2/L3 execution, and cassette refresh remain outside M1's delivered PR gate (AS 4.3).
  - Documented usage routes through `npm run` or `npm test`, with no direct test-runner command introduced.

**PR Outcome**: Contributors can choose the smallest relevant deterministic staged gate from operator docs, and release guidance stays aligned with the full `npm test` aggregate.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Empty-layer behavior is not pinned by the feature map or RFC. A layer with zero matching tests must exit cleanly with explicit behavior, but the choice between "pass with no files" and "fail if a delivered layer unexpectedly has no tests" is left to task slicing. | Edge Cases | Low | Medium | resolved | Resolved 2026-06-13 - User Story 1 Slice 1 requires zero selected tests to exit cleanly with explicit empty-layer diagnostics. |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Align Staged Test Operator Docs | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Expose Layered Npm Test Scripts | depends on | Operator docs describe the staged script names and rebuilt aggregate `npm test` command from this story. |
| User Story 3: Fan Out CI Into Legible Staged Jobs | depends on | Operator docs can connect local command choice to the staged CI graph after this story defines the workflow shape. |
