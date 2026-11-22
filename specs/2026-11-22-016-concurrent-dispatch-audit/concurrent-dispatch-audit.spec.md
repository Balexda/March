# Feature Specification: Concurrent Dispatch Audit

**Spec Folder**: `2026-11-22-016-concurrent-dispatch-audit`
**Branch**: `feature/smithy/mark/march-orchestration-platform-m3-f4`
**Created**: 2026-11-22
**Status**: Draft
**Input**: [March Orchestration Platform RFC](../../docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md), Milestone 3 criterion that multiple spawn sessions can launch and be tracked concurrently.
**Source Feature Map**: [Brood Feature Map](../../docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md) — Feature 4: Concurrent Dispatch Audit

## Clarifications

### Session 2026-11-22

- Keep the audit and its regression test together as a standalone feature, as proposed in the feature map's SD-004. The Brood index consumes dispatch records, while this feature verifies that concurrent dispatches actually produce separate records and artifacts.

## Artifact Hierarchy

RFC → Milestone 3 (Brood) → Feature 4 → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Verify isolation between concurrent dispatches (Priority: P1)

As a March operator, I want evidence that two dispatches can share a repository and host so that I can launch parallel work and track each session independently in Brood.

**Why this priority**: The session index can only distinguish sessions if dispatch preserves each session's identity and artifacts.

**Independent Test**: Run the deterministic CI scenario with two overlapping `march spawn dispatch` processes against the same throwaway repository, March home, and Docker daemon. Compare resources against the written audit.

**Acceptance Scenarios**:

1. **Given** the Spawn and Hatchery dispatch paths and the Brood index, **when** a reviewer reads the audit, **then** they can trace each shared resource to its allocation, collision safeguard or gap, and cleanup ownership, including whether Brood introduces a new collision surface.
2. **Given** two dispatches with distinct deterministic backend responses, **when** both are in flight against the same fixture, **then** both exit successfully with different spawn IDs, branch names, worktree paths, image tags, container names and IDs, and SpawnRecord paths. Each record links to its own resources, each output matches its originating dispatch, and both records are independently readable through the Brood index.
3. **Given** the audit finds a possible collision or cross-dispatch cleanup hazard, **when** the finding is recorded, **then** the audit identifies the failing ownership check and tracks the fix in a separate PR. The CI assertions still require isolation.

### Edge Cases

- An ID candidate can repeat. Audit what happens when a branch, worktree path, record path, or Docker name is already claimed, including whether failure cleanup can target an artifact owned by the other run.
- A Brood read can overlap a record update. Audit whether the reader sees a whole record and whether one writer or rollback can replace or remove another run's record. Atomic replacement and exclusive creation address different hazards.

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Verify isolation between concurrent dispatches | — | specs/2026-11-22-016-concurrent-dispatch-audit/01-verify-concurrent-dispatch-isolation.tasks.md |

## Requirements

### Functional Requirements

- **FR-001 (US1)** — Publish a source-backed audit of shared dispatch resources. Cover spawn ID generation and reservation, Git refs and worktree paths, temporary build contexts, Docker image tags and container names, SpawnRecord creation and updates, and output paths. Trace additional shared resources used by the Hatchery path, including steward allocation and Brood registration where applicable.
- **FR-002 (US1)** — For every resource, state its namespace and owner, how dispatch creates or updates it, how a conflict is handled, and what cleanup may remove. Distinguish random ID generation from exclusive allocation, and atomic writes from protection against competing writers. Check that Brood's index adds no conflicting writes or allocations. Track any collision fix in a separate PR.
- **FR-003 (US1)** — Provide one deterministic CI integration scenario over the real CLI dispatch path and shared Git, filesystem, and Docker resources. Use replayed backend responses, verify overlap and both successful outcomes, and assert the identity and ownership checks in acceptance scenario 2.
- **FR-004 (US1)** — Give the CI scenario a bounded completion time and clean its fixture resources on success or failure. Follow March's [vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for unattended runs and clean failure exits.

## Assumptions

- Brood Feature 1 provides the record reader used to verify session tracking.
- The CLI case is the required executable proof. The written audit also covers the Hatchery service path and states which guarantees the CLI case exercises.
- The CI fixture replays backend responses and exercises the resource boundaries under audit, consistent with the [testing strategy](../../docs/testing-strategy.md).

## Specification Debt

_None — no specification debt was recorded._

## Out of Scope

- Production collision fixes, new concurrency primitives, and dispatch or backend refactors.
- Detached dispatch, automatic backoff or queuing, and stress testing beyond two concurrent invocations.
- New CLI or service interfaces and changes to persisted session state.

## Success Criteria

### Measurable Outcomes

- **SC-001** — The audit identifies the owner, uniqueness or collision handling, and cleanup behavior of every shared dispatch resource it enumerates. Each gap has a separately tracked fix, and the audit records its conclusion about Brood's collision surface.
- **SC-002** — One CI-visible integration scenario passes with two overlapping CLI invocations, two successful exits, two distinct sets of artifacts and correctly attributed outputs, and two independently readable Brood records.
