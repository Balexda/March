# Tasks: Reclaim Runtime Artifacts By Exact Identity

**Source**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.spec.md` — User Story 3
**Data Model**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.data-model.md`
**Contracts**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.contracts.md`
**Story Number**: 03

## Slice 1: Verify Exact Runtime Artifact Removal

**Goal**: Reclaim the requested session's compute and workspace artifacts and surface unverified cleanup.

**Justification**: Verified removal and the workspace isolation checks can ship together while retaining US1's admission behavior. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-006, FR-012, FR-012a, FR-012b, FR-013, FR-014 (workspace safety), FR-015, FR-016. AS 3.1–3.5.

### Tasks

- [ ] **Reclaim session compute through the teardown substrate**

  Resolve the exact compute target from the lifecycle record and make teardown verify removal. Cover AS 3.1 at the Brood and host substrate boundaries.

  _Acceptance criteria_
  - Spawn, legate, and other supported ephemeral session kinds use kind-agnostic cleanup with a container name derived from the session identity. The recorded container ID remains the log source. Shared compose service containers are excluded.
  - After the archive succeeds, remove only the resolved container. Verified absence succeeds, including an already absent container. A removal error other than a missing container, a deadline breach, or an unverified post-condition yields a failed container step and leaves teardown retryable.
  - Dispatch rollback retains best-effort removal. New failures surface in teardown tracing. Update the affected subsystem contracts with the verified removal behavior.

- [ ] **Preserve exact steward and workspace cleanup**

  Keep Brood responsible for shared checkout cleanup and exercise the end-to-end isolation boundary in AS 3.2–3.5.

  _Acceptance criteria_
  - Castra receives the steward removal request with worktree pruning disabled. Unverified steward removal defers worktree and branch removal.
  - Brood removes the recorded worktree path and branch separately, in order. Missing registry identities are skipped. A branch checked out elsewhere yields a failed branch outcome without touching that checkout.
  - Boundary coverage verifies that adjacent containers, sessions, worktrees, and branches survive cleanup of the selected session.

**PR Outcome**: Brood verifies removal of ephemeral session compute and confines steward and Git cleanup to the selected session's artifacts.

## Slice 2: Stop Compute Before Evidence Capture

**Goal**: Allow running compute to stop gracefully before evidence capture and support explicit immediate removal.

**Justification**: The stop and remove phases share an archive boundary. Ship the mode distinction with its ordering and failure behavior. [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-003, FR-004, FR-005, FR-005a, FR-006a. AS 3.1.

### Tasks

- [ ] **Separate graceful stop from verified removal**

  Apply the target stop and remove contract using S1's exact compute identity. Coordinate the archive handoff with US2 before enabling the modes.

  _Acceptance criteria_
  - Accepted ordinary forced teardown of running compute performs a bounded graceful stop that leaves the container available for evidence capture. Explicit kill skips the stop phase and uses immediate removal only after the archive succeeds. US1's force protection still applies.
  - Archive final evidence after stop and before removal. A post-stop archive failure leaves stopped compute present, blocks all destructive cleanup, and leaves teardown retryable. A retry can archive an already stopped container.
  - An unverified or unsupported stop surfaces a failed or deferred outcome. Immediate removal or escalation does not report graceful success. Cover both modes and the post-stop failure and retry path through the service boundary.
  - Trace the new stop action and failures. Update the affected CLI help and subsystem contracts with the supported modes and outcomes.

**PR Outcome**: Brood preserves evidence across graceful stop and applies the explicit immediate removal mode with accurate outcomes.

## Specification Debt

_None — no specification debt was recorded._

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which launcher identity rules can Brood reuse for each supported ephemeral session kind? | S1 | reading code | local |
| IQ-002 | How can the provider distinguish a graceful stop from an escalated kill? | S2 | testing | spec:SD-004 |
| IQ-003 | How should the new compute call-outs enforce deadlines without blocking Brood? | — | building | spec:SD-007 |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Verify Exact Runtime Artifact Removal | — | — |
| S2 | Stop Compute Before Evidence Capture | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 Request A Safe Teardown | depends on | Both slices preserve request admission. S2 replaces US1's explicit-kill rejection when the distinct modes are ready. |
| US2 Preserve Teardown Evidence | integration boundary | S2 requires the fail-closed archive behavior at the stop/remove handoff. Coordinate delivery with US2 before enabling the modes. US2 owns archive contents and sink handling. |
| US4 Make Teardown Idempotent And Retryable | depended upon by | US3 preserves local failure outcomes and workspace deferral. US4 owns generalized retry behavior and Legate consumer handling. |

FR-020a's service-wide deadline work and US5's full outcome instrumentation remain outside the slices. New compute call-outs must have enforced deadlines.
