# Feature Specification: Staged CI Pipeline

**Spec Folder**: `2026-06-07-010-staged-ci-pipeline`
**Branch**: `feature/smithy/mark/layered-testing-framework-m1-f2`
**Created**: 2026-06-07
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` — Feature 2: Staged CI Pipeline, with the source RFC `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` — Feature 2: Staged CI Pipeline

## Clarifications

### Session 2026-06-07

- Feature 1 owns the frozen tag taxonomy and the whole-repo coverage lint. This feature consumes those tags to define staged npm scripts and the CI fan-out; it does not redefine the tag vocabulary, retag tests, or own the whole-repo coverage lint.
- The four staged script ids are pinned by the feature map and Feature 3's quarantine-routing contract: `test:l0`, `test:l1`, `test:l2-cassette`, and `test:l3-cassette`. Each runs exactly one scope.
- The CI fan-out shape is fixed by the feature map: an `l0` job runs first as a fail-fast gate, and `l1`, `l2-cassette`, and `l3-cassette` fan out in parallel only after `l0` succeeds. Each job runs only its corresponding `npm run test:*` script. The existing Node 20/22 build matrix is preserved.
- `npm test` is rebuilt as a sequential, fail-fast-on-first-failure alias over the four staged scripts, and the `pretest` build-amplification is resolved so the alias does not rebuild redundantly. It is not narrowed to a single layer and it does not absorb Feature 1's coverage lint.
- The per-script guard is a runtime exit-non-zero-on-untagged-but-matched check inside each staged script — distinct from Feature 1's whole-repo coverage lint. It catches a file that a layer's selector matched but that carries no leading tag block.
- The M1 staged pipeline remains deterministic and cost-free. The `l2-cassette`/`l3-cassette` scripts and jobs run whatever is tagged `@l2`/`@l3 @deterministic @ci` today; the cassette substrate is M3 and later, the scheduled stochastic workflow is M6, and quarantine routing behavior is Feature 3.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Expose Layered Npm Test Scripts (Priority: P1)

As the Operator-as-Test-Author, I want stable npm-run commands for each deterministic CI layer so that I can run just the layer I am iterating on locally — the same layer CI runs remotely.

**Why this priority**: The staged pipeline starts at the command surface. Without stable per-layer scripts, local debugging and CI jobs keep relying on an opaque `npm test` catch-all.

**Independent Test**: Inspect `package.json` and run each staged test script in a clean checkout; verify that each script exits through npm and selects only the intended deterministic CI layer.

**Acceptance Scenarios**:

1. **Given** a contributor wants the fastest deterministic unit gate, **When** they run `npm run test:l0`, **Then** only `@l0 @deterministic @ci` tests outside quarantine are selected.
2. **Given** a contributor wants subsystem coverage, **When** they run `npm run test:l1`, **Then** only `@l1 @deterministic @ci` tests outside quarantine are selected.
3. **Given** a contributor wants cross-subsystem cassette-ready coverage, **When** they run `npm run test:l2-cassette`, **Then** only `@l2 @deterministic @ci` tests outside quarantine are selected.
4. **Given** a contributor wants system cassette-ready coverage, **When** they run `npm run test:l3-cassette`, **Then** only `@l3 @deterministic @ci` tests outside quarantine are selected.
5. **Given** a contributor runs `npm test`, **When** the staged scripts exist, **Then** `npm test` runs the four staged scripts sequentially, fails fast on the first failing layer, and remains the full deterministic PR gate rather than a narrower layer.
6. **Given** `npm test` is invoked, **When** the `pretest` step runs, **Then** the project is built at most once and the four staged scripts do not each trigger a redundant rebuild.

---

### User Story 2: Keep Selection Driven by the Tag Contract (Priority: P1)

As a CI Failure Triager, I want layer scripts to select tests from Feature 1's leading tag blocks so that staged execution follows the same taxonomy the coverage lint validates, with a loud failure if a matched file is untagged.

**Why this priority**: Path-only selection would drift from the taxonomy contract and make retagging ineffective. The staged scripts must consume the tag tuple, not recreate a second classification scheme — and must refuse to run silently over a file they matched but cannot classify.

**Independent Test**: Temporarily retag a controlled test fixture between two layers and verify the selected staged script changes with the tag; strip the tag block from a file a layer matches and verify the script exits non-zero; place the fixture under `tests/quarantine/` and verify staged scripts exclude it regardless of tags.

**Acceptance Scenarios**:

1. **Given** a test file has a valid `@l0 @deterministic @ci` tag block, **When** the L0 script runs, **Then** that file is included.
2. **Given** the same file is validly retagged as `@l1 @deterministic @ci`, **When** the L0 script runs, **Then** that file is excluded and the L1 script includes it.
3. **Given** a file is `@stochastic` or `@scheduled`, **When** deterministic CI scripts run, **Then** that file is excluded from PR-gate execution.
4. **Given** a tagged test file lives under `tests/quarantine/`, **When** any staged script runs, **Then** the file is excluded before tag-based selection would include it.
5. **Given** a staged script's selector matches a file that carries no leading tag block, **When** that script runs, **Then** it exits non-zero rather than executing the untagged-but-matched file silently.

---

### User Story 3: Fan Out CI Into Legible Staged Jobs (Priority: P1)

As the CI Failure Triager, I want CI restructured so that `l0` runs first as a fail-fast gate and `l1`, `l2-cassette`, and `l3-cassette` fan out in parallel after it, so that a failing PR identifies the broken layer off the pipeline graph without log archaeology.

**Why this priority**: The RFC's legibility goal is clearer CI failure diagnosis. A single monolithic build-test job obscures whether the failure is a broken-fundamentals L0 stop-the-build or a higher-layer scenario regression.

**Independent Test**: Review a CI run and verify a single `l0` job runs first; `l1`, `l2-cassette`, and `l3-cassette` are separate jobs that start only after `l0` succeeds and run concurrently with each other; each job invokes only its `npm run test:*` script; and the Node 20/22 build matrix is preserved.

**Acceptance Scenarios**:

1. **Given** the `l0` layer fails, **When** CI runs, **Then** the `l0` gate job fails, the `l1`/`l2-cassette`/`l3-cassette` jobs do not run, and the failure is reported as a broken-fundamentals stop-the-build.
2. **Given** `l0` passes, **When** CI runs, **Then** `l1`, `l2-cassette`, and `l3-cassette` run in parallel as independently named jobs.
3. **Given** an `l1` test fails, **When** CI runs, **Then** the failing `l1` job is distinguishable on the pipeline graph from `l0`, `l2-cassette`, and `l3-cassette`.
4. **Given** each staged job runs, **When** it invokes its layer, **Then** it calls `npm run test:<layer>` and not `npx vitest` or any direct tool command.
5. **Given** all staged jobs pass on every matrix entry, **When** CI completes, **Then** the PR has passed the same deterministic coverage as `npm test` across the preserved Node 20/22 matrix.

---

### User Story 4: Keep Operator Docs Current For Staged Test Use (Priority: P2)

As a Test Author, I want `CONTRIBUTING.md` and the Pre-Release Checklist to reflect the staged test commands so that I choose the smallest relevant gate without reverse-engineering CI YAML.

**Why this priority**: The command surface is only useful if contributors can find it. Documentation also prevents later milestones from confusing M1's deterministic PR gates with scheduled or cassette-backed work.

**Independent Test**: Read the testing section in `CONTRIBUTING.md` and the Pre-Release Checklist; verify they name the staged npm commands, map each to a layer, keep the checklist's `npm test` step current, and state that scheduled/stochastic and live cassette-backed L2/L3 runs are out of scope for M1.

**Acceptance Scenarios**:

1. **Given** a contributor reads `CONTRIBUTING.md`, **When** they reach day-to-day testing commands, **Then** they can identify the script for L0, L1, L2 cassette, L3 cassette, and the full deterministic `npm test` gate.
2. **Given** a contributor is preparing a release, **When** they follow the Pre-Release Checklist, **Then** its `npm test` step reflects the rebuilt sequential fail-fast alias.
3. **Given** a contributor reads about future Cucumber.js, cassette, or scheduled runs, **When** they compare it to M1 commands, **Then** they can tell those are not part of this feature's delivered PR gate.

### Edge Cases

- A layer currently has zero matching tests; the script should exit cleanly with explicit empty-layer behavior rather than making CI look broken (see SD-001).
- A test file is matched by a layer selector but carries no parseable leading tag block; the per-script guard exits non-zero rather than running it silently.
- CI runs on multiple Node versions; staged job names stay stable across the Node 20/22 matrix.
- A future Cucumber.js test exists before the cassette substrate lands; deterministic staged scripts must not require live services or paid API calls.
- `npm test` must not become a synonym for only one layer; it remains the sequential fail-fast aggregate deterministic gate.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Expose Layered Npm Test Scripts | — | — |
| US2 | Keep Selection Driven by the Tag Contract | US1 | — |
| US3 | Fan Out CI Into Legible Staged Jobs | US1, US2 | — |
| US4 | Keep Operator Docs Current For Staged Test Use | US1, US3 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST expose four npm-run scripts named `test:l0`, `test:l1`, `test:l2-cassette`, and `test:l3-cassette`, each running exactly one scope.
- **FR-002**: Each layer script MUST select tests from Feature 1's leading tag tuple and require `@deterministic @ci` for its scope.
- **FR-003**: The `npm test` command MUST be rebuilt as a sequential, fail-fast-on-first-failure alias over the four staged scripts, remaining the aggregate deterministic PR gate; it MUST NOT be narrowed to a single layer.
- **FR-004**: The `pretest` build-amplification MUST be resolved so that `npm test` builds at most once and the staged scripts do not each trigger a redundant rebuild.
- **FR-005**: Each staged script MUST exit non-zero when its selector matches a file that carries no leading tag block (the per-script untagged-but-matched runtime guard), distinct from Feature 1's whole-repo coverage lint.
- **FR-006**: The staged scripts MUST be reachable only through `npm run` / `npm test` entrypoints in documented and CI usage; CI MUST NOT invoke `npx vitest` or any equivalent direct tool command.
- **FR-007**: `.github/workflows/ci.yml` MUST be restructured so an `l0` job runs first as a fail-fast gate, and `l1`, `l2-cassette`, and `l3-cassette` fan out in parallel only after `l0` succeeds, each job running only its corresponding `npm run test:*` script.
- **FR-008**: CI MUST preserve the existing Node 20/22 build matrix for the staged jobs unless a later feature explicitly changes the matrix.
- **FR-009**: The four staged scripts MUST exclude the stable `tests/quarantine/` directory-path contract owned by Feature 3.
- **FR-010**: The M1 staged pipeline MUST NOT require live Docker services, Hatchery, Brood, Herald, Castra, Legate, network calls, paid model calls, or cassette refresh.
- **FR-011**: `CONTRIBUTING.md` MUST document the staged npm commands and their layer coverage, and the Pre-Release Checklist's `npm test` step MUST be kept current with the rebuilt alias.
- **FR-012**: This feature MUST NOT implement the whole-repo coverage lint (Feature 1), quarantine routing (Feature 3), the scheduled stochastic workflow (M6), any cassette runtime (M3+), or test-layer migration policy (Feature 4).

### Key Entities

- **Layered Test Script**: An npm script that runs one deterministic CI scope selected by the test tag tuple, excluding quarantine.
- **Aggregate Deterministic Gate**: The rebuilt `npm test` that runs the four staged scripts sequentially, failing fast on the first failure.
- **Staged CI Job**: A named CI job (`l0` gate, then parallel `l1`/`l2-cassette`/`l3-cassette`) whose failure points to one specific layer.
- **Tag-Based Selector**: The per-script selection behavior — realized as the `selector` and `untaggedGuard` fields of the Layered Test Script in the data model, not a separately stored entity — that maps Feature 1 tag blocks to layer-specific execution and fails on an untagged-but-matched file.

## Assumptions

- Feature 1's tag taxonomy and coverage lint have landed before this feature is implemented (feature-map dependency F2 → F1).
- Feature 3's `tests/quarantine/` directory-path exclusion contract is available for the staged scripts to consume (feature-map dependency F2 → F3).
- The existing vitest framework remains the M1 execution framework for deterministic L0/L1 and the currently governed L2-shaped tests; the `l2-cassette`/`l3-cassette` scripts run whatever is tagged today, with no cassette substrate in M1.
- Separate CI jobs are required for legibility even if the underlying implementation reuses a shared test-runner helper.
- This staged pipeline supports March's `docs/vision.md` and `docs/operating-philosophy.md` principles by replacing manual failure archaeology with deterministic, non-interactive, per-layer pass/fail jobs.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Empty-layer behavior is not pinned by the feature map or RFC. A layer with zero matching tests must exit cleanly with explicit behavior, but the choice between "pass with no files" and "fail if a delivered layer unexpectedly has no tests" is left to task slicing. | Edge Cases | Low | Medium | open | — |

## Out of Scope

- Changing the tag vocabulary or adding tag blocks to tests (Feature 1).
- The whole-repo coverage lint that fails on untagged files (Feature 1).
- Porting any vitest test to Cucumber.js (M3+, Feature 4 policy).
- Adding quarantine directories, quarantine routing, or flaky-test parking policy (Feature 3).
- Adding the scheduled stochastic workflow, live backend runs, cassette refresh, or paid model calls (M6 / M3+).
- Revisiting the gating shape (L0-only vs. L0+L1, RFC SD-006) — resolves after M3 measures Cucumber-vs-vitest parallelism.
- Changing runtime March subsystem behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Contributors can run deterministic L0, L1, L2 cassette, and L3 cassette gates through documented npm scripts.
- **SC-002**: `npm test` runs the four staged scripts sequentially, fails fast on the first failing layer, and builds at most once.
- **SC-003**: CI failures identify `l0`, `l1`, `l2-cassette`, or `l3-cassette` off the pipeline graph, with `l0` gating the parallel fan-out, without reading a monolithic log.
- **SC-004**: Test selection follows Feature 1 tag blocks rather than duplicated path-only classification, and a matched-but-untagged file fails its script.
- **SC-005**: The staged pipeline remains non-interactive, deterministic, and free of live-service or paid-call dependencies across the preserved Node 20/22 matrix.
