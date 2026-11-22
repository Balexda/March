# Feature Map: Triage Contract

**Source RFC**: `docs/rfcs/2026-003-issue-triage/issue-triage.rfc.md`
**Milestone**: 1 — Triage Contract
**Created**: 2026-11-20

## Features
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Feature 1: Versioned Triage Verdicts

```yaml
kind: backend
```

**Description**: Define one versioned verdict schema for all profiles. A verdict carries a single outcome and confidence, a rationale, and a grade and explanation for *needs definition*.

**User-Facing Value**: The same recommendation means the same thing in every repository and at every Smithy handoff.

**Scope Boundaries**:
- Includes the build outcomes `spark`, `ignite`, `render`, `mark`, and `strike`, the non-build outcomes *needs definition*, *controversial*, and *close*, and the confidence levels high, medium, and low. Questions and support requests resolve to *close* or *needs definition*. Define a needs-definition grade scale.
- Includes rejection fixtures for `cut`, `forge`, an unknown outcome, a missing confidence, and multiple outcomes. Invalid output fails validation before any write. [March operating philosophy](../../operating-philosophy.md#3-failures-are-clean-exits-not-hangs).
- Defines a build verdict as a recommendation to start at the named Smithy entry point with the issue and note as input. `render` targets a feature map, `mark` targets a single feature spec, and accepted `strike` supersedes `legate.issue` for routed small patches. Milestone 6 verifies verb compatibility and records any upstream mapping or seed-only handoff before enabling intake.
- Records the triage rubric, vocabulary, and baseline recommender exception in the open-core boundary record. A future judgment plugin can return the same validated verdict through the judgment interface, with GitHub writes outside that interface. [PRD decision SD-002](../../prds/2026-001-issue-triage.prd.md#sd-002--triage-judgment-open-vs-private) · [Open-core boundary](../../open-core-boundary.md).
- Excludes recommender execution, calibration, intake dispatch, and changes to Smithy stages.

### Feature 2: GitHub Triage Labels and Signals

```yaml
kind: backend
```

**Description**: Define and provision the full triage label namespace in every registered profile's repository. GitHub labels own current triage state. Herald's fold mirrors the labels and preserves observation history.

**User-Facing Value**: Operators can see triage state and express acceptance or resubmission through GitHub labels across profiles.

**Scope Boundaries**:
- Includes named labels for state, each outcome, and each confidence level, plus separate operator-owned acceptance and resubmit signals. Define which labels triage manages and how it preserves operator overrides until the issue content changes. Provisioning preserves unrelated labels such as `bug`, `enhancement`, and `area:*`, covers at least march and smithycli, and makes zero changes on a second run.
- Includes a reviewer-traceable mapping from each PRD outcome, confidence level, acceptance signal, resubmit signal, and re-entry trigger to one named contract element. The re-entry triggers are a change to the title/body content hash, reopening, and explicit resubmission. Comment-only activity, March's own writes, and rubric revisions do not trigger re-triage. Agent-filed `automated` issues re-enter on the same triggers, but their re-triage must not start an endless loop. Only explicit acceptance of a build verdict can authorize intake.
- Excludes issue observation, per-issue verdict writes, continuous triggering, and handling accepted work.

### Feature 3: Sticky Triage Notes

```yaml
kind: backend
```

**Description**: Define one triage note per issue that can be updated in place, with a public explanation and hidden provenance. The issue title and body stay intact.

**User-Facing Value**: Authors can see the reason for a verdict and what to clarify, and operators can trace a verdict to the rubric and issue content used at the time.

**Scope Boundaries**:
- Includes a hidden marker that identifies the note and records the rubric version, the issue content hash used for the verdict, the original verdict, any added repository context, and the needs-definition grade when applicable.
- Includes the published tone standard for communicating the needs-definition grade and explaining what would make the issue actionable.
- Excludes GitHub comment writes and updates that link to a merged intake artifact.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| F1 | Versioned Triage Verdicts | — | specs/2026-11-21-015-versioned-triage-verdicts/ |
| F2 | GitHub Triage Labels and Signals | F1 | — |
| F3 | Sticky Triage Notes | F1 | — |

## Cross-Milestone Dependencies
<!-- audience: reviewer; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone 2: Single-Issue Recommender and Operator Backfill | depended upon by | Validates recommendations and records them through the label and note contracts. |
| Milestone 3: Issue Observation in Herald | depended upon by | Mirrors authoritative GitHub labels and observes issue content hashes. |
| Milestone 4: Continuous Triage and Re-entry | depended upon by | Uses the contract's re-entry triggers and prior-verdict provenance through milestones 2 and 3. |
| Milestone 5: Operator Surface and Escalation Visibility | depended upon by | Displays verdicts and uses the same operator signals through milestone 4. |
| Milestone 6: Accepted-Verdict Intake | depended upon by | Uses the build verdict, acceptance signal, and issue note to route approved work. |
