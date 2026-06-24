# Tasks: List Quarantined Tests In A Generated Roster

**Source**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.spec.md` — User Story 3
**Data Model**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.data-model.md`
**Contracts**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.contracts.md`
**Story Number**: 03

---

## Slice 1: Generate The Quarantine Index
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Generate `tests/quarantine/INDEX.md` from the current quarantine directory contents so every parked test is visible with its quarantined path and recorded origin path.

**Justification**: This slice stands alone because, once merged, the quarantine directory has a deterministic roster surface that Operators can inspect and future M6 SLA/reporting work can read without adding the SLA clock itself.

**Addresses**: FR-006, FR-006a, FR-007, FR-008; Acceptance Scenario 3.1, Acceptance Scenario 3.2, Acceptance Scenario 3.3

### Tasks

- [x] **Generate the quarantine roster**

  Extend the existing quarantine routing surface so index generation rewrites `tests/quarantine/INDEX.md` from the current set of quarantined `*.test.ts` files and their recorded origins. The generation path should be non-interactive, should keep the roster derived from filesystem state rather than hand-authored content, and should avoid adding staged-script, contributor-doc, restore, or M6 SLA behavior.

  _Acceptance criteria:_
  - `tests/quarantine/INDEX.md` is produced by the quarantine workflow.
  - Each currently quarantined `*.test.ts` file is listed by repo-relative quarantined path.
  - Each listed file includes the origin path recorded when the test was parked.
  - Regenerating after quarantine contents change removes stale rows and adds new rows.
  - An empty quarantine directory still produces an index that clearly reports no quarantined tests.
  - Index generation completes from a repository command or park-time workflow with no TTY-bound prompt.
  - Focused tests cover populated, changed, and empty quarantine-directory states without introducing SLA timers or weekly-report wiring.

**PR Outcome**: `tests/quarantine/INDEX.md` is a generated, current roster of parked tests and their origin paths, including the empty-quarantine case.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Inherited SD-101 (feature map): does the routing primitive's source live in `src/testing/` (production code, operator-CLI growth path) or in test-only code (`tests/support/` / co-located under `tests/quarantine/`)? The RFC pins the `tests/quarantine/` directory but does not pin where the `quarantine.ts` logic lives; the choice changes which source tree this feature writes into. | clarify:Constraints | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Inherited SD-103 (feature map): make explicit that SD-101 blocks only the routing logic's source-tree location, not all of Feature 3 — the `tests/quarantine/` directory-path contract Feature 2 consumes is pinned by the RFC and is independent of the open location question. | plan-review:Logical gap | Important | Low | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Generate The Quarantine Index | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Park a Failing Test Without Deleting It | depends on | This story consumes the quarantine directory and origin-path records created by parking. |
| User Story 2: Exclude Quarantined Tests From the Staged Gate | depends on | This story can assume parked tests already leave the staged gate while the roster keeps them visible. |
| User Story 4: Document the Quarantine Primitive for Contributors | depended upon by | Contributor documentation can describe the generated roster after this story makes `INDEX.md` available. |
