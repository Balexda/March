# Tasks: Expose Layered Npm Test Scripts

**Source**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.spec.md` - User Story 1
**Data Model**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.data-model.md`
**Contracts**: `specs/2026-06-07-010-staged-ci-pipeline/staged-ci-pipeline.contracts.md`
**Story Number**: 01

---

## Slice 1: Add Layered Test Entrypoints
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The repository exposes the four stable `npm run test:*` commands that select one deterministic CI layer each.

**Justification**: This slice delivers the command surface contributors and later CI jobs can call directly, without requiring the aggregate `npm test` alias to be rebuilt first.

**Addresses**: FR-001, FR-002, FR-006, FR-010; Acceptance Scenario 1.1, Acceptance Scenario 1.2, Acceptance Scenario 1.3, Acceptance Scenario 1.4

### Tasks

- [ ] **Add the staged npm scripts**

  Add `test:l0`, `test:l1`, `test:l2-cassette`, and `test:l3-cassette` to `package.json`, with implementation owned by the existing test-command surface rather than ad hoc direct tool usage. Each script must map to exactly one Layered Test Script scope from the data model and satisfy AS 1.1-AS 1.4.

  _Acceptance criteria:_
  - `package.json` exposes all four staged script names.
  - Each staged script selects exactly one intended layer.
  - Each staged script requires the deterministic CI tag axes for its layer.
  - A layer with zero selected tests exits cleanly with explicit empty-layer diagnostics.
  - Each staged script remains reachable through `npm run`.
  - Staged scripts do not require live services, network calls, paid calls, or cassette refresh.

- [ ] **Cover the staged command contract**

  Add focused tests around the staged command surface in the package-script or selector module that owns the behavior. The tests should verify the Layered Test Script contract for AS 1.1-AS 1.4 without prescribing CI workflow behavior from User Story 3.

  _Acceptance criteria:_
  - Tests prove each staged script targets one scope only.
  - Tests prove the deterministic and CI axes are included.
  - Tests prove the M1 commands stay local and deterministic.
  - Tests do not require live Docker services, Hatchery, Brood, Herald, Castra, Legate, or cassette refresh.
  - No CI fan-out, operator docs, quarantine routing, or whole-repo coverage lint behavior is introduced.

**PR Outcome**: Contributors can run each deterministic staged layer through a stable npm script, and the command contract is covered independently of the aggregate gate.

---

## Slice 2: Rebuild The Aggregate Test Gate
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `npm test` becomes the sequential fail-fast aggregate over the four staged scripts while building at most once.

**Justification**: This slice completes the local PR-gate command after the layer entrypoints exist, preserving the familiar `npm test` surface while removing redundant rebuild amplification.

**Addresses**: FR-003, FR-004, FR-006, FR-010; Acceptance Scenario 1.5, Acceptance Scenario 1.6

### Tasks

- [ ] **Rebuild the aggregate npm test command**

  Update `package.json` so `npm test` runs the four staged scripts in the ordered Aggregate Deterministic Gate from the data model. The command must satisfy AS 1.5 while preserving the repository rule that test execution flows through npm scripts.

  _Acceptance criteria:_
  - `npm test` runs `test:l0`, `test:l1`, `test:l2-cassette`, and `test:l3-cassette` sequentially.
  - `npm test` stops after the first failing staged script.
  - `npm test` remains the full deterministic PR gate.
  - `npm test` is not narrowed to a single layer.
  - The aggregate command does not invoke direct test-runner commands outside npm scripts.

- [ ] **Resolve redundant pretest builds**

  Adjust the build/test script arrangement so invoking `npm test` builds at most once and staged scripts do not each trigger their own redundant build. Keep the behavior scoped to the local command surface in AS 1.6, leaving CI fan-out to User Story 3.

  _Acceptance criteria:_
  - `npm test` still performs the required build before executing the aggregate gate.
  - The four staged scripts do not each trigger a redundant build when called by `npm test`.
  - Direct `npm run test:<layer>` usage remains valid for local layer iteration.
  - The script arrangement preserves existing `npm run build` and `npm run typecheck` entrypoints.
  - No CI workflow restructuring is introduced in this slice.

**PR Outcome**: `npm test` is a sequential fail-fast aggregate over the staged layer scripts and avoids rebuilding once per layer.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Empty-layer behavior is not pinned by the feature map or RFC. A layer with zero matching tests must exit cleanly with explicit behavior, but the choice between "pass with no files" and "fail if a delivered layer unexpectedly has no tests" is left to task slicing. | Edge Cases | Low | Medium | resolved | Resolved 2026-06-13 - Slice 1 requires zero selected tests to exit cleanly with explicit empty-layer diagnostics. |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Add Layered Test Entrypoints | — | — |
| S2 | Rebuild The Aggregate Test Gate | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Keep Selection Driven by the Tag Contract | depended upon by | The tag-contract guard and retagging behavior consume the staged scripts from this story. |
| User Story 3: Fan Out CI Into Legible Staged Jobs | depended upon by | The CI fan-out calls the staged scripts and aggregate coverage established here. |
| User Story 4: Keep Operator Docs Current For Staged Test Use | depended upon by | Operator docs describe the command surface and aggregate gate after they exist. |
