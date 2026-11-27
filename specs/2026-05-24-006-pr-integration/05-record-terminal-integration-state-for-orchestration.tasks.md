# Tasks: Record Terminal Integration State for Orchestration

**Source**: `specs/2026-05-24-006-pr-integration/pr-integration.spec.md` — User Story 5
**Data Model**: `specs/2026-05-24-006-pr-integration/pr-integration.data-model.md`
**Contracts**: `specs/2026-05-24-006-pr-integration/pr-integration.contracts.md`
**Story Number**: 05

## Slice 1: Persist and Expose Terminal PR Integration Outcomes
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give orchestration a durable, typed outcome for every PR integration attempt.

**Justification**: Land the Brood record, Hatchery writer, and orchestration read together so a terminal result is usable from the first release. Follow [March's vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for autonomous completion and clean exits.

**Addresses**: FR-013–FR-017, AS 5.1–5.5.

### Tasks

- [x] **Persist a typed terminal result in Brood**

  Extend Brood’s durable lifecycle registry and typed client with current integration outcomes by spawn ID (AS 5.1, AS 5.2, AS 5.5).

  _Acceptance criteria:_

  - The contract distinguishes success, failure, and absence of a terminal result. Success includes completion time, application result, commit record with exact branch and SHA, and PR record. Failure includes completion time, a stable reason, a bounded redacted diagnostic, and available durable artifact identifiers.
  - Preserve backward compatibility with existing session records. Repeated writes are idempotent. Persist attempt ownership so a superseded attempt cannot publish, even while its successor is running.
  - Retain a readable terminal failure for a known attempt whose lifecycle row is missing. Avoid creating a synthetic session that teardown could mistake for a real one.
  - Cover persistence across restart, legacy records, and retried or out-of-order writes. Update the Brood contract.

- [x] **Finalize Hatchery integration with bounded work and diagnostics**

  At the Hatchery handoff boundary, map validated extraction, application, commit, push, and PR publication outcomes into the Brood contract (AS 5.1–5.4).

  _Acceptance criteria:_

  - Enforce the US1 gate in the live handoff. Finalize fresh and resumed publication under the artifact’s spawn ID. Preserve durable artifacts on failure.
  - Treat failed publication as failed integration. Normalize extraction rejection, missing lifecycle, patch conflict, commit, push, PR publication, timeout, and persistence failures. Bound and redact every diagnostic.
  - Enforce a configured Steward deadline. On expiry, stop active work, record timeout, and reject late completion.
  - Bound Brood calls and retries. Reconcile lost acknowledgements idempotently. Return typed persistence failures with available artifacts.
  - Reuse deterministic slice trace IDs across processes and mark failure spans errored. Cover success, gate rejection, missing lifecycle, conflict, commit and push failure, PR failure, timeout, and post-publication persistence failure.

- [x] **Read terminal outcomes through the orchestration boundary**

  Wire Hatchery job completion and Legate's existing dispatch completion path to the typed outcome. Expose the same durable outcome to Herald through a typed Brood read. When Brood confirms it has no outcome, Herald uses Legate's terminal failure event from its own event log (AS 5.5).

  _Acceptance criteria:_

  - Orchestration distinguishes incomplete work, terminal success, and terminal failure. Existing retry and escalation policy receives the stable failure reason. Report a persistence failure through the job result when the durable write is unavailable.
  - Before any integration work starts, durably write a lookup in Brood from the dispatch attempt to the actual integration spawn. Resumed publication uses the same lookup. The lookup stores the attempt's absolute Steward deadline. Legate records the same deadline in its dispatch transition event in Herald. If the lookup write fails, Hatchery fails the job with `persistence` before extraction, application, or publication. Nothing is published without a lookup, so Legate can always find a published outcome. A prior attempt's result cannot complete the pending dispatch.
  - Brood's outcome is authoritative. Before Legate records any terminal failure, it makes one atomic Brood call through the lookup. If Brood has an outcome, the call returns it, and that outcome wins. Otherwise the call fences the attempt, so Brood rejects any later outcome write from it. A failure counts as confirmed only when this call fences the attempt.
    - A `persistence` failure reported in a job result may be an uncertain write whose acknowledgement was lost. Legate records it only after Brood confirms that it has no outcome for the attempt.
    - If the stored deadline passes and Brood confirms that no outcome is linked to the attempt, Legate records a terminal `timeout` failure.
    - If Brood is unreachable, Legate makes no terminal decision for the attempt. It keeps the dispatch pending, emits an errored span, and retries on later ticks.
    - Legate records each confirmed failure as a Herald transition event. Herald's fold projects the event as the attempt's terminal outcome, and the Herald read returns the same result as the Brood read. The event routes through the existing retry and escalation policy.
  - Verify success and failure through the worker, job API, and orchestration read paths without reading container logs or Steward output. Update affected subsystem contracts.

**PR Outcome**: Legate and Herald can retrieve terminal integration status and available PR and commit identifiers from structured state.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-003 | Pre-PR verification policy | Functional Scope | Medium | Medium | spec:SD-003 |

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How should Brood store a terminal result when the corresponding spawn session is missing? | S1 | building | spec:SD-002 |
| IQ-002 | Which existing job and dispatch identifiers can recover a Brood outcome after Hatchery restarts? | S1 | reading code | local |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Persist and Expose Terminal PR Integration Outcomes | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 | depends on | Supplies the extraction gate and rejection categories. |
| US4 | depends on | Supplies the publication outcome, including the commit and any associated PR. |
