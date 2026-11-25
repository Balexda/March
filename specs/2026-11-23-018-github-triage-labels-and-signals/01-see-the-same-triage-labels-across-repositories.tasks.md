# Tasks: See the same triage labels across repositories

**Source**: `specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.spec.md` — User Story 1
**Data Model**: `specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.data-model.md`
**Contracts**: `specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.contracts.md`
**Story Number**: 01

## Slice 1: Provision the shared triage label catalog

**Goal**: Give every repository registered with Herald the same triage label definitions through repeatable provisioning.

**Justification**: The catalog and provisioning operation together deliver a usable increment with one end-to-end acceptance check across repositories.

**Addresses**: FR-001, FR-002, AS 1.1, AS 1.2, and AS 1.3.

### Tasks

- [ ] **Define the shared label catalog**

  Define the GitHub label names and groups in the triage domain using the feature contracts for AS 1.1.

  _Acceptance criteria_
  - The catalog includes one exact contract name for each state, outcome, confidence, acceptance, and resubmit value. Tests check complete, unique coverage and the one-to-one mapping to the v1 verdict outcomes and confidence levels.
  - Acceptance and resubmit are identified as operator-owned signals.

- [ ] **Provision missing label definitions across registered repositories**

  Expose provisioning over the Herald profile registry and a repository-scoped GitHub access boundary for AS 1.1–1.3. Document the public surface in the owning subsystem contract. Follow the [March vision](../../docs/vision.md) and [operating philosophy rules 2 and 3](../../docs/operating-philosophy.md#three-rules-of-thumb).

  _Acceptance criteria_
  - Visit every distinct registered GitHub repository once, using credentials scoped per repository for listing and creating label definitions. Report created and already-present entries per repository.
  - Create only missing names. Preserve existing metadata, unrelated labels, and issue assignments. Tests cover march, smithycli, duplicate profiles for one repository, and zero mutations on a complete second run.
  - Bound registry and GitHub calls. Report incomplete coverage as failure with the failed operation and repository context when available, and emit an errored span when tracing is enabled.
  - Count a concurrent create conflict as already present only after confirming the name. Tests cover confirmed and unconfirmed conflicts and verify that retry after partial creation fills only the remaining gaps.

**PR Outcome**: Provisioning brings registered repositories to the shared catalog and reports either confirmed coverage or an actionable failure that can be retried.

## Specification Debt

_None — no specification debt was recorded._

## Open Implementation Questions

_None — no open implementation questions._

## Dependency Order

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| S1 | Provision the shared triage label catalog | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|---|---|---|
| US2 — Control triage through issue labels | Shared contract | Both stories use the same catalog. US2 can verify interpretation independently of repository provisioning. |
