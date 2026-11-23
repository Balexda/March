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

Call shapes below are logical. They fix inputs, results, and errors, not a TypeScript module or route name, which the implementing slice chooses.

### Provision repository labels

```text
provisionTriageLabels(repositories, catalog) -> ProvisionResult | ProvisionFailure
```

| Input | Source | Constraint |
|---|---|---|
| `repositories` | Registered repositories from [Herald's profile registry](../../src/herald/profiles/types.ts) | Deduplicated by GitHub repository identity, so a repository shared by profiles is provisioned once. |
| `catalog` | The [label catalog](#label-catalog) above | Every entry is checked by name. |
| Access | Repository-scoped GitHub credential | Permission to list and create repository labels only. |

| Result field | Meaning |
|---|---|
| `repository` | GitHub repository identity, one row per distinct repository. |
| `created` | Catalog entries that were missing and are now created. |
| `alreadyPresent` | Catalog entries that already existed, including any confirmed after a concurrent create. Existing colors and descriptions are kept. |

Create missing definitions only. Leave existing definitions, labels outside the catalog, and all issue assignments untouched. A complete second run reports every entry as `alreadyPresent` and makes zero mutations.

| Error condition | Behavior |
|---|---|
| Registry or GitHub call fails or exceeds its bound | Return `ProvisionFailure` naming the repository and failed operation (list or create). Emit an errored span when tracing is enabled. |
| Some repositories or entries unconfirmed | Report the run as a failure for incomplete coverage, not as a partial success. |
| Concurrent create conflict | Re-check the definition. Count it as `alreadyPresent` only once confirmed, otherwise fail as above. |
| Retry after failure | Existing definitions and successful creates stay usable. A retry creates only the remaining missing entries. |

Apply [operating philosophy rules 2 and 3](../../docs/operating-philosophy.md#three-rules-of-thumb).

### Interpret issue labels and history

```text
interpretTriageLabels(issueSnapshot, observedChanges, verdictProvenance?) -> TriageInterpretation
```

| Input | Source | Constraint |
|---|---|---|
| `issueSnapshot` | Current GitHub labels, open/closed state, and title/body hash | GitHub is authoritative. A stale Herald mirror yields to it. |
| `observedChanges` | Herald's observation history of label, state, and content-hash changes | Each distinct change is consumed once. |
| `verdictProvenance` | The sticky note's original verdict and content hash, when available | Optional. When absent, attribution is treated as uncertain. |

| Result field | Meaning |
|---|---|
| `state` | `untriaged`, `triaged`, `errored`, or `unresolved`. An issue with no state label is untriaged. |
| `protectedGroups` | Managed label groups holding a same-content operator override, which a later verdict write must preserve. |
| `reentry` | `qualified` with the [trigger](#re-entry-triggers) that qualified it, `notQualified`, or `unresolved` when history is too incomplete to decide. Co-occurring triggers qualify once. A consumer defers on `unresolved` and re-evaluates once history is complete. It never treats `unresolved` as `notQualified`. |
| `intakeAuthorized` | `true` only for an observed addition of `triage:accepted` for the current, unambiguous triaged build recommendation on an open issue, with the signal still present. A point-in-time answer with the build outcome and content hash it was evaluated against. It is not durable authority on its own. |

Preserve operator edits on the same content by comparing verdict provenance with observed label changes. Operator and writer may share a GitHub identity, so attribute known writer changes using the recorded verdict and change history, never author identity alone. If attribution is uncertain, preserve observed same-content differences.

| Error condition | Behavior |
|---|---|
| Conflicting managed labels (for example two outcomes) | Leave them visible as an operator edit. `state` is `unresolved` and `intakeAuthorized` is `false`. |
| Acceptance association unverified, stale, or removed | `intakeAuthorized` is `false`. |
| Non-build outcome accepted, or confidence alone | `intakeAuthorized` is `false`. |
| Incomplete history | `reentry` is `unresolved` and the affected decision stays unresolved. Incomplete history cannot invent a re-entry edge. |

## Re-entry Triggers

| RFC trigger | Named contract element | Qualification |
|---|---|---|
| Title/body change | Content hash changed | A new observation of a different hash from the previous observed content. |
| Reopen | Issue reopened | A closed-to-open transition. |
| Explicit resubmit | Resubmit added | A distinct addition of `triage:resubmit`. To signal again, remove and reapply it. |

Apply these triggers to open issues, including those labeled `automated`. A persistent resubmit label or replay of a previously handled transition creates no new eligibility. Co-occurring triggers in one observation qualify once. Comment-only changes, timestamp changes alone, rubric revisions, and March's own triage label or note writes create no qualifying trigger. Treat `automated` as unrelated to eligibility so agent-filed issues can re-enter on the same genuine changes without self-triggering.

## Integration Boundaries

Provisioning changes repository label definitions only. A later deterministic writer uses the catalog and ownership rules for issue assignments. Later Herald observation and continuous triage supply and consume the change history. Intake consumes the acceptance decision under its own stable issue identity and deduplication rules. When it acts, intake re-reads the issue live from GitHub and proceeds only if all of these still hold: the issue is open, `triage:triaged` is its only state label, exactly one outcome label and one confidence label are present with no managed-label conflict, `triage:accepted` is present, and the build outcome and title/body hash match the authorized interpretation. If any check fails, for example `triage:errored` replaced `triage:triaged`, intake does not act.
