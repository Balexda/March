# Tasks: Document Brood HTTP Contract and Teardown Invariants

**Source**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.spec.md` — User Story 2
**Data Model**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.data-model.md`
**Contracts**: `specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/containerized-service-contracts-hatchery-brood-herald-castra.contracts.md`
**Story Number**: 02

---

## Slice 1: Author Brood Service Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `docs/subsystems/brood/contract.md` as a complete, testable documentation contract for Brood's managed-session registry and teardown lifecycle surface.

**Justification**: This slice is a standalone working increment because lifecycle clients, cleanup tooling, and L2 tests can assert Brood's registry routes, lifecycle envelopes, destructive cleanup ordering, and deferral behavior from this one contract. Its single upstream dependency — US4's Castra contract, which pins the steward-removal semantics the teardown invariant cites — is already merged, so nothing else must land first; the Herald and Steward contracts are not prerequisites.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-007, FR-008, FR-009, FR-010, FR-016; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [x] **Author the Brood HTTP contract**

  Create `docs/subsystems/brood/contract.md` using the service-contract structure from the data model, the Brood route surface from the contracts artifact, and the current route behavior in `src/brood/service/`. Keep the AUTOGEN region empty, document only Brood's existing HTTP boundary and teardown invariant, and satisfy AS 2.1-2.3 without adding runtime service behavior.

  _Acceptance criteria:_
  - Contract contains exactly `## Public Interface`, `## Invariants`, and `## Error Modes`
  - `## Public Interface` contains an empty AUTOGEN marker pair
  - Health, readiness, session registration, listing, lookup, update, and teardown routes are documented
  - The two routes registered in `src/brood/service/routes.ts` beyond FR-007's enumeration — `GET /sessions/:id/extraction-readiness` and the admin-token-gated `POST /admin/sweep` — are documented too, so the contract covers Brood's whole HTTP surface per FR-003 (see SD-001)
  - Each route includes method, path, request envelope, response envelope, and visible status or error behavior
  - Session registration documents accepted kinds, lifecycle statuses, path rules, branch rules, and response record shape
  - Listing, lookup, update, and teardown document filters, mutable fields, request options, result envelopes, and idempotent teardown behavior
  - The teardown `kill` option is documented to match current source: `kill: true` skips the graceful stop and requests forced compute removal after the archive, while force admission still applies (see SD-002). The baseline (`9910481`) accepted-but-ignored behavior is noted as history
  - Invariants state the ordered cleanup sequence, exact tracked worktree and branch guarantees, and the never-`git worktree prune` rule
  - Error modes state validation, not-found, forced-teardown conflict, teardown-step failure, and steward-removal deferral behavior

**PR Outcome**: Brood's HTTP contract exists as a stable documentation target for managed-session registration, lifecycle inspection, safe teardown ordering, deferral behavior, and future AUTOGEN extraction.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Route-surface drift: FR-007 and the contracts artifact's Brood `Signature` block enumerate seven routes, but `src/brood/service/routes.ts` registers nine — it also serves `GET /sessions/:id/extraction-readiness` (routes.ts:329) and the admin-token-gated `POST /admin/sweep` (routes.ts:395, the `march brood sweep` backend). FR-003 requires the contract to document the subsystem's route surface, which is the source's nine, so documenting only the enumerated seven would ship a contract that is incomplete on the day it lands. Resolved for this slice in favor of source: the acceptance criteria require both extra routes. The spec's FR-007 and the contracts artifact still under-enumerate and should be re-marked when F2 is next revised. | Specification Drift | Medium | High | open | — |
| SD-002 | Teardown `kill` wording drift: the contracts artifact documents `POST /sessions/:id/teardown.body.kill` as "Requests immediate container kill". At commit `9910481`, `kill` was accepted but ignored. Since then, lifecycle teardown has implemented it: `teardownSession` (`src/brood/service/teardown.ts`) skips the graceful `stop` step when `kill` is true and requests forced compute removal after the archive. Force admission still applies independently. Resolved for this slice in favor of current source: the contract documents the skip-stop behavior and notes the baseline history. Still open: the contracts artifact's "immediate container kill" wording overstates the behavior, because removal still waits for the archive. Correct it when F2 is next revised. | Specification Drift | Medium | High | open | — |

Both items were raised in review of PR #534 and verified against source at commit `9910481`. SD-002 was re-verified against current source in review of PR #718. Neither blocks this cut: each is resolved for the forge slice by an acceptance criterion above, and each is recorded so the underlying spec/artifact drift is not silently absorbed.

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
