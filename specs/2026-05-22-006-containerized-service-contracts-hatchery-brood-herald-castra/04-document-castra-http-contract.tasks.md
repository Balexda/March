# Tasks: Document Castra HTTP Contract

**Source**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.spec.md` — User Story 4
**Data Model**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.data-model.md`
**Contracts**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.contracts.md`
**Story Number**: 04

---

## Slice 1: Author Castra Service Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `docs/subsystems/castra/contract.md` as a complete, testable documentation contract for Castra's HTTP API over agent-deck interactive sessions.

**Justification**: This slice is a standalone working increment because Hatchery, Herald, and L2 tests can assert the session-launch and session-driving boundary from the documented route, envelope, authentication, and error promises without waiting for Brood's teardown contract.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-013, FR-014, FR-015, FR-016; Acceptance Scenarios 4.1, 4.2, 4.3

### Tasks

- [x] **Author the Castra HTTP contract**

  Create `docs/subsystems/castra/contract.md` using the service-contract structure from the data model, the Castra route surface from the contracts artifact, and the current route behavior in `src/castra/`. Keep the AUTOGEN region empty, document only Castra's server-side HTTP boundary listed for US4, and satisfy AS 4.1-4.3 without adding runtime service behavior or documenting the Steward role contract.

  _Acceptance criteria:_
  - Contract contains exactly `## Public Interface`, `## Invariants`, and `## Error Modes`
  - `## Public Interface` contains an empty AUTOGEN marker pair
  - Open health and status routes are documented
  - Bearer-token-protected session list, launch, show, send, output, set, and remove routes are documented
  - Each documented route includes method, path, request envelope, response envelope, authentication behavior, and visible status or error behavior
  - Launch documents required `profile`, `repoPath`, `branch`, and `title` fields plus optional group, model, create-branch, and metadata fields
  - Session-driving routes document send prompt, output line bounds, allowed set keys, and remove options
  - Success envelopes document `CastraSession` fields and route-specific acknowledgements
  - Error modes document the uniform non-2xx envelope and mapped statuses for validation, authorization, missing sessions, conflicts, agent-deck failures, and internal failures
  - Adjacent recovery and Steward role behavior are left out of this US4 contract scope

**PR Outcome**: Castra's HTTP contract exists as a stable documentation target for session launch, session control, authentication, error handling, and future AUTOGEN extraction.

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
| S1 | Author Castra Service Contract | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Story | Direction | Reason |
|-------|-----------|--------|
| US2 | depended upon by | Brood's teardown contract depends on Castra's steward-removal route semantics being documented first. |
