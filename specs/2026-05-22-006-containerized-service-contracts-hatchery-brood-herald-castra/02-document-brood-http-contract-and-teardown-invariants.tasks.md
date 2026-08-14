# Tasks: Document Brood HTTP Contract and Teardown Invariants

**Source**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.spec.md` — User Story 2
**Data Model**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.data-model.md`
**Contracts**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.contracts.md`
**Story Number**: 02

---

## Slice 1: Author Brood Service Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `docs/subsystems/brood/contract.md` as a complete, testable documentation contract for Brood's managed-session registry and teardown lifecycle surface.

**Justification**: This slice is a standalone working increment because lifecycle clients, cleanup tooling, and L2 tests can assert Brood's registry routes, lifecycle envelopes, destructive cleanup ordering, and deferral behavior from one contract without waiting for other service contracts.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-007, FR-008, FR-009, FR-010, FR-016; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [ ] **Author the Brood HTTP contract**

  Create `docs/subsystems/brood/contract.md` using the service-contract structure from the data model, the Brood route surface from the contracts artifact, and the current route behavior in `src/brood/service/`. Keep the AUTOGEN region empty, document only Brood's existing HTTP boundary and teardown invariant, and satisfy AS 2.1-2.3 without adding runtime service behavior.

  _Acceptance criteria:_
  - Contract contains exactly `## Public Interface`, `## Invariants`, and `## Error Modes`
  - `## Public Interface` contains an empty AUTOGEN marker pair
  - Health, readiness, session registration, listing, lookup, update, and teardown routes are documented
  - Each route includes method, path, request envelope, response envelope, and visible status or error behavior
  - Session registration documents accepted kinds, lifecycle statuses, path rules, branch rules, and response record shape
  - Listing, lookup, update, and teardown document filters, mutable fields, request options, result envelopes, and idempotent teardown behavior
  - Invariants state the ordered cleanup sequence, exact tracked worktree and branch guarantees, and the never-`git worktree prune` rule
  - Error modes state validation, not-found, forced-teardown conflict, teardown-step failure, and steward-removal deferral behavior

**PR Outcome**: Brood's HTTP contract exists as a stable documentation target for managed-session registration, lifecycle inspection, safe teardown ordering, deferral behavior, and future AUTOGEN extraction.

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
| S1 | Author Brood Service Contract | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Story | Direction | Reason |
|-------|-----------|--------|
| US4 | depends on | Brood's teardown contract depends on Castra's steward-removal route semantics being documented first. |
