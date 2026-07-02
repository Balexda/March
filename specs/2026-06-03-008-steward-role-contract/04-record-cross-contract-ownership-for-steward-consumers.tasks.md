# Tasks: Record Cross-Contract Ownership for Steward Consumers

**Source**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.spec.md` - User Story 4
**Data Model**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.data-model.md`
**Contracts**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.contracts.md`
**Story Number**: 04

---

## Slice 1: Steward Cross-Contract Ownership Boundary
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Extend `docs/subsystems/steward/contract.md` with explicit consumer/provider ownership boundaries and the Steward freshness binding hint after launch, patch-application, and lifecycle content are documented.

**Justification**: User Story 4 is documentation-only and all acceptance scenarios describe one maintainability boundary: Steward must own role semantics and PR-ready outcomes while naming other subsystems as providers without taking over their contracts. Splitting ownership boundaries from the source binding would leave freshness and L2-test readers unable to determine the complete non-overlapping Steward surface.

**Addresses**: FR-011, FR-012; Acceptance Scenarios 4.1, 4.2, 4.3.

### Tasks

- [ ] **Add provider ownership references**

  Update `docs/subsystems/steward/contract.md` to name Spawn, Hatchery, Brood, Herald, Castra, and Legate as provider or consumer boundaries for Steward. The prose should make Steward-owned role semantics, patch application, and PR-ready outcome promises distinct from each provider's contract, satisfying AS 4.1 and AS 4.2.

  _Acceptance criteria:_
  - The contract names Spawn, Hatchery, Brood, Herald, Castra, and Legate as cross-contract boundaries.
  - Spawn owns output validation while Steward owns application of validated output (AS 4.1).
  - Castra owns HTTP/session hosting and removal while Steward owns hosted role semantics (AS 4.2).
  - Hatchery, Brood, Herald, and Legate are described as integration boundaries without transferring their public surfaces to Steward.
  - Provider route tables, event append rules, loop rules, and Spawn validation internals are not duplicated.

- [ ] **Pin Steward freshness binding**

  Add contract prose that records Steward's future freshness source partition as `src/castra/client.ts` plus `src/hatchery/spawn-handoff.ts`, not a nonexistent `src/steward/` module. The same text should explicitly leave Castra server routes and Brood, Herald, and Legate service or loop surfaces to their owning Feature 2 and Feature 3 contracts under AS 4.3.

  _Acceptance criteria:_
  - The contract pins Steward freshness to `src/castra/client.ts` and `src/hatchery/spawn-handoff.ts` (AS 4.3).
  - The contract states that no standalone `src/steward/` source module owns Steward freshness.
  - Castra server route surfaces remain owned outside the Steward contract (AS 4.3).
  - Brood, Herald, and Legate service and loop surfaces remain owned by their respective contracts (AS 4.3).
  - No freshness checker, config enforcement, AUTOGEN generation, CI change, or runtime behavior is implemented.

- [ ] **Constrain cross-contract test expectations**

  Refine the Steward contract's invariants or error-mode notes so L2 tests can assert ownership boundaries without scraping provider-specific details. The update should preserve the story 1-3 launch, patch-application, lifecycle, cleanup, and clean-failure promises while adding only the ownership and non-duplication guarantees required by AS 4.1-AS 4.3.

  _Acceptance criteria:_
  - L2-test readers can identify Steward-owned role semantics, patch-application promises, and PR-ready outcome semantics from the contract.
  - The contract tells readers to follow provider contracts for Hatchery, Brood, Herald, Castra, Spawn, and Legate public interfaces.
  - Existing launch, application, lifecycle, cleanup, and error-mode promises remain intact.
  - The change introduces no contract checker, freshness glob update, runtime code, service route, PR creation, push, or merge behavior.

**PR Outcome**: The Steward contract names its consumer/provider ownership boundaries and future freshness source partition without duplicating Spawn, Hatchery, Brood, Herald, Castra, or Legate contracts. Contract maintainers and L2 tests can locate Steward-owned role semantics and avoid assigning freshness to a nonexistent standalone Steward module.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None - all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Steward Cross-Contract Ownership Boundary | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Document Steward Launch and Input Contract | depends on | US4 depends on the Steward contract artifact and launch boundary created by US1. |
| User Story 2: Document Patch Application and PR-Ready Outcome Contract | depends on | US4 distinguishes Steward-owned patch application and PR-ready outcome semantics from provider contracts after US2 records those promises. |
| User Story 3: Document Steward Lifecycle, Tracking, and Cleanup Boundaries | depends on | US4 names Brood, Herald, Castra, and Legate ownership boundaries after US3 records lifecycle, tracking, cleanup, loss, and timeout behavior. |
