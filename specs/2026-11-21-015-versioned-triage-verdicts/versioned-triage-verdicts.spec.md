# Feature Specification: Versioned Triage Verdicts

**Spec Folder**: `2026-11-21-015-versioned-triage-verdicts`
**Branch**: `feature/smithy/mark/issue-triage-m1-f1`
**Created**: 2026-11-21
**Status**: Draft

## Artifact Hierarchy
<!-- audience: reviewer; mode: reference -->

- Feature map: [Triage Contract, feature 1](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md#feature-1-versioned-triage-verdicts)
- RFC: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)
- [Data model](versioned-triage-verdicts.data-model.md) and [contracts](versioned-triage-verdicts.contracts.md)

## User Scenarios & Testing
<!-- audience: reviewer; mode: reference -->

### User Story 1: Read a consistent recommendation across profiles (Priority: P1)

As an operator, I want every managed repository to use the same verdict vocabulary so I can understand the recommendation and its confidence when deciding what to do.

**Priority**: The shared vocabulary and validation gate are prerequisites for recording any verdict.

**Independent Test**: Validate a corpus of verdicts against the same versioned contract for march and smithycli.

1. Given an issue ready for work, when it receives a build verdict, then the verdict names one entry point and carries one confidence level and a rationale.
2. Given a question or support request, when the recommender classifies it, then it recommends close or needs definition. For needs definition, it supplies the grade and explains what information would make the issue actionable.
3. Given each invalid-output fixture, when the consumer validates it, then validation fails before any GitHub write and the failure is visible to the caller.
4. Given a valid build recommendation, when the operator reviews it, then its named destination is clear and the verdict alone neither dispatches work nor closes the issue.

### User Story 2: Use a compatible judgment provider (Priority: P2)

As a March maintainer, I want to use the open baseline and allow a future judgment provider to return the same verdict so that the consumer can apply one validation contract.

**Priority**: Provider compatibility builds on the shared verdict and validation contract.

**Independent Test**: Submit equivalent candidate verdicts from baseline and substitute judgment providers to the same validation boundary.

1. Given equivalent output from either provider, when the consumer validates it, then the same contract accepts or rejects it and the judgment interface has no GitHub write authority.
2. Given the open engine on its own, when a maintainer reads the open-core decision, then they can find the baseline exception, its scope, and the future plugin seam.

### Edge Cases

- An unsupported schema version fails closed. A rubric revision can use the same schema and has independent provenance.
- A grade without an explanation, or needs-definition details on a different outcome, fail validation.
- A high-confidence close verdict recommends closing. Issue mutation requires a separate authorized workflow.

## Dependency Order
<!-- audience: builder+ai-input; mode: reference -->

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| US1 | Read a consistent recommendation across profiles | — | specs/2026-11-21-015-versioned-triage-verdicts/01-read-a-consistent-recommendation-across-profiles.tasks.md |
| US2 | Use a compatible judgment provider | US1 | — |

## Requirements
<!-- audience: builder+ai-input; mode: reference -->

### Functional Requirements

- **FR-001 (US1)** The contract MUST use one versioned schema across all profiles with exactly one allowed outcome, one allowed confidence, and a nonblank rationale.
- **FR-002 (US1)** Needs definition MUST carry a grade from the shared scale and a nonblank explanation. Questions and support requests MUST resolve to close or needs definition.
- **FR-003 (US1)** Consumers MUST reject invalid verdicts before any GitHub write, including all five named rejection fixtures. Failures MUST surface as a diagnostic and an errored span when tracing is enabled. [March operating philosophy, rule 3](../../docs/operating-philosophy.md#3-failures-are-clean-exits-not-hangs)
- **FR-004 (US1)** A build verdict MUST recommend the named Smithy entry point seeded with the issue and its triage note. Intake requires explicit operator acceptance and milestone 6 compatibility checks.
- **FR-005 (US2)** March MUST publish the rubric, vocabulary, and baseline recommender under the open-core exception. Any future judgment plugin MUST return candidates through the same validation boundary with GitHub writes outside its interface. [March vision](../../docs/vision.md) · [Open-core boundary](../../docs/open-core-boundary.md#issue-triage-exception)

### Key Entities

- **Triage verdict** records one recommendation for the issue context the provider assessed.
- **Rubric revision** identifies the guidance used to produce a candidate, independently of the verdict schema version.

## Assumptions
<!-- audience: reviewer; mode: reference -->

- V1 uses the wire token `needs-definition` and a three-grade scale based on how much information the author needs to add. Grade measures definition and confidence measures certainty in the verdict.

## Specification Debt
<!-- audience: reviewer; mode: reference -->

_None._

## Out of Scope
<!-- audience: reviewer; mode: reference -->

Recommender execution and calibration, label provisioning and note writes, issue observation and re-entry, intake dispatch, and changes to Smithy stages.

## Success Criteria
<!-- audience: reviewer; mode: reference -->

- **SC-001** The same v1 contract accepts all eight outcomes and all three confidence levels across profiles and rejects all five mandatory invalid fixtures before any GitHub write.
- **SC-002** Each build outcome maps to one named destination. Needs definition has one shared grade scale and a required explanation.
- **SC-003** The published open-core record documents the baseline exception and the validated, read-only judgment seam.
