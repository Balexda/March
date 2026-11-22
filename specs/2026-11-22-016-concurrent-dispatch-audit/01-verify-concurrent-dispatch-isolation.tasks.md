# Tasks: Verify Isolation Between Concurrent Dispatches

**Source**: `specs/2026-11-22-016-concurrent-dispatch-audit/concurrent-dispatch-audit.spec.md` — User Story 1
**Data Model**: `specs/2026-11-22-016-concurrent-dispatch-audit/concurrent-dispatch-audit.data-model.md`
**Contracts**: `specs/2026-11-22-016-concurrent-dispatch-audit/concurrent-dispatch-audit.contracts.md`
**Story Number**: 01

---

## Slice 1: Prove Concurrent Dispatch Isolation
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Publish a dispatch resource audit and make its CLI isolation claims executable in CI.

**Justification**: The audit explains the scope of the regression scenario, and the scenario makes its CLI claims repeatable. Both fit in one PR without changing production dispatch.

**Addresses**: FR-001 through FR-004 and AS 1.1, AS 1.2, AS 1.3.

### Tasks

- [ ] **Publish the resource audit with executable isolation evidence**

  Document the CLI path in `src/cli/program.ts` and the Hatchery path in `src/hatchery/spawn-handoff.ts`, following their allocation and cleanup calls into Spawn, Castra, and Brood. Pair the audit with one `@l2 @deterministic @ci` scenario in the existing cassette run (`npm run test:l2-cassette`).

  _Acceptance criteria:_
  - The source-linked audit meets AS 1.1 for every resource in FR-001. It distinguishes random candidates from reservation, atomic updates from competing writes, and Brood index reads from Hatchery lifecycle registration.
  - Address both spec edge cases. For each gap, record the failing ownership check and a separately tracked fix under AS 1.3.
  - The scenario proves AS 1.2 with actual overlap, real CLI, Git, filesystem, and Docker operations, replayed backend responses, and the existing Brood index reader. The audit identifies which guarantees this scenario exercises.
  - Bound the scenario and clean only its fixture-owned resources on success or failure, following FR-004.

**PR Outcome**: Reviewers can trace shared-resource ownership and CI checks that both overlapping dispatches complete with independently attributable artifacts.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder+ai-input; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which backend fixture can replay distinct responses while keeping both real containers in flight? | S1 | building | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Prove Concurrent Dispatch Isolation | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Brood Feature 1 | depends on | The scenario uses the existing record reader in `src/brood/spawn-index.ts`. |
