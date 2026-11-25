# Data Model: GitHub Triage Labels and Signals

**Feature**: [Specification](github-triage-labels-and-signals.spec.md)
**Feature Map**: [Triage Contract](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md)
**Source RFC**: [Issue Triage into Smithy Entry Points](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)

## Entities

| Entity | Identity | Data and ownership |
|---|---|---|
| Repository label catalog | GitHub repository identity and label name | The [contract catalog](github-triage-labels-and-signals.contracts.md#label-catalog) is shared across profiles. GitHub stores the label definitions. |
| Issue triage labels | GitHub repository identity and issue number | GitHub stores the current set. Triage manages the state, outcome, and confidence groups by default. The operator may override any group and exclusively owns the acceptance and resubmit signals. |
| Issue observation and verdict provenance | Issue identity and distinct observed change or verdict revision | Herald preserves observed open/closed state, title/body hash, and label history. The sticky note's provenance supplies the original verdict and its content hash. This feature defines how consumers interpret these inputs. |

## Relationships and State

- A repository may serve multiple registered profiles. Provisioning works once per distinct repository.
- An issue with no state label is implicitly untriaged. Explicit state labels distinguish untriaged, triaged, and errored. A complete triaged recommendation has exactly one state label, one outcome label, and one confidence label. Outcome and confidence on an incomplete or conflicting snapshot grant no intake authority.
- An override is scoped to an issue, a managed label group, and the title/body hash at the time of the edit. Preserve the whole edited group, including a deliberate removal, so restoring another label in that group cannot undo the edit. If a new verdict is produced for the same hash, the override survives against that new baseline. A change of content retires existing overrides even if a later edit restores the old text.
- Use a deterministic hash of the ordered title and body text with unambiguous field boundaries. Treat a missing body as empty. Identical text yields the same hash across profiles. Comments, labels, timestamps, and rubric versions are outside the hash.
- An acceptance addition refers to the current build recommendation and issue content at that occurrence. Removing acceptance, changing the content or the effective recommendation, or losing evidence of the association makes it ineligible. Re-adding acceptance cannot duplicate a run for an issue already admitted by downstream intake.
