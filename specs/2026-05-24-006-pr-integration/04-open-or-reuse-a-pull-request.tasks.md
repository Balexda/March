# Tasks: Open or Reuse a Pull Request

**Source**: `specs/2026-05-24-006-pr-integration/pr-integration.spec.md` — User Story 4
**Data Model**: `specs/2026-05-24-006-pr-integration/pr-integration.data-model.md`
**Contracts**: `specs/2026-05-24-006-pr-integration/pr-integration.contracts.md`
**Story Number**: 04

## Slice 1: Publish a Pull Request for the Pushed Branch
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Return the open GitHub pull request or a terminal publication failure for the verified, pushed integration branch.

**Justification**: Lookup, creation, and retry share the same repository and head identity. Keep publication within the Steward credential boundary and follow [March's vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for bounded, headless execution.

**Addresses**: FR-009 (PR deduplication), FR-010–FR-013, FR-014–FR-017 (publication outcome and telemetry), FR-018, and AS 4.1–4.5.

### Tasks

- [ ] **Build bounded review metadata from the validated handoff**

  Extend the handoff in `src/hatchery/spawn-handoff.ts` and preserve the summary and validation sections in the Steward PR skill (AS 4.4).

  _Acceptance criteria:_

  - The title and body have explicit size limits. The body retains the spawn ID, backend, exact branch, extraction summary, touched paths, and verification status even when optional detail is truncated.
  - Use validated handoff facts and available verification outcomes. Report unavailable verification explicitly. Exclude raw output and redact credentials from published text.
  - Coverage exercises oversized metadata, sensitive input, and absent verification results.

- [ ] **Open or reuse the PR through the Steward**

  Extend the existing Castra-driven Steward handoff and PR skill to publish after US3 confirms the pushed commit. Return the publisher outcome to the integration caller (AS 4.1, AS 4.2, AS 4.3, AS 4.5).

  _Acceptance criteria:_

  - Match open PRs by target repository and exact source repository and head. Return the existing record on retry, including after a concurrent creation or ambiguous response.
  - Among matched open PRs, reuse one whose base equals the resolved base. Only when no matched PR targets the resolved base, return a defined non-success outcome that carries the mismatched PR's number and base. Never report that case as a successful publication (SD-004).
  - If only closed PRs exist, attempt a fresh PR. Use the configured base or the repository's authoritative default. An unresolved base prevents creation.
  - Return the contract's PR record on success. Auth, permission, network, and timeout failures return a stable terminal reason, pushed branch, commit, and bounded redacted diagnostic.
  - Bound lookup and creation without prompts. Emit deterministic slice child spans, errored on failure. Update affected subsystem contracts.
  - Cover creation, reuse, concurrent attempts, closed-only history, unknown base, and terminal failures without requiring live GitHub access.

**PR Outcome**: A published integration branch yields one reviewable open PR or a terminal result with enough context to retry or escalate. US5 owns durable recording.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-002 | Terminal outcome persistence owner | Domain & Data Model | Medium | Medium | spec:SD-002 |
| SD-003 | Pre-PR verification policy | Functional Scope | Medium | Medium | spec:SD-003 |
| SD-004 | Open PR on the same head targets a different base | Data Integrity & Integration | Medium | Medium | local |

### SD-004 — Open PR on the same head targets a different base

When the only open PR for the integration head targets a base other than the resolved base, should integration fail terminally or retarget that PR? FR-011 and the contracts key reuse on the head branch alone, and the data model does not validate `baseBranch` on reuse. This slice only requires that the case is not reported as success. US5 needs the chosen outcome to record terminal state.

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How can the Castra-managed Steward return the publication outcome to the Hatchery caller? | S1 | reading code | local |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Publish a Pull Request for the Pushed Branch | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US3 | depends on | Supplies the verified commit and its exact pushed branch. |
| US5 | depended upon by | Consumes the publication outcome for durable terminal state. |
