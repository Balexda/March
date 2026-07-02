# Tasks: Fan Out CI Into Legible Staged Jobs

**Source**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.spec.md` — User Story 3
**Data Model**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.data-model.md`
**Contracts**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.contracts.md`
**Story Number**: 03

---

## Slice 1: Split CI Into Staged Layer Jobs
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The CI workflow reports deterministic test coverage as an `l0` fail-fast gate followed by parallel `l1`, `l2-cassette`, and `l3-cassette` jobs across the existing Node matrix.

**Justification**: The staged npm scripts and tag-selection guard already exist. This slice completes the CI graph legibility contract in one workflow-focused PR without changing the local runner or operator docs.

**Addresses**: FR-006, FR-007, FR-008, FR-010; Acceptance Scenario 3.1, Acceptance Scenario 3.2, Acceptance Scenario 3.3, Acceptance Scenario 3.4, Acceptance Scenario 3.5

### Tasks

- [ ] **Restructure the CI workflow into staged jobs**

  Update `.github/workflows/ci.yml` so the existing monolithic build-test job becomes the Staged CI Job graph from the data model. Keep the Node 20/22 matrix and repository setup behavior intact while satisfying AS 3.1-AS 3.5 through npm-run layer entrypoints only.

  _Acceptance criteria:_
  - The workflow has a distinct `l0` gate job that runs before the fan-out jobs.
  - `l1`, `l2-cassette`, and `l3-cassette` jobs depend on `l0` and can run in parallel with each other after it succeeds.
  - Each staged job is independently named by layer in the GitHub Actions graph.
  - Each staged test step invokes only its corresponding `npm run test:<layer>` script.
  - The existing Node 20/22 matrix is preserved for all staged jobs.
  - The deterministic CI gate remains local and non-interactive, with no live March services, network calls, paid calls, or cassette refresh.

**PR Outcome**: GitHub Actions exposes the deterministic PR gate as a legible staged pipeline: `l0` fails first on broken fundamentals, and higher-layer failures identify their layer directly on the workflow graph.

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
| S1 | Split CI Into Staged Layer Jobs | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Expose Layered Npm Test Scripts | depends on | CI fan-out calls the staged npm scripts and aggregate coverage established by User Story 1. |
| User Story 2: Keep Selection Driven by the Tag Contract | depends on | CI fan-out relies on the staged scripts' tag selection and untagged-file guard behavior from User Story 2. |
| User Story 4: Keep Operator Docs Current For Staged Test Use | depended upon by | Operator docs can describe the CI graph after this story defines the staged workflow shape. |
