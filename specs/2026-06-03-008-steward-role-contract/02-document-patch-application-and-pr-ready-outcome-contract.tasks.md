# Tasks: Document Patch Application and PR-Ready Outcome Contract

**Source**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.spec.md` - User Story 2
**Data Model**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.data-model.md`
**Contracts**: `specs/2026-06-03-008-steward-role-contract/steward-role-contract.contracts.md`
**Story Number**: 02

---

## Slice 1: Steward Patch Application and PR-Ready Outcome Contract

**Goal**: Extend `docs/subsystems/steward/contract.md` with Steward-owned patch-application, worktree/index, failure, diagnostic, and PR-ready outcome promises after the launch/input contract is in place.

**Justification**: User Story 2 is documentation-only and all acceptance scenarios describe one coherent boundary: Steward takes validated patch output, applies it to the expected repository state, and reports either a PR-ready branch or a bounded failure. Splitting application, dirty-worktree handling, and outcome semantics would leave L2 tests without a complete diagnostic target, while implementing PR tooling or runtime patch behavior would violate this feature's out-of-scope constraints.

**Addresses**: FR-006, FR-007, FR-010, FR-012; Acceptance Scenarios 2.1, 2.2, 2.3.

### Tasks

- [ ] **Document index-aware patch application promises**

  Update the Steward contract's public interface and invariants to describe how Steward applies validated patch output to the expected worktree and index. The contract should name `git apply --index` as the index-aware application mode, define what fallback or conflict handling is allowed to report, and keep the behavior framed as Steward-owned role semantics rather than Spawn validation or Castra route behavior.

  _Acceptance criteria:_
  - The contract documents `git apply --index` behavior for validated patch output (AS 2.1).
  - Success requires the expected worktree and index to reflect the accepted patch (AS 2.1).
  - Fallback, rejected hunks, conflicts, and unsupported apply forms are described as bounded Steward outcomes, not interactive prompts (AS 2.2).
  - The prose consumes Spawn's validated patch result without restating Spawn raw-output parsing or validation internals.

- [ ] **Record worktree cleanliness and failure constraints**

  Add assertable rules for target-worktree identity, branch identity, dirty-worktree handling, out-of-worktree patch attempts, and incoherent index states. The contract should make failed handoffs externally diagnosable while preserving March's autonomous-component rules from `docs/vision.md` and `docs/operating-philosophy.md`.

  _Acceptance criteria:_
  - The contract states that Steward applies patches only in the expected worktree and branch correlation (AS 2.1, AS 2.2).
  - Dirty, missing, mismatched, or incoherent worktree/index state is a failed handoff or terminal diagnostic before success is reported (AS 2.2).
  - Patches that apply outside the allowed worktree are failed outcomes, not partially accepted states (AS 2.2).
  - Failure language cites the noninteractive, clean-exit model from `docs/vision.md` and `docs/operating-philosophy.md`.

- [ ] **Define PR-ready and failed outcome reporting**

  Document Steward's terminal success and failure reports without requiring this story to create, push, merge, or open a pull request. The contract should distinguish PR-ready branch state from downstream PR creation tooling and name the bounded diagnostic surfaces that callers or tests can assert.

  _Acceptance criteria:_
  - PR-ready means the target branch, worktree, and index contain the accepted patch and downstream integration may proceed (AS 2.1, AS 2.3).
  - The contract states that PR creation, pushing, merging, and PR-tool invocation are owned by the manager or later integration boundary, not this feature (AS 2.3).
  - Patch-apply, dirty-worktree, out-of-worktree, and incoherent-index failures are terminal or evented with bounded diagnostics (AS 2.2).
  - No contract checker, freshness checker, AUTOGEN generation, CI enforcement, runtime behavior, PR creation, push, or merge behavior is introduced.

**PR Outcome**: The Steward contract records index-aware patch application, target worktree and index constraints, conflict and dirty-worktree failure handling, bounded diagnostics, and PR-ready branch semantics. L2 tests can diagnose clean application, failed handoffs, and downstream PR-tool ownership from the contract without relying on session transcripts or requiring runtime changes.

---

## Specification Debt

None - all ambiguities resolved.

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Steward Patch Application and PR-Ready Outcome Contract | US1 | `docs/subsystems/steward/contract.md` |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Document Steward Launch and Input Contract | depends on | US2 extends the Steward contract created by US1 with patch-application and outcome behavior. |
| User Story 3: Document Steward Lifecycle, Tracking, and Cleanup Boundaries | depended upon by | US3 adds Brood, Herald, Castra session identity, parent spawn ownership, cleanup, loss, and timeout lifecycle boundaries after the application outcome contract exists. |
| User Story 4: Record Cross-Contract Ownership for Steward Consumers | depended upon by | US4 records complete cross-contract ownership and freshness binding once launch, patch application, and lifecycle content are documented. |
