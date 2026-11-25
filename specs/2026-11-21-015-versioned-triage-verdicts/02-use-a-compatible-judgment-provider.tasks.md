# Tasks: Use a compatible judgment provider

**Source**: `specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.spec.md` — User Story 2
**Data Model**: `specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.data-model.md`
**Contracts**: `specs/2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.contracts.md`
**Story Number**: 02

## Slice 1: Share verdict validation across judgment providers
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give the triage consumer one read-only judgment interface and one validation path for baseline and substitute providers.

**Justification**: Deliver the interface, consumer validation, and compatibility coverage together so callers can rely on the same verdict contract at merge.

**Addresses**: FR-005 (shared validation boundary and open-core record; the baseline recommender itself is delivered by [RFC Milestone 2: Single-Issue Recommender and Operator Backfill](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md#milestone-2-single-issue-recommender-and-operator-backfill)), AS 2.1, AS 2.2, and SC-003.

### Tasks

- [x] **Use one validation boundary for judgment providers**

  Define the provider and consumer boundary in `src/triage/` for AS 2.1. Apply [operating philosophy rule 2](../../docs/operating-philosophy.md#2-minimum-required-access-not-zero-access) to the judgment interface.

  _Acceptance criteria:_
  - The provider receives the issue title and body as untrusted text, available read-only repository context, and the selected rubric revision. The interface grants no GitHub write capability.
  - The consumer passes raw candidate output to the US1 validator before making a verdict eligible for recording. Rejection returns the existing diagnostic and preserves the validator's errored span when tracing is enabled.
  - Compatibility tests use equivalent valid and invalid outputs from baseline and substitute providers to demonstrate identical validation results, including for malformed JSON and unsupported versions, with no GitHub writes.
  - The open baseline and substitute use the same contract. Recommender execution, calibration, and plugin discovery are outside this slice.

- [x] **Document the open baseline and provider interface**

  Keep the open-core exception discoverable for AS 2.2. Describe the provider surface in the [triage subsystem contract](../../docs/subsystems/triage/contract.md).

  _Acceptance criteria:_
  - The [open-core boundary](../../docs/open-core-boundary.md#issue-triage-exception) records the open-engine exception for the rubric, versioned vocabulary, and baseline recommender. This slice delivers the rubric and vocabulary through the US1 contract. The record names RFC Milestone 2 as the delivery point for the baseline recommender. It identifies the shared validation contract and when the exception will be revisited.
  - The subsystem contract describes the read-only inputs, untrusted candidate output, and consumer validation. The deterministic writer owns any later GitHub writes.

**PR Outcome**: A consumer can validate candidates from either provider through the same read-only interface, and maintainers can find the open-core commitment and provider contract.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| S1 | Share verdict validation across judgment providers | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|---|---|---|
| US1 — Read a consistent recommendation across profiles | depends on | Reuse the shared v1 vocabulary, rubric revision, and verdict validation boundary. |
