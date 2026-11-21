# Data Model: Versioned Triage Verdicts

**Feature**: [Specification](versioned-triage-verdicts.spec.md)
**Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md)
**Source RFC**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)

## Entities
<!-- audience: builder+ai-input; mode: reference -->

| Verdict field | Type | Constraint |
|---|---|---|
| `schemaVersion` | integer | Required. V1 accepts exactly `1`. |
| `outcome` | string | Required. One of `spark`, `ignite`, `render`, `mark`, `strike`, `needs-definition`, `controversial`, `close`. |
| `confidence` | string | Required. One of `high`, `medium`, `low`. |
| `rationale` | string | Required. Nonblank reason for the recommendation. |
| `needsDefinition` | object | Required only for `needs-definition` and forbidden otherwise. Contains exactly `grade` and `explanation`. |
| `needsDefinition.grade` | string | One of `minor-gaps`, `major-gaps`, `insufficient`. |
| `needsDefinition.explanation` | string | Nonblank description of what the author can add or clarify. |

## Relationships and Lifecycle
<!-- audience: builder+ai-input; mode: reference -->

The consumer binds each validated verdict to the issue and input revision it supplied to judgment. It also tracks the rubric revision used for that evaluation. The rubric revision belongs to evaluation provenance and may change independently of `schemaVersion`. The sticky-note feature defines how that provenance is recorded.

| Stage | Result |
|---|---|
| Judgment returns untrusted candidate output | The consumer validates the complete candidate. |
| Validation succeeds | The verdict is eligible for later recording. It conveys no authority to act on the issue. |
| Validation fails | The candidate is discarded and a failure is surfaced. No issue write is eligible. |

This feature introduces no storage identity or database. Repeated evaluations can produce distinct verdicts for the same issue.
