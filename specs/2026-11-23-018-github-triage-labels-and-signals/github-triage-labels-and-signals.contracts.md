# Contracts: GitHub Triage Labels and Signals

**Feature**: [Specification](github-triage-labels-and-signals.spec.md)
**Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md)
**Source RFC**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)

## Label Catalog

The catalog maps the [PRD](../../docs/prds/2026-001-issue-triage.prd.md) vocabulary and the RFC's state and signals to exact GitHub label names.

| Group | Meaning | Contract element | Issue assignment owner |
|---|---|---|---|
| State | Untriaged | `triage:untriaged` | Triage, subject to operator override |
| State | Triaged | `triage:triaged` | Triage, subject to operator override |
| State | Errored | `triage:errored` | Triage, subject to operator override |
| Outcome | Spark | `triage:spark` | Triage, subject to operator override |
| Outcome | Ignite | `triage:ignite` | Triage, subject to operator override |
| Outcome | Render | `triage:render` | Triage, subject to operator override |
| Outcome | Mark | `triage:mark` | Triage, subject to operator override |
| Outcome | Strike | `triage:strike` | Triage, subject to operator override |
| Outcome | Needs definition | `triage:needs-definition` | Triage, subject to operator override |
| Outcome | Controversial | `triage:controversial` | Triage, subject to operator override |
| Outcome | Close | `triage:close` | Triage, subject to operator override |
| Confidence | High | `triage:confidence-high` | Triage, subject to operator override |
| Confidence | Medium | `triage:confidence-medium` | Triage, subject to operator override |
| Confidence | Low | `triage:confidence-low` | Triage, subject to operator override |
| Signal | Explicit acceptance | `triage:accepted` | Operator |
| Signal | Explicit resubmission | `triage:resubmit` | Operator |

## Interfaces

### Provision repository labels

**Inputs** include registered repositories from [Herald's profile registry](../../src/herald/profiles/types.ts), the catalog above, and repository-scoped permission to list and create repository labels.

**Result** reports each repository's created and already-present catalog entries. Create missing definitions only. Leave existing definitions, labels outside the catalog, and all issue assignments untouched. A concurrent create counts as already present only after confirming the required definition exists.

**Failure** identifies the repository and failed operation. Bound registry and GitHub calls, report incomplete coverage as failure, and emit an errored span when tracing is enabled. Existing definitions and successful creates remain usable on retry. Apply [operating philosophy rules 2 and 3](../../docs/operating-philosophy.md#three-rules-of-thumb).

### Interpret issue labels and history

**Inputs** include current GitHub labels and issue state, the title/body hash, observed changes, and original verdict provenance when available.

**Result** provides current triage state, protected label groups, whether the observation qualifies for re-entry, and whether explicit acceptance can authorize intake. A stale Herald mirror yields to GitHub. Compare original verdict provenance and observed label changes to preserve operator edits on the same content. Since operator and writer may share a GitHub identity, attribute known writer changes using the recorded verdict and change history, never author identity alone. If attribution is uncertain, preserve observed same-content differences.

**Invalid or incomplete input** leaves the affected decision unresolved. Conflicting labels or an unverified acceptance association grant no intake authority. Incomplete history cannot invent a re-entry edge. A valid acceptance requires an observed addition of `triage:accepted` for the current unambiguous triaged build recommendation on an open issue, and the signal must still be present. Confidence alone grants no authority.

## Re-entry Triggers

| RFC trigger | Named contract element | Qualification |
|---|---|---|
| Title/body change | Content hash changed | A new observation of a different hash from the previous observed content. |
| Reopen | Issue reopened | A closed-to-open transition. |
| Explicit resubmit | Resubmit added | A distinct addition of `triage:resubmit`. To signal again, remove and reapply it. |

Apply these triggers to open issues, including those labeled `automated`. A persistent resubmit label or replay of a previously handled transition creates no new eligibility. Co-occurring triggers in one observation qualify once. Comment-only changes, timestamp changes alone, rubric revisions, and March's own triage label or note writes create no qualifying trigger. Treat `automated` as unrelated to eligibility so agent-filed issues can re-enter on the same genuine changes without self-triggering.

## Integration Boundaries

Provisioning changes repository label definitions only. A later deterministic writer uses the catalog and ownership rules for issue assignments. Later Herald observation and continuous triage supply and consume the change history. Intake consumes the acceptance decision under its own stable issue identity and deduplication rules.
