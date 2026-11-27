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

- [ ] **Persist a typed terminal result in Brood**

  Extend Brood’s durable lifecycle registry and typed client with current integration outcomes by spawn ID (AS 5.1, AS 5.2, AS 5.5).

  _Acceptance criteria:_

  - The contract distinguishes success, failure, and absence of a terminal result. Success includes completion time, application result, commit record with exact branch and SHA, and PR record. Failure includes completion time, a stable reason, a bounded redacted diagnostic, and available durable artifact identifiers.
  - Preserve backward compatibility with existing session records. Repeated writes are idempotent. Persist attempt ownership so a superseded attempt cannot publish, even while its successor is running.
  - Retain a readable terminal failure for a known attempt whose lifecycle row is missing. Avoid creating a synthetic session that teardown could mistake for a real one.
  - Cover persistence across restart, legacy records, and retried or out-of-order writes. Update the Brood contract.

- [ ] **Finalize Hatchery integration with bounded work and diagnostics**

  At the Hatchery handoff boundary, map validated extraction, application, commit, push, and PR publication outcomes into the Brood contract (AS 5.1–5.4).

  _Acceptance criteria:_

  - Enforce the US1 gate in the live handoff. Finalize fresh and resumed publication under the artifact’s spawn ID. Preserve durable artifacts on failure.
  - Treat failed publication as failed integration. Normalize extraction rejection, missing lifecycle, patch conflict, commit, push, PR publication, timeout, and persistence failures. Bound and redact every diagnostic.
  - Enforce a configured Steward deadline. On expiry, stop active work, record timeout, and reject late completion.
  - Bound Brood calls and retries. Reconcile lost acknowledgements idempotently. Return typed persistence failures with available artifacts.
  - Reuse deterministic slice trace IDs across processes and mark failure spans errored. Cover success, gate rejection, missing lifecycle, conflict, commit and push failure, PR failure, timeout, and post-publication persistence failure.

- [ ] **Read terminal outcomes through the orchestration boundary**

  Wire Hatchery job completion and Legate's existing dispatch completion path to the typed outcome. Expose the same durable outcome to Herald through a typed Brood read (AS 5.5).

  _Acceptance criteria:_

  - Orchestration distinguishes incomplete work, terminal success, and terminal failure. Existing retry and escalation policy receives the stable failure reason. Report a persistence failure through the job result when the durable write is unavailable.
  - Persist a lookup from the dispatch attempt to the actual integration spawn, including resumed publication. Legate can recover that result if its first poll arrives after job expiry or a Hatchery restart. A prior attempt’s result cannot complete the pending dispatch.
  - Handle a missing durable outcome. When Legate dispatches the attempt, it records the attempt's absolute Steward deadline in its dispatch transition event in Herald. The dispatch-attempt lookup in Brood stores the same deadline. Legate decides expiry from this stored deadline after a job expiry, a Hatchery or Legate restart, or a failed lookup write.
    - If Legate reads a job result that reports a `persistence` failure, it records that terminal failure as a Herald transition event right away. The reason then survives a later job expiry.
    - Suppose the stored deadline passes with no Brood outcome and no recorded job-reported failure. Legate records a terminal `timeout` failure, because it has no evidence that the run finished. This holds whether the lookup is missing, or present without an outcome.
    - That Herald event is the durable record orchestration reads, and it routes through the existing retry and escalation policy. A late Brood write from that attempt cannot reopen the dispatch.
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
