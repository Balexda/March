# Contracts: Versioned Triage Verdicts

**Feature**: [Specification](versioned-triage-verdicts.spec.md)
**Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md)
**Source RFC**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)

## Interfaces
<!-- audience: builder+ai-input; mode: reference -->

| Boundary | Input | Result |
|---|---|---|
| Read-only judgment | Issue title and body as untrusted text, available read-only repository context, and the selected rubric revision | One untrusted candidate verdict. The provider receives no GitHub write authority. |
| Verdict validation | Candidate output | One validated verdict conforming to the data model, or a failure identifying the invalid field or document. |

A candidate must be one JSON object with the exact fields allowed by its schema version. Reject malformed JSON, duplicate keys, unknown fields, unsupported versions, and values outside the model. A string is nonblank when it contains at least one non-whitespace character. Validate the complete candidate before the deterministic writer can apply any label or comment. Surface rejection as an errored validation result and an errored span when tracing is enabled.

## Rubric
<!-- audience: builder+ai-input; mode: reference -->

| Outcome | When to recommend it | Destination or meaning |
|---|---|---|
| `spark` | A promising idea still needs a problem and value statement. | `smithy.spark` for a PRD. |
| `ignite` | The problem is defined and the approach and milestones need agreement. | `smithy.ignite` for an RFC. |
| `render` | One scoped milestone needs to be decomposed into features. | `smithy.render` for a feature map. |
| `mark` | One scoped feature needs stories, requirements, and contracts. | `smithy.mark` for a single feature spec. |
| `strike` | The requested change is a small, bounded patch with clear expected behavior. | `smithy.strike` for a strike plan. The accepted route supersedes [the existing `legate.issue` intake](../../src/templates/legate/CLAUDE.prompt) for routed small patches. |
| `needs-definition` | Essential information for a useful recommendation is missing. | Ask the author for actionable clarification with a grade and explanation. |
| `controversial` | Competing interpretations or material trade-offs require operator judgment. | Surface for operator judgment. |
| `close` | The issue is answered, already covered, or calls for no repository work. | Recommend closure without closing the issue. |

Questions and support requests use `close` when they can be answered or redirected with available context and `needs-definition` when more information is needed. Confidence is `high` when evidence clearly supports the selected outcome, `medium` when some uncertainty remains, or `low` when the recommendation rests on limited evidence. Calibration belongs to the recommender milestone.

| Needs-definition grade | Meaning |
|---|---|
| `minor-gaps` | The request is clear and specific missing details prevent a recommendation. |
| `major-gaps` | The goal is evident but essential scope, evidence, or expected behavior is missing. |
| `insufficient` | The problem or request cannot yet be identified. |

## Rejection Fixtures
<!-- audience: builder+ai-input; mode: reference -->

Each input below must fail validation before any GitHub write.

| Case | Candidate JSON |
|---|---|
| Cut | `{"schemaVersion":1,"outcome":"cut","confidence":"high","rationale":"A task breakdown is needed."}` |
| Forge | `{"schemaVersion":1,"outcome":"forge","confidence":"high","rationale":"The implementation looks ready."}` |
| Unknown outcome | `{"schemaVersion":1,"outcome":"defer","confidence":"high","rationale":"The issue can wait."}` |
| Missing confidence | `{"schemaVersion":1,"outcome":"mark","rationale":"The feature needs a spec."}` |
| Multiple outcomes | `{"schemaVersion":1,"outcome":["mark","strike"],"confidence":"high","rationale":"Two routes seem plausible."}` |

## Integration Boundaries
<!-- audience: builder+ai-input; mode: reference -->

- Each build outcome recommends invoking the named Smithy verb with the issue and its triage note as freeform input, subject to explicit operator acceptance. Before enabling intake, milestone 6 verifies compatibility per verb and documents any upstream mapping or seed-only handoff for a verb that cannot accept the input.
- The open-core exception publishes the baseline judgment alongside the rubric and vocabulary. A future judgment plugin can supply candidates through the same read-only interface and validation boundary. A separate deterministic consumer owns any later GitHub writes. [Open-core boundary](../../docs/open-core-boundary.md#issue-triage-exception)
