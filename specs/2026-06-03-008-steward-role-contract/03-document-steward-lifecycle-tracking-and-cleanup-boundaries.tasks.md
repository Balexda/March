# Tasks: Document Steward Lifecycle, Tracking, and Cleanup Boundaries

**Source**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.spec.md` - User Story 3
**Data Model**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.data-model.md`
**Contracts**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.contracts.md`
**Story Number**: 03

---

## Slice 1: Steward Lifecycle Tracking and Cleanup Contract
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Extend `docs/subsystems/steward/contract.md` with Steward lifecycle correlation, observation, cleanup, and loss/timeout boundaries after the launch and patch-outcome contract content is in place.

**Justification**: User Story 3 is documentation-only and describes one externally testable lifecycle contract: a Steward session must be traceable from parent spawn through Brood, Herald, Castra, and Legate, then cleaned up without blocking on hidden interactive input. Splitting tracking, cleanup, and disappearance semantics would leave downstream tests unable to assert the complete stranded-session boundary, while implementing runtime registry, event, or teardown behavior would violate this feature's out-of-scope constraints.

**Addresses**: FR-008, FR-009, FR-010, FR-012; Acceptance Scenarios 3.1, 3.2, 3.3.

### Tasks

- [x] **Document publishable Steward correlation facts**

  Update the Steward contract's public interface and invariants to name the lifecycle facts that become observable when a Steward session launches. The prose should cover the Steward session id, parent spawn id, slice id, profile, branch, and worktree facts from AS 3.1 without moving ownership of Brood rows, Herald events, or Castra sessions into Steward.

  _Acceptance criteria:_
  - The contract states that Steward lifecycle tracking includes Steward session id, spawn id, slice id, profile, branch, and worktree facts (AS 3.1).
  - Brood registration is described as the lifecycle registry boundary for parent spawn and Steward session records (AS 3.1).
  - Herald `slice.steward.attached` is named as the correlation event boundary (AS 3.1).
  - Castra session identity remains the hosted interactive-session identity rather than Steward-owned route state.
  - No Hatchery, Brood, Herald, Castra, Spawn, Legate, PR, or runtime behavior is implemented.

- [x] **Define cleanup ownership boundaries**

  Extend the Steward contract with cleanup rules for requested Steward removal. The contract should state that Castra owns interactive-session removal while Brood owns exact tracked worktree and branch cleanup ordering, satisfying AS 3.2 without restating provider route tables or cleanup implementation details.

  _Acceptance criteria:_
  - The contract states that Castra owns removing the interactive Steward session (AS 3.2).
  - The contract states that Brood owns exact worktree and branch cleanup ordering (AS 3.2).
  - Cleanup language preserves spawn/steward correlation evidence needed for later observation or diagnostics.
  - Provider contracts remain referenced as boundaries rather than duplicated route or loop specifications.
  - Steward cleanup semantics do not require PR creation, push, merge, contract checking, freshness checking, or CI changes.

- [x] **Record loss, timeout, and unreachable-session failures**

  Add error-mode and invariant prose for Steward sessions that disappear, stall, time out, or become unreachable. The contract should align with March's clean-exit model from `docs/vision.md` and `docs/operating-philosophy.md`, making these states observable to Legate or Brood under AS 3.3 rather than waiting forever on input the role cannot receive.

  _Acceptance criteria:_
  - Steward disappearance, stall, timeout, and unreachable-session cases are named as observable failure states (AS 3.3).
  - Legate and Brood are identified as observation or teardown consumers for those states without transferring ownership of their loop or registry behavior.
  - The contract forbids indefinite waits on unavailable input inside the autonomous Steward role (AS 3.3).
  - Failure outcomes are terminal diagnostics or evented states with bounded detail.
  - The prose cites the intervention-avoidance rules from `docs/vision.md` and `docs/operating-philosophy.md` rather than restating them.

**PR Outcome**: The Steward contract records lifecycle correlation facts, Brood and Herald tracking boundaries, Castra session identity, parent spawn ownership, cleanup responsibilities, and loss/timeout behavior. L2 tests can diagnose stranded or removed Steward sessions from the contract without requiring runtime registry, event, teardown, or PR integration changes.

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
| S1 | Steward Lifecycle Tracking and Cleanup Contract | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Document Steward Launch and Input Contract | depends on | US3 extends the Steward contract created by US1 with lifecycle facts tied to launch identity. |
| User Story 2: Document Patch Application and PR-Ready Outcome Contract | depends on | US3 preserves the PR-ready and failed-outcome contract from US2 while adding lifecycle observation and cleanup boundaries. |
| User Story 4: Record Cross-Contract Ownership for Steward Consumers | depended upon by | US4 records complete cross-contract ownership and freshness binding once launch, patch application, and lifecycle content are documented. |
