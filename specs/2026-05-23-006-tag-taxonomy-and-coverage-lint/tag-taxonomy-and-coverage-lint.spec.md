# Feature Specification: Tag Taxonomy & Coverage Lint

**Spec Folder**: `2026-05-23-006-tag-taxonomy-and-coverage-lint`
**Branch**: `feature/smithy/mark/layered-testing-framework-m1-f1`
**Created**: 2026-05-23
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` Feature 1, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` - Feature 1: Tag Taxonomy & Coverage Lint

## Clarifications

### Session 2026-05-23

- The coverage lint is one cohesive check for all three required tag positions: scope, determinism, and execution channel. This resolves SD-102 in favor of a single deliverable rather than three independent lints.
- Tags are declared in each test file's leading comment block so the convention is visible before any imports or test definitions.
- The three existing vitest files identified by the RFC as L2-shaped are tagged in place as `@l2 @deterministic @ci`, while preserving their current mocks and without porting them to Cucumber.js.
- This feature updates operator documentation only where it describes the tag taxonomy, day-one test disposition, and strategic testing split. It does not introduce staged npm scripts, quarantine routing, or runtime tag guards.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Declare the Frozen Test Tag Vocabulary (Priority: P1)

As the Operator-as-Test-Author, I want every vitest test file to declare its scope, determinism, and execution channel in one predictable place so that I can classify a test without re-deriving the taxonomy from surrounding code.

**Why this priority**: The layered testing RFC makes the tag vocabulary the schema that later scripts, CI jobs, quarantine routing, and contract freshness checks consume. The vocabulary must be explicit before the staged pipeline can filter on it.

**Independent Test**: Inspect representative `*.test.ts` files and verify that each file begins with a tag block containing exactly one scope tag, one determinism tag, and one execution-channel tag.

**Acceptance Scenarios**:

1. **Given** a Test Author opens any vitest `*.test.ts` file, **When** they read the leading comment block, **Then** they can identify the file's scope as exactly one of `@l0`, `@l1`, `@l2`, or `@l3`.
2. **Given** a Test Author opens any vitest `*.test.ts` file, **When** they read the leading comment block, **Then** they can identify determinism as exactly one of `@deterministic` or `@stochastic`.
3. **Given** a Test Author opens any vitest `*.test.ts` file, **When** they read the leading comment block, **Then** they can identify execution channel as exactly one of `@ci` or `@scheduled`.

---

### User Story 2: Fail Loudly on Untagged or Mis-tagged Test Files (Priority: P1)

As the CI Failure Triager, I want a whole-repo lint to fail with specific file-level diagnostics when a test file is untagged or has conflicting tags so that miscategorized tests cannot silently enter the suite.

**Why this priority**: The RFC's staged CI plan depends on every test carrying a complete tag tuple. If coverage linting lands later or only checks one axis, the staged scripts can produce misleading green builds.

**Independent Test**: Add temporary bad fixtures or invoke the lint against controlled file contents and verify that missing, duplicate, and conflicting tag positions produce non-zero exit codes with the offending path and missing or invalid axis named.

**Acceptance Scenarios**:

1. **Given** a `*.test.ts` file has no tag block, **When** the coverage lint runs, **Then** it exits non-zero and names the file plus all missing axes.
2. **Given** a `*.test.ts` file declares two scope tags, **When** the coverage lint runs, **Then** it exits non-zero and reports the conflicting scope axis.
3. **Given** all `*.test.ts` files declare exactly one tag from each required axis, **When** the coverage lint runs, **Then** it exits zero without rewriting files.

---

### User Story 3: Preserve Existing Test Scope While Tagging the Baseline (Priority: P1)

As the Operator-as-Test-Author, I want existing tests tagged in place without restructuring so that M1 records the baseline classification without changing what any test exercises.

**Why this priority**: The RFC explicitly says existing L0 and L1 tests are tagged in place, and the three pre-existing L2-shaped vitest tests remain vitest until a later material change. This feature must not smuggle in a migration.

**Independent Test**: Review the patch and verify that every existing `*.test.ts` receives a tag block while test imports, test bodies, mocks, and assertions remain behaviorally unchanged.

**Acceptance Scenarios**:

1. **Given** an existing unit-style test file, **When** this feature lands, **Then** it is tagged `@l0 @deterministic @ci` unless the spec identifies a stronger subsystem boundary.
2. **Given** an existing single-subsystem test file, **When** this feature lands, **Then** it is tagged `@l1 @deterministic @ci`.
3. **Given** `src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`, or `src/hatchery/legate-container.test.ts`, **When** this feature lands, **Then** it is tagged `@l2 @deterministic @ci` in place and continues to mock `node:child_process` without exercising real Docker.

---

### User Story 4: Keep Operator Documentation Aligned With the New Taxonomy (Priority: P2)

As the Operator, I want `CONTRIBUTING.md` and `docs/testing-strategy.md` to reflect the tag convention and corrected baseline so that day-to-day guidance does not contradict the staged testing RFC.

**Why this priority**: Feature 1 owns the one-time documentation correction for the tag taxonomy and the existing L2-shaped tests. If the docs keep saying those tests exercise real Docker, future migration decisions start from a false premise.

