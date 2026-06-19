# Feature Specification: Quarantine Routing Scaffold

**Spec Folder**: `2026-06-03-007-quarantine-routing-scaffold`
**Branch**: `feature/smithy/mark/layered-testing-framework-m1-f3`
**Created**: 2026-06-03
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` Feature 3, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/01-test-legibility-staged-ci.features.md` — Feature 3: Quarantine Routing Scaffold

## Clarifications

### Session 2026-06-03

- This feature is the **M1 quarantine scaffold only**: a `tests/quarantine/` directory, a routing primitive that parks a failing test there without deleting it, a directory-path exclusion contract the staged scripts consume, and a generated `tests/quarantine/INDEX.md` roster. The one-week SLA timer, overdue alerts, and weekly-report wiring are M6 and explicitly out of scope. [Critical Assumption]
- The exclusion mechanism is **directory-path based**, not tag based: a test is quarantined by virtue of living under `tests/quarantine/`, and the four staged scripts (Feature 2) exclude that path. Tag taxonomy (Feature 1) classifies a test's layer/determinism/channel; it does not decide quarantine membership.
- Quarantine is a **visible state, not a hiding place** (RFC §Design Considerations): parking a test must be cheap, but the parked test is never silenced — it remains in the repository and visible on the generated roster.
- The **source-tree location of the routing primitive** (`src/testing/` vs. `tests/support/` vs. co-located under `tests/quarantine/`) is the open decision tracked locally as SD-001 (inherited from feature-map SD-101) and is left to implementation; the `tests/quarantine/` directory path itself is pinned by the RFC M1 criteria and is the stable contract Feature 2 consumes (per SD-002, inherited from feature-map SD-103, the directory-path contract is independent of the primitive's source location).
- All routing operations are **non-interactive** (operating-philosophy rule 1): parking and restoring a test, and regenerating the index, run from a single non-interactive command with no TTY-bound prompt.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Park a Failing Test Without Deleting It (Priority: P1)

As the Operator, I want a routing primitive that moves a known-bad test into `tests/quarantine/` without deleting it, so that I can take an unstable test out of the staged gate while keeping its coverage visible.

**Why this priority**: Quarantine routing is the M1 scaffold the rest of the testing framework leans on — Feature 2's staged scripts need a parked-test surface to exclude, and M6's SLA timer needs a roster to clock. Nothing downstream can land until parking exists.

**Independent Test**: Invoke the routing primitive against a test file and verify the file now lives under `tests/quarantine/`, its original test code is preserved unchanged, and it is no longer in its prior location — with no interactive prompt required.

**Acceptance Scenarios**:

1. **Given** a deterministic test that has begun failing, **When** the Operator routes it to quarantine, **Then** the test file is relocated under `tests/quarantine/` and its test body is preserved verbatim.
2. **Given** a test is being quarantined, **When** the routing primitive runs, **Then** it completes non-interactively (no `y/N` prompt) and exits zero on success.
3. **Given** a quarantined test, **When** the Operator inspects the repository, **Then** the test still exists in the tree and has not been skipped, deleted, or commented out.

---

### User Story 2: Exclude Quarantined Tests From the Staged Gate (Priority: P1)

As the CI Failure Triager, I want quarantined tests excluded from the four staged scripts via a stable directory-path contract, so that a parked unstable test cannot keep blocking every PR.

**Why this priority**: The point of parking a test is to get it out of the deterministic gate. Feature 2's `test:l0`/`test:l1`/`test:l2-cassette`/`test:l3-cassette` scripts consume this feature's exclusion contract; without it, quarantine would not actually remove the test from the gate.

**Independent Test**: Define the directory-path exclusion contract and verify that a test placed under `tests/quarantine/` is not selected by any of the four staged scripts, while a non-quarantined test in the same scope still runs.

**Acceptance Scenarios**:

1. **Given** a test under `tests/quarantine/`, **When** the staged scripts select tests, **Then** the quarantined test is excluded from all four scripts.
2. **Given** the exclusion contract, **When** Feature 2's scripts consume it, **Then** the contract is expressed as a stable repo-relative directory path (`tests/quarantine/`), not as a tag predicate.
3. **Given** a non-quarantined test in the same layer as a quarantined one, **When** the staged scripts run, **Then** the non-quarantined test is still selected and executed.

---

### User Story 3: List Quarantined Tests in a Generated Roster (Priority: P1)

As the Cassette Refresher, I want quarantined tests listed in a generated `tests/quarantine/INDEX.md`, so that the parked tests are a visible surface that the M6 SLA timer and refresh workflow can later read.

**Why this priority**: Visibility is the commitment that keeps quarantine from becoming a silent dumping ground. The generated roster is the surface future milestones (M6 SLA clock) read; it must exist in M1 so quarantine is observable from day one.

**Independent Test**: Park one or more tests, regenerate the index, and verify `tests/quarantine/INDEX.md` lists exactly the quarantined test files; remove a parked test and verify regeneration drops it.

**Acceptance Scenarios**:

1. **Given** one or more quarantined tests, **When** the index is generated, **Then** `tests/quarantine/INDEX.md` lists each quarantined test file by repo-relative path.
2. **Given** the quarantine directory contents change, **When** the index is regenerated, **Then** `INDEX.md` reflects the current contents with no stale or missing entries.
3. **Given** an empty quarantine directory, **When** the index is generated, **Then** `INDEX.md` is produced and reports that no tests are quarantined.

---

### User Story 4: Document the Quarantine Primitive for Contributors (Priority: P2)

As the Operator, I want `CONTRIBUTING.md` to describe the quarantine routing primitive, so that any contributor can park a known-bad test the documented way instead of silencing it ad hoc.

**Why this priority**: M1 keeps operator documentation current as each feature lands rather than deferring it. The primitive is only useful if contributors can find how to invoke it; this is supporting documentation, not a blocking deliverable for the routing mechanics themselves.

**Independent Test**: Read `CONTRIBUTING.md` and verify it references the `tests/quarantine/` directory and the routing primitive, including how to park a test and that parked tests remain visible rather than silenced.

**Acceptance Scenarios**:

1. **Given** a contributor reading `CONTRIBUTING.md`, **When** they look for how to handle a failing unstable test, **Then** they find the quarantine routing primitive and the `tests/quarantine/` location described.
2. **Given** the documentation, **When** a contributor follows it, **Then** they can park a test without reading the routing implementation.
3. **Given** the documentation, **When** a contributor reads the quarantine section, **Then** it states that quarantine is a visible state with the SLA wiring deferred to M6.

### Edge Cases

- A test moved into `tests/quarantine/` that already carries a Feature 1 tag tuple keeps it — the tags travel with the file unchanged. A test parked before Feature 1 has tagged the repo is still valid; F3 does not require tags.
- The index is regenerated when quarantine contents change so the roster cannot drift from the directory.
- An empty `tests/quarantine/` directory still produces a valid `INDEX.md`.
- A quarantined test path overlaps a staged script's selection glob — the directory-path exclusion must take precedence so the parked test is not selected.
- A test is restored out of quarantine (the reverse of parking) and disappears from the next generated index.
- The routing primitive is invoked on a path that is not a test file, or on a test already quarantined — it must fail or no-op deterministically rather than hang.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Park a Failing Test Without Deleting It | — | specs/2026-06-03-007-quarantine-routing-scaffold/01-park-failing-test-without-deleting-it.tasks.md |
| US2 | Exclude Quarantined Tests From the Staged Gate | US1 | specs/2026-06-03-007-quarantine-routing-scaffold/02-exclude-quarantined-tests-from-the-staged-gate.tasks.md |
| US3 | List Quarantined Tests in a Generated Roster | US1 | — |
| US4 | Document the Quarantine Primitive for Contributors | US1 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A `tests/quarantine/` directory MUST exist as the canonical location for tests parked out of the staged gate.
- **FR-002**: A routing primitive (`quarantine.ts` or equivalent) MUST move a test into `tests/quarantine/` without deleting or rewriting the test's assertions.
- **FR-003**: A quarantined test MUST remain present in the repository and MUST NOT be skipped, commented out, or otherwise silenced.
- **FR-004**: Quarantined tests MUST be excluded from all four staged scripts (`test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette`).
- **FR-005**: The exclusion MUST be expressed as a stable directory-path contract (`tests/quarantine/`) that Feature 2's staged scripts consume, independent of the tag taxonomy.
- **FR-006**: A `tests/quarantine/INDEX.md` MUST be generated to list the currently quarantined test files, recording each test's quarantined path and its origin path.
- **FR-006a**: The routing primitive MUST record each parked test's origin path at park time (and surface it in `INDEX.md`) so a test can be restored to its exact prior location deterministically, without guessing.
- **FR-007**: `INDEX.md` MUST be regenerated from the directory contents so the roster cannot drift from what is actually quarantined.
- **FR-008**: The routing primitive and index generation MUST run non-interactively (no TTY-bound confirmation), per operating-philosophy rule 1.
- **FR-009**: `CONTRIBUTING.md` MUST reference the `tests/quarantine/` directory and the quarantine routing primitive, including how to park a test.
- **FR-010**: This feature MUST NOT implement the one-week SLA timer, overdue alerts, or weekly-report wiring — those are M6.
- **FR-011**: This feature MUST NOT author new stochastic or scheduled tests, restructure existing tests, or define the staged scripts themselves (Feature 2 owns the scripts).

### Key Entities

- **Quarantine Directory**: The `tests/quarantine/` location that holds parked tests; membership in it is the definition of "quarantined".
- **Quarantine Routing Primitive**: The `quarantine.ts`-or-equivalent logic that parks a test into (and restores it out of) the quarantine directory.
- **Quarantined Test**: A `*.test.ts` file residing under `tests/quarantine/`, preserved intact and excluded from the staged gate.
- **Quarantine Index**: The generated `tests/quarantine/INDEX.md` roster of currently quarantined tests.
- **Directory-Path Exclusion Contract**: The stable `tests/quarantine/` path that Feature 2's staged scripts read to exclude parked tests.

## Assumptions

- F3 is independent of Feature 1 (the feature map specs them in parallel); if a parked test already carries a Feature 1 tag tuple it is preserved, but F3 neither requires nor validates tags.
- Feature 2's staged scripts consume this feature's directory-path exclusion contract; this feature defines the path, Feature 2 wires the exclusion into the scripts.
- The RFC pins the `tests/quarantine/` directory path and the generated `tests/quarantine/INDEX.md`; only the routing primitive's source-tree location is open (SD-001, inherited from feature-map SD-101).
- Quarantine is temporary by policy; M1 provides the scaffold and visible roster, and M6 adds the SLA clock that enforces resolution.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Inherited SD-101 (feature map): does the routing primitive's source live in `src/testing/` (production code, operator-CLI growth path) or in test-only code (`tests/support/` / co-located under `tests/quarantine/`)? The RFC pins the `tests/quarantine/` directory but does not pin where the `quarantine.ts` logic lives; the choice changes which source tree this feature writes into. | clarify:Constraints | Medium | Medium | open | — |
| SD-002 | Inherited SD-103 (feature map): make explicit that SD-101 blocks only the routing logic's source-tree location, not all of Feature 3 — the `tests/quarantine/` directory-path contract Feature 2 consumes is pinned by the RFC and is independent of the open location question. | plan-review:Logical gap | Important | Low | open | — |

## Out of Scope

- The one-week quarantine SLA timer, overdue alerts, and weekly stochastic-suite report wiring (all M6).
- Defining the four staged npm scripts and the CI fan-out (Feature 2).
- The tag taxonomy and whole-repo coverage lint (Feature 1).
- Authoring any new stochastic or scheduled tests, or any cassette runtime.
- Pinning the source-tree location of the routing primitive (SD-001, inherited from feature-map SD-101).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An Operator can park a failing test under `tests/quarantine/` with a single non-interactive command, without deleting it.
- **SC-002**: A test under `tests/quarantine/` is excluded from all four staged scripts while non-quarantined tests in the same layer still run.
- **SC-003**: `tests/quarantine/INDEX.md` lists exactly the currently quarantined tests and is regenerated when the directory changes.
- **SC-004**: A contributor can find, in `CONTRIBUTING.md`, how to park a test and that quarantine is a visible state rather than a silence.
- **SC-005**: No quarantined test is skipped or deleted; every parked test remains in the repository and on the roster.
