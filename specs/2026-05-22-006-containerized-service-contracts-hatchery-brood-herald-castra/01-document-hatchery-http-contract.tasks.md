# Tasks: Document Hatchery HTTP Contract

**Source**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.spec.md` — User Story 1
**Data Model**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.data-model.md`
**Contracts**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.contracts.md`
**Story Number**: 01

---

## Slice 1: Author Hatchery Service Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `docs/subsystems/hatchery/contract.md` as a complete, testable documentation contract for Hatchery's spawn-job HTTP surface.

**Justification**: This slice is a standalone working increment because L2 tests and future freshness checks can assert the Hatchery service boundary from the documented route, envelope, readiness, and error promises without waiting for the other service contracts.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-016; Acceptance Scenarios 1.1, 1.2, 1.3

### Tasks

- [x] **Author the Hatchery HTTP contract**

  Create `docs/subsystems/hatchery/contract.md` using the service-contract structure from the data model and the Hatchery route surface from the contracts artifact. Keep the AUTOGEN region empty, document only Hatchery's existing HTTP boundary, and satisfy AS 1.1-1.3 without adding runtime service behavior.

  _Acceptance criteria:_
  - Contract contains exactly `## Public Interface`, `## Invariants`, and `## Error Modes`
  - `## Public Interface` contains an empty AUTOGEN marker pair
  - Health, readiness, spawn submission, and spawn lookup routes are documented
  - Each route includes method, path, request envelope, response envelope, and visible status or error behavior
  - Spawn submission documents required and optional request fields from the Hatchery service contract
  - Validation errors cover missing prompt, missing backend, unknown backend, and missing repo path
  - Readiness documents dependency fields and 200/503 behavior

**PR Outcome**: Hatchery's HTTP contract exists as a stable documentation target for spawn submission, spawn polling, readiness gating, validation errors, and future AUTOGEN extraction.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None — all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Author Hatchery Service Contract | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

None — this story is self-contained.