**Independent Test**: Read the changed documentation and verify it describes the tag tuple, records the three pre-existing L2-shaped vitest tests as mocked child-process tests, and leaves staged script commands to Feature 2.

**Acceptance Scenarios**:

1. **Given** a contributor reads `CONTRIBUTING.md`, **When** they reach the testing section, **Then** they can find the required tag tuple convention for new test files.
2. **Given** a contributor reads the day-one test baseline, **When** they inspect the three L2-shaped vitest tests, **Then** the docs state that they mock `node:child_process` and do not exercise real Docker.
3. **Given** a contributor reads `docs/testing-strategy.md`, **When** they compare it to the RFC, **Then** the document stays strategic and delegates milestone-level tactics to the RFC and feature specs.

### Edge Cases

- A file contains a tag word in prose or a string literal but no leading tag block.
- A file includes parameterized tests, nested `describe` blocks, or helper functions before the first test definition.
- A test file is moved into a future quarantine directory; Feature 2 consumes the directory exclusion contract, not this lint.
- A future `@stochastic` or `@scheduled` test appears before M6; this lint validates the vocabulary but does not make those tests part of the PR gate.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Declare the Frozen Test Tag Vocabulary | — | — |
| US2 | Fail Loudly on Untagged or Mis-tagged Test Files | US1 | — |
| US3 | Preserve Existing Test Scope While Tagging the Baseline | US1, US2 | — |
| US4 | Keep Operator Documentation Aligned With the New Taxonomy | US1, US3 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every `*.test.ts` file MUST declare a leading tag block before imports.
- **FR-002**: The tag block MUST contain exactly one scope tag from `@l0`, `@l1`, `@l2`, and `@l3`.
- **FR-003**: The tag block MUST contain exactly one determinism tag from `@deterministic` and `@stochastic`.
- **FR-004**: The tag block MUST contain exactly one execution-channel tag from `@ci` and `@scheduled`.
- **FR-005**: The coverage lint MUST scan the whole repository for `*.test.ts` files outside the generated dependency directories — `node_modules/`, `dist/`, and `.git/`. This explicit set is the normative discovery-exclusion definition referenced by the data model and contracts.
- **FR-006**: The coverage lint MUST exit non-zero when a test file is missing any required axis.
- **FR-007**: The coverage lint MUST exit non-zero when a test file declares conflicting or duplicate tags for an axis.
- **FR-008**: Coverage-lint diagnostics MUST include the offending repo-relative path and the invalid or missing axis.
- **FR-009**: The coverage lint MUST be reachable through an `npm run` script so local and CI callers use the same entrypoint.
- **FR-010**: The existing test files MUST be tagged in place without changing test behavior, assertions, or framework.
- **FR-011**: `src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`, and `src/hatchery/legate-container.test.ts` MUST be tagged `@l2 @deterministic @ci`.
- **FR-012**: Documentation updates MUST correct the premise that the three existing L2-shaped vitest tests exercise real Docker; they mock `node:child_process` and remain vitest until Feature 4's material-change policy applies.
- **FR-013**: This feature MUST NOT add staged layer scripts, rewrite `.github/workflows/ci.yml`, add the per-script untagged-but-matched guard, create quarantine routing, port tests to Cucumber.js, or author stochastic/scheduled tests.

### Key Entities

- **Tag Block**: The leading comment block in a `*.test.ts` file that declares one tag from each required axis.
- **Scope Tag**: One of `@l0`, `@l1`, `@l2`, or `@l3`, identifying the boundary the file exercises.
- **Determinism Tag**: One of `@deterministic` or `@stochastic`, identifying whether assertions are replayable exactly or live-output tolerant.
- **Execution-Channel Tag**: One of `@ci` or `@scheduled`, identifying where the file is allowed to run unattended.
- **Coverage Lint**: The repository check that validates tag-block coverage and conflicts for every vitest test file.

## Assumptions

- All current `*.test.ts` files are deterministic CI tests.
- The current repository has no stochastic or scheduled tests; those tags are declared now for vocabulary completeness.
- The existing L2-shaped vitest tests are baseline classifications, not a signal to migrate them in this feature.
- The repo's `npm run` verification rule applies to the new lint entrypoint.

## Specification Debt

None. SD-102 is resolved by requiring one cohesive coverage lint for all three tag axes.

## Out of Scope

- Staged layer-specific npm scripts and CI fan-out.
- Runtime guards that detect a script matched untagged tests.
- Quarantine directory creation or routing behavior.
- Cucumber.js ports for existing L2-shaped vitest tests.
- Any stochastic or scheduled test implementation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every existing `*.test.ts` file has a complete tag tuple.
- **SC-002**: A repository lint fails when any `*.test.ts` file lacks one of the required tag axes.
- **SC-003**: The three existing L2-shaped vitest tests are tagged `@l2 @deterministic @ci` and documented as child-process-mocked tests.
- **SC-004**: Contributors can find the tag convention in `CONTRIBUTING.md`.
- **SC-005**: `docs/testing-strategy.md` remains strategic and points tactical sequencing to the RFC and specs.
