# Tasks: Keep Selection Driven by the Tag Contract

**Source**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.spec.md` — User Story 2
**Data Model**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.data-model.md`
**Contracts**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.contracts.md`
**Story Number**: 02

---

## Slice 1: Enforce Tag-Contract Selection
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Staged layer scripts select files from the leading tag tuple, exclude quarantine first, and fail loudly when a matched test file cannot be classified.

**Justification**: User Story 1 established the command surface. This slice makes the selector contract trustworthy for CI triage by preventing path-only drift and silent omission of untagged tests.

**Addresses**: FR-002, FR-005, FR-009, FR-010; Acceptance Scenario 2.1, Acceptance Scenario 2.2, Acceptance Scenario 2.3, Acceptance Scenario 2.4, Acceptance Scenario 2.5

### Tasks

- [x] **Add the untagged matched-file guard**

  Extend the staged test selector so each layer script checks candidate test files outside `tests/quarantine/` for a parseable leading tag block before execution. A candidate with no leading tag block must make the layer command exit non-zero with bounded diagnostics, while preserving the separate whole-repo taxonomy lint owned by Feature 1.

  _Acceptance criteria:_
  - A non-quarantined test file with no leading tag block makes any staged script that scans it exit non-zero before silent omission.
  - The diagnostic identifies the untagged file and the staged script that refused to run it.
  - Tagged files with incomplete or nonmatching axes are still handled by the existing tag-selection contract and are not reclassified through path-only rules.
  - Quarantined files remain excluded before the guard and do not fail staged scripts solely because they are under `tests/quarantine/`.
  - The guard remains local and deterministic, with no live services, network calls, paid calls, or cassette refresh.

- [x] **Cover tag-driven selection behavior**

  Add focused tests for the selector behavior that User Story 2 relies on: valid leading tag blocks include the matching layer, retagging moves a file between layers, stochastic or scheduled files stay out of deterministic CI scripts, and quarantine takes precedence over tags.

  _Acceptance criteria:_
  - A file tagged `@l0 @deterministic @ci` is selected by L0.
  - Retagging the same fixture to `@l1 @deterministic @ci` excludes it from L0 and includes it in L1.
  - Files tagged `@stochastic` or `@scheduled` are excluded from deterministic PR-gate scripts.
  - A validly tagged file under `tests/quarantine/` is excluded from every staged script before tag selection can include it.
  - Tests verify the untagged matched-file guard exits non-zero without depending on live Docker services, Hatchery, Brood, Herald, Castra, Legate, or cassette refresh.
  - No CI fan-out, operator docs, quarantine routing, whole-repo coverage lint, or test-layer migration policy is introduced.

**PR Outcome**: Layer scripts follow Feature 1's leading tag tuple, prove retagging changes selection, exclude quarantine before selection, and fail loudly on untagged matched test files.

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
| S1 | Enforce Tag-Contract Selection | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Expose Layered Npm Test Scripts | depends on | This story extends the staged scripts and aggregate command surface established by User Story 1. |
| User Story 3: Fan Out CI Into Legible Staged Jobs | depended upon by | CI fan-out must call scripts whose tag-selection and guard behavior are already reliable. |
| User Story 4: Keep Operator Docs Current For Staged Test Use | depended upon by | Operator docs can describe staged commands after their tag contract is fully enforced. |
