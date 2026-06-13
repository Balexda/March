# Tasks: Park A Failing Test Without Deleting It

**Source**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.spec.md` — User Story 1
**Data Model**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.data-model.md`
**Contracts**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.contracts.md`
**Story Number**: 01

---

## Slice 1: Route Tests Into Quarantine
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver a non-interactive repository command and routing primitive that parks a `*.test.ts` file under `tests/quarantine/` while preserving the test body and recording its origin path.

**Justification**: This slice stands alone because, once merged, an Operator can remove a known-bad test from its prior location without deleting or silencing it; the later staged-script exclusion and generated roster stories can consume the parked-test surface.

**Addresses**: FR-001, FR-002, FR-003, FR-006a, FR-008; Acceptance Scenario 1.1, Acceptance Scenario 1.2, Acceptance Scenario 1.3

### Tasks

- [x] **Add the quarantine parking primitive**

  Add the repo-local routing primitive in the source location chosen during implementation under SD-001, and expose it through a single non-interactive repository command. The primitive should park a repo-relative `*.test.ts` file under `tests/quarantine/`, record the origin path at park time, and satisfy AS 1.1-1.3 without implementing staged-script exclusion, index generation, documentation, or M6 SLA behavior.

  _Acceptance criteria:_
  - `tests/quarantine/` exists as the canonical quarantine directory.
  - Parking a non-quarantined `*.test.ts` relocates it under `tests/quarantine/`.
  - The parked file's test body, assertions, imports, and existing tag block are preserved.
  - The file no longer remains at its prior non-quarantine path after parking.
  - The parked test's origin path is recorded at park time for deterministic restore.
  - Parking completes from one repository command with no TTY-bound prompt.
  - Invalid input and already-quarantined input finish deterministically without hanging.

**PR Outcome**: Operators can park a failing test under `tests/quarantine/` with one non-interactive command; the test remains present and unchanged apart from its location, and its origin path is retained for later restore/index work.

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
| S1 | Route Tests Into Quarantine | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Exclude Quarantined Tests From the Staged Gate | depended upon by | Staged scripts need the canonical `tests/quarantine/` location and parked-file behavior from this story before they can exclude quarantined tests. |
| User Story 3: List Quarantined Tests in a Generated Roster | depended upon by | The generated roster consumes the quarantine directory and origin-path record created when this story parks a test. |
| User Story 4: Document the Quarantine Primitive for Contributors | depended upon by | Contributor documentation can describe the command after the parking primitive exists. |
