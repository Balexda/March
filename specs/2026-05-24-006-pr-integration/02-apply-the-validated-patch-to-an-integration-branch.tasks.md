# Tasks: Apply the Validated Patch to an Integration Branch

**Source**: `specs/2026-05-24-006-pr-integration/pr-integration.spec.md` — User Story 2
**Data Model**: `specs/2026-05-24-006-pr-integration/pr-integration.data-model.md`
**Contracts**: `specs/2026-05-24-006-pr-integration/pr-integration.contracts.md`
**Story Number**: 02

## Slice 1: Apply the Validated Patch in the Recorded Worktree
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Stage the eligible Feature 5 patch on the recorded integration branch and report either its validated touched paths or a terminal apply failure.

**Justification**: Worktree authorization and patch application belong in one increment because the worktree and branch checks must guard the first Git write. Use the bounded failure behavior in [March's vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md).

**Addresses**: FR-001, FR-003, FR-004, FR-005, FR-006, FR-013, FR-014, FR-015, FR-016, FR-017 and AS 2.1–2.5.

### Tasks

- [ ] **Bind patch application to the recorded integration checkout**

  In the Hatchery Steward handoff, carry the US1 eligibility result into the existing patch-apply path in `src/hatchery/spawn-handoff.ts`. Resolve the authorized worktree and exact branch from lifecycle state before applying the patch (AS 2.1, AS 2.2, AS 2.5).

  _Acceptance criteria:_
  - Only the admitted extraction's validated patch reaches the apply operation.
  - The worktree belongs to the recorded repository and has the exact recorded integration branch checked out.
  - An absent lifecycle record, missing worktree or branch, wrong branch, detached checkout, or target resolving to the operator checkout fails before any Git mutation. Cover symlink and subdirectory aliases of the operator checkout.
  - A disposable linked worktree test verifies that the operator checkout's files and index stay unchanged.

- [ ] **Report staged paths and stop failed handoffs**

  Verify the staged result in the Hatchery apply path and report the application outcome using the contract's `PatchApplicationResult` fields. Exercise the outcome through the Steward handoff with local Git fixtures (AS 2.3, AS 2.4).

  _Acceptance criteria:_
  - Success has a non-empty staged diff and reports exactly the normalized touched paths from the validated extraction. Unrelated staged changes, an empty diff, and mismatched paths fail the handoff.
  - A base change that causes an apply conflict produces a stable conflict reason and bounded, redacted diagnostic. Apply failures stop the handoff before the Steward can commit, push, or open a PR.
  - Git work is bounded. Timeout and other apply failures return a terminal failure and mark the existing `steward.apply` child span as errored on the deterministic slice trace.
  - Local tests cover exact touched-path reporting, conflicts, clean failure for an unavailable integration target, no-op results, and staged path mismatches without Docker or GitHub.

**PR Outcome**: An eligible patch yields a verified staged change on the recorded integration branch or a terminal failure before Steward publishing.

## Specification Debt

_None for US2._

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which existing Brood and Hatchery interfaces can carry the apply outcome to the handoff caller? | S1 | reading code | spec:SD-002 |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Apply the Validated Patch in the Recorded Worktree | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 | depends on | Supplies the eligible, validated extraction and its touched paths. |
| US3 | depended upon by | Consumes the staged result to create or reuse a commit and publish the branch. |
| US5 | depended upon by | Owns durable recording of full integration outcomes. |
