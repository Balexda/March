# Tasks: Document The Quarantine Primitive For Contributors

**Source**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.spec.md` — User Story 4
**Data Model**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.data-model.md`
**Contracts**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.contracts.md`
**Story Number**: 04

---

## Slice 1: Document Contributor Quarantine Routing
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `CONTRIBUTING.md` explains when and how contributors use the quarantine routing primitive, where parked tests live, and why quarantine remains visible rather than silent.

**Justification**: This slice stands alone because, once merged, contributors can follow the documented quarantine workflow without reading the routing implementation, while the already-delivered primitive, exclusion, and roster remain owned by their prior stories.

**Addresses**: FR-009, FR-010; Acceptance Scenario 4.1, Acceptance Scenario 4.2, Acceptance Scenario 4.3

### Tasks

- [ ] **Document the quarantine workflow**

  Update `CONTRIBUTING.md` with a contributor-facing quarantine section that references the Quarantine Documentation contract and satisfies AS 4.1-AS 4.3. The section should describe the routing primitive, `tests/quarantine/`, how to park a known-bad test, the generated roster surface, and the M6 boundary without adding routing, staged-script, index, or SLA behavior.

  _Acceptance criteria:_
  - `CONTRIBUTING.md` names the quarantine routing primitive and the `tests/quarantine/` directory.
  - A contributor can park a test by following the documented command/workflow without reading implementation code.
  - The documentation states that quarantined tests remain visible in the repository and roster rather than being skipped, deleted, or silenced.
  - The documentation states that one-week SLA, overdue alert, and weekly-report wiring are deferred to M6.
  - The guidance stays aligned with the existing primitive and does not introduce a second ad hoc quarantine path.

**PR Outcome**: Contributors can find the documented quarantine workflow in `CONTRIBUTING.md`, including how to park a known-bad test and why parked tests remain visible until later M6 SLA automation lands.

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
| S1 | Document Contributor Quarantine Routing | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Park a Failing Test Without Deleting It | depends on | This story documents the primitive and command delivered by parking. |
| User Story 2: Exclude Quarantined Tests From the Staged Gate | depends on | This story can describe the staged-gate effect after the exclusion contract exists. |
| User Story 3: List Quarantined Tests in a Generated Roster | depends on | This story can describe the visible roster after `INDEX.md` generation exists. |
