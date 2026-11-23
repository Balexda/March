# Tasks: Preserve Teardown Evidence

**Source**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.spec.md` — User Story 2
**Data Model**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.data-model.md`
**Contracts**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.contracts.md`
**Story Number**: 02

## Slice 1: Preserve Evidence Before Teardown

**Goal**: Make Brood preserve teardown evidence before reclamation and leave an inspectable record of each accepted cleanup attempt.

**Justification**: The snapshot, attempt journal, and optional evidence all use the same archive boundary and must honor the same cleanup guard. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-006 (archive ordering), FR-007, FR-007a, FR-008, FR-008a, FR-009–FR-011, FR-019 (archive failures), FR-024 (worktree exclusion). AS 2.1–2.5. SC-003, SC-003a, SC-003b.

### Tasks

- [ ] **Preserve the original registry snapshot and journal cleanup attempts**

  Preserve the write-once snapshot and implement the append-only attempt lifecycle in Brood for AS 2.1.

  _Acceptance criteria_
  - New `record.json` snapshots capture the primary row and applicable group from before teardown, without teardown-written fields. Retries preserve existing snapshots byte for byte, including legacy archives, and retain US1's admission behavior even when the first attempt could not write a snapshot.
  - Each accepted cleanup attempt appends a monotonically numbered started entry to `teardown.ndjson` immediately after ensuring the snapshot exists. It includes force, kill, any reason, and the start timestamp. Rejected and already-complete no-ops leave the archive untouched.
  - The final entry records the response's ordered steps, warnings, final status, and finish timestamp. An unmatched started entry remains visible as interrupted. Concurrent requests preserve snapshot and journal integrity. Test recovery from interruption between journal finalization and registry update so terminal results agree across both.
  - A failed steward removal followed by a successful retry leaves one snapshot and two attempt pairs whose finished statuses are `tearing-down` and `torndown`.

- [ ] **Archive available logs and validated registry output**

  Preserve the optional evidence described by the archive contract for AS 2.2–2.5.

  _Acceptance criteria_
  - Available tracked container logs are preserved in `container.log`. Retries with a missing source retain previously archived evidence.
  - The validated registry extraction result is archived as `artifacts/extraction-result.json`. A succeeded result also produces `artifacts/spawn.patch` with the expected SHA-256. Verify the digest before writing and after reading back the archived patch.
  - An unavailable optional source or malformed registry result produces a warning and permits cleanup. A source digest mismatch produces a warning and no patch write. Registry artifacts and container logs are the only optional evidence sources, and unrelated worktree files stay out of the archive.

- [ ] **Gate destructive cleanup on archive writes**

  Apply FR-007a and FR-008a at the Brood teardown boundary, preserving the source/sink distinction from SD-010. Document the archive phases and retry outcomes in Brood's subsystem contract.

  _Acceptance criteria_
  - Failure to create the archive directory, write the snapshot, append the started entry, or persist readable logs or extraction evidence yields a failed archive step and blocks every destructive step. An archived patch that fails read-back verification is a sink failure. The session stays retryable and preserves US1's force decision.
  - A finished-entry write failure prevents terminal success. If destructive steps already ran, return their outcomes and a warning and leave the row `tearing-down`. A restored sink permits a retry without rewriting the first snapshot.
  - Service coverage verifies evidence is present before removal, optional-source warnings permit cleanup, and sink failures block cleanup or terminal success as applicable. Archive failures are visible in errored teardown spans.

**PR Outcome**: Brood preserves available session evidence before deletion and exposes interrupted or partial cleanup through the attempt journal and teardown result.

## Specification Debt

_None — no specification debt was recorded._

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How should Brood preserve a clean pre-teardown snapshot when the first snapshot write fails? | S1 | building | local |
| IQ-002 | How should Brood coordinate journal finalization and registry status if either write fails? | S1 | building | local |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Preserve Evidence Before Teardown | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 Request A Safe Teardown | depends on | Preserve the existing force guard and keep the cleanup reason separate from the session failure reason. |
| US3 Reclaim Runtime Artifacts By Exact Identity | depended upon by | The graceful-stop path runs this archive after stopping compute and before removing it. US3 owns the stop mode and removal handoff. |
| US4 Make Teardown Idempotent And Retryable | depended upon by | Preserve the snapshot and journal across retries. US4 owns generalized cleanup retry behavior. |

Service-wide call-out deadlines (FR-020a, SD-007) remain outside this slice.
