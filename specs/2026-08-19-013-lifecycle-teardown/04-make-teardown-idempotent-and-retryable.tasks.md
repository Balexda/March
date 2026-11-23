# Tasks: Make Teardown Idempotent And Retryable

**Source**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.spec.md` — User Story 4
**Data Model**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.data-model.md`
**Contracts**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.contracts.md`
**Story Number**: 04

## Slice 1: Verify Retry and Group Completion
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make repeated teardown safe and report completion only when the entire session group is clean.

**Justification**: Brood already serializes requests per archive and verifies individual cleanup steps. Group-level completion checks can ship independently of deadline enforcement.

**Addresses**: FR-014, FR-014a, FR-017, FR-018, FR-019. AS 4.1–4.5.

### Tasks

- [ ] **Apply the completion rule to the entire session group**

  Use the same rule whether the request addresses a spawn or one of its stewards. Reuse existing absence handling, archive journaling, and registry completion.

  _Acceptance criteria_
  - A fully torn-down group returns `torndown` with no cleanup or archive writes. Addressing an already torn-down steward cannot short-circuit cleanup while another steward in its group is live.
  - Already absent compute, steward, worktree, and branch are safe to encounter again. An absent worktree yields a skipped step.
  - Unverified steward removal leaves the result `tearing-down`, with a warning and deferred worktree and branch steps. A later request that verifies removal or absence completes workspace cleanup and marks the group `torndown` while retaining its registry rows.
  - Brood boundary coverage exercises AS 4.1–4.5, including retry by steward ID and completion after a failed attempt with the original archive snapshot preserved.

**PR Outcome**: Brood returns a no-op for a completed group and can finish deferred cleanup on retry.

## Slice 2: Bound Teardown Call-Outs
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Return an actionable retryable result when a teardown dependency stalls.

**Justification**: Deadline handling applies the same failure and retry rules across archive I/O, compute, Castra, and Git. The service must remain responsive while a dependency stalls. [Operating philosophy](../../docs/operating-philosophy.md#3-failures-are-clean-exits-not-hangs)

**Addresses**: FR-007a, FR-008a, FR-014, FR-019, FR-020a, FR-021 (deadline failures). AS 4.4–4.5.

### Tasks

- [ ] **Enforce server-side deadlines for teardown call-outs**

  Bound archive I/O, Docker log reads and compute operations, Castra steward cleanup, and exact Git worktree and branch operations. Reuse provider deadlines where they bound the entire call-out and keep blocking I/O off the Brood event loop.

  _Acceptance criteria_
  - Each call-out has an enforced server-side deadline covering its verification and internal retries. Document the bounds and how they fit the teardown client request budget.
  - Cleanup deadlines yield failed or deferred outcomes and leave the session retryable. An optional log source timeout warns. An archive sink timeout before removal blocks destructive work. A journal finalization timeout after cleanup warns and leaves the status `tearing-down`.
  - A timed-out operation cannot publish a late terminal outcome or interfere with a later attempt. Cleanup resumes when it is safe to retry the affected operation.
  - Timeout failures surface in the teardown trace and response. Brood boundary coverage verifies bounded responses, service responsiveness during a stall, and retry after recovery. Update affected subsystem contracts with the deadline behavior.

**PR Outcome**: Teardown reports the stalled operation and preserves the state needed for a safe retry.

## Specification Debt

_None requiring an operator choice._

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | What per-step bounds fit the teardown clients' timeout budget? | S2 | testing | spec:SD-007 |
| IQ-002 | How can stalled archive I/O be isolated so a retry cannot race a late write? | S2 | building | spec:SD-007 |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Verify Retry and Group Completion | — | — |
| S2 | Bound Teardown Call-Outs | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US2 Preserve Teardown Evidence | depends on | Reuse the original snapshot and attempt journal. Apply deadline outcomes using US2's source and sink rules. |
| US3 Reclaim Runtime Artifacts By Exact Identity | depends on | Reuse verified absence, exact cleanup targets, and consumer handling of non-terminal results. |
| US5 Observe Teardown Outcomes | parallel | Reuse step tracing for deadlines. US5 owns the broader outcome telemetry. |
