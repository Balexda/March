# Feature Specification: GitHub Triage Labels and Signals

**Spec Folder**: `2026-11-23-018-github-triage-labels-and-signals`
**Branch**: `feature/smithy/mark/issue-triage-m1-f2`
**Created**: 2026-11-23
**Status**: Draft

## Artifact Hierarchy

- [Triage Contract, feature 2](../../docs/rfcs/2026-003-issue-triage/01-triage-contract.features.md#feature-2-github-triage-labels-and-signals)
- [Issue Triage RFC](../../docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md)
- [F1 verdict model](../2026-11-21-015-versioned-triage-verdicts/versioned-triage-verdicts.data-model.md)
- [Data model](github-triage-labels-and-signals.data-model.md) and [contracts](github-triage-labels-and-signals.contracts.md)

## User Scenarios & Testing

### User Story 1: See the same triage labels across repositories (Priority: P1)

As an operator, I want every registered repository to expose the same triage vocabulary so I can read its issues without learning profile-specific labels.

**Priority**: Every profile needs the shared catalog before its issues can display the same state and verdict.

**Independent Test**: Provision against registered march and smithycli repositories and compare the label catalogs and write counts across two runs.

1. Given repositories with missing triage labels and unrelated labels, provisioning creates the missing catalog entries in every registered repository and preserves `bug`, `enhancement`, `area:*`, and other unrelated labels.
2. Given complete catalogs from the first run, a second run makes zero GitHub mutations, including when two profiles share a repository.
3. Given a failed repository operation, provisioning reports the failed repository and returns a bounded failure. A retry completes any missing entries.

### User Story 2: Control triage through issue labels (Priority: P1)

As an operator, I want my edits, acceptance, and resubmission to have predictable effects so I can correct recommendations and decide when work may begin.

**Priority**: Issue labels are the current state and carry the authorization signal used by intake.

**Independent Test**: Evaluate label and issue-history fixtures against the contract, without provisioning or dispatch.

1. Given a hand-edited managed label, the GitHub label set is authoritative even when Herald's mirror lags. A subsequent verdict for the same content, including after reopen or resubmission, preserves the edit. When title or body content changes, the override expires.
2. Given an open issue, an observed content hash change, reopen, or fresh resubmit signal each independently qualifies it for re-entry, including on an `automated` issue. Repeated observations of the same change, comment-only activity, March's own writes, and rubric-only changes cause zero re-triage runs.
3. Given any build outcome, explicit acceptance of the current verdict can authorize intake. An absent, stale, or ambiguous acceptance cannot authorize intake. Explicit acceptance of each non-build outcome also grants no authority.

### Edge Cases

- Catalog entries may already exist with custom colors or descriptions. Their names are sufficient for provisioning.
- Conflicting labels remain visible as an operator edit. An ambiguous verdict cannot authorize intake.
- Resubmit and reopen can arrive with a content change in the same observation. They qualify the same issue once for that observation.

## Dependency Order

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| US1 | See the same triage labels across repositories | — | specs/2026-11-23-018-github-triage-labels-and-signals/01-see-the-same-triage-labels-across-repositories.tasks.md |
| US2 | Control triage through issue labels | — | specs/2026-11-23-018-github-triage-labels-and-signals/02-control-triage-through-issue-labels.tasks.md |

Both stories share the catalog and can be verified independently.

## Requirements

### Functional Requirements

- **FR-001 (US1, US2)** Define one named label per state, outcome, confidence, acceptance, and resubmit value in the shared catalog. Outcomes and confidences map one-to-one to F1.
- **FR-002 (US1)** Ensure the full catalog exists in every repository registered with Herald, including march and smithycli. Create only missing catalog entries with repository-scoped access. Report failures with repository context and an errored span when tracing is enabled. [March vision](../../docs/vision.md) · [March operating philosophy](../../docs/operating-philosophy.md)
- **FR-003 (US2)** Treat GitHub issue labels as authoritative and Herald as a mirror with observation history. Preserve operator changes to managed label groups until the title/body hash changes. Keep acceptance and resubmit under operator ownership.
- **FR-004 (US2)** Define re-entry for title/body changes, reopening, and explicit resubmit, including for `automated` issues. Recognize changes once and ignore comment activity, March's own writes, and rubric-only revisions.
- **FR-005 (US2)** Require an unambiguous current build verdict and explicit operator acceptance of that verdict before the labels can authorize intake.

### Key Entities

- Repository label catalog
- Issue triage labels
- Issue observation and verdict provenance

## Assumptions

- Label provisioning ensures names exist. Existing color and description choices are preserved.
- GitHub label management permissions define who can express an operator signal. A signal's association with a verdict depends on observation history and verdict provenance.

## Specification Debt

_None._

## Out of Scope

Issue observation and Herald event changes, per-issue verdict or note writes, continuous scheduling, recommender execution, and accepted-work handling.

## Success Criteria

- **SC-001** The catalog covers every registered repository, including march and smithycli. The second run makes zero writes and unrelated labels survive both runs.
- **SC-002** Each PRD outcome and confidence and each RFC acceptance signal, resubmit signal, and re-entry trigger maps to one named contract element.
- **SC-003** Same-content operator overrides survive re-triage. Each positive re-entry fixture qualifies once, each excluded activity qualifies zero times, and only explicit acceptance of a current build verdict can authorize intake.
