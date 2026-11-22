# Tasks: Request A Safe Teardown

**Source**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.spec.md` — User Story 1
**Data Model**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.data-model.md`
**Contracts**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.contracts.md`
**Story Number**: 01

## Slice 1: Enforce Safe Teardown Requests

**Goal**: Make Brood enforce teardown permissions across retries and make the CLI report the service's actual outcome.

**Justification**: One PR can update request admission and CLI reporting together so operators can distinguish rejected, deferred, and completed requests. Keep teardown non-interactive and service-owned. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-001, FR-002, FR-003, FR-003a, FR-005 (unsupported-mode rejection), FR-005a, FR-014a (CLI), FR-020, FR-020b, FR-023. AS 1.1–1.5.

### Tasks

- [x] **Enforce teardown admission across retries**

  Apply the force guard in Brood before registry changes or cleanup. Resolve steward requests to the owning spawn before applying the guard. Cover AS 1.2–1.4 at the service boundary.

  _Acceptance criteria_
  - Unknown IDs return HTTP 404. Created or running spawns requested without force return HTTP 409, including requests through their steward.
  - Rejected requests leave registry and cleanup artifacts untouched.
  - A retry after an interrupted forced attempt still requires force when preserved state or verified liveness calls for it, including when the first attempt could not write the archive snapshot.
  - A valid forced request proceeds without confirmation. Reject explicit kill requests before cleanup, even with force, until Brood supports distinct stop modes. Report the existing removal behavior accurately.
  - New rejection paths emit errored teardown spans and honor inbound trace context.

- [x] **Preserve cleanup reasons on lifecycle records**

  Persist the accepted request's cleanup reason through Brood's registry path for AS 1.5. Keep the failure diagnostic available to existing readers.

  _Acceptance criteria_
  - An accepted reason is readable on the lifecycle record after teardown and across service restarts.
  - A failed session keeps its original `failureReason` alongside the cleanup reason. A retry without a reason preserves the recorded reason.
  - Existing records without cleanup reasons remain readable. Rejected requests leave existing reasons intact.

- [x] **Report teardown results through the CLI**

  Keep `march brood teardown <id>` backed by the Brood client for AS 1.1–1.4. Align help and affected subsystem contracts with the supported flags, rejections, and result shape.

  _Acceptance criteria_
  - Text mode renders ordered step outcomes and warnings. CLI/API coverage for a stopped tracked spawn with a steward exercises archive, container, steward, worktree, and branch outcomes.
  - `--json` emits the service result with ID, status, ordered steps, and warnings.
  - The CLI renders completed and deferred responses in the selected format. Only `status: torndown` exits zero, even when Brood returns HTTP 2xx.
  - Not-found, conflict, unsupported mode, and service unavailability yield deterministic non-zero exits. The CLI makes no local cleanup calls.

**PR Outcome**: Operators can request service-owned teardown, receive accurate results in text or JSON, and retry without bypassing force protection or losing failure context.

## Specification Debt

_None — no specification debt was recorded._

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How should Brood persist and expose a cleanup reason separately from the failure diagnostic? | S1 | building | spec:SD-008 |
| IQ-002 | How can Brood enforce force on retries when no pre-teardown archive snapshot was written? | S1 | building | spec:SD-009 |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Enforce Safe Teardown Requests | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US2 Preserve Teardown Evidence | depended upon by | US2 owns archive contents and sink failures (SD-010). S1's retry guard must work even when the archive is absent. |
| US3 Reclaim Runtime Artifacts By Exact Identity | depended upon by | Coordinate the split stop/remove substrate (SD-004, FR-004 and FR-006a) with US2's post-stop evidence capture before enabling distinct stop modes. |
| US5 Observe Teardown Outcomes | depended upon by | S1 traces new admission failures. US5 owns the full outcome instrumentation. |

Legate deferred-result handling (FR-014b) and cleanup call-out deadlines (SD-007) are outside this slice.
