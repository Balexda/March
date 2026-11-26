# Tasks: Create a Reviewable Commit and Push Branch

**Source**: `specs/2026-05-24-006-pr-integration/pr-integration.spec.md` — User Story 3
**Data Model**: `specs/2026-05-24-006-pr-integration/pr-integration.data-model.md`
**Contracts**: `specs/2026-05-24-006-pr-integration/pr-integration.contracts.md`
**Story Number**: 03

## Slice 1: Publish the Recorded Integration Branch
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Publish one focused commit for an admitted extraction on the exact recorded branch and return a bounded outcome to the integration caller.

**Justification**: Commit creation and push share a retry boundary because a local commit can survive a failed or interrupted push. Follow [March's vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for headless execution and bounded failure.

**Addresses**: FR-007, FR-008, the commit portion of FR-009, FR-013–FR-017 and AS 3.1–3.5.

### Tasks

- [ ] **Create or recover the focused commit**

  Connect the publisher to US2’s authorized checkout and staged result in `src/hatchery/spawn-handoff.ts`. Check for reuse before reapplying the extraction (AS 3.1, AS 3.4, AS 3.5).

  _Acceptance criteria:_
  - A new commit contains only the validated changes and required review metadata. Reject unrelated staged content, including extra edits to a touched path. Exclude unrelated unstaged changes.
  - Reuse requires equivalent committed content for the same spawn and patch digest on the recorded branch. An empty index, a matching path list, or matching metadata alone cannot establish equivalence.
  - Repeated or overlapping attempts for unchanged content cannot create duplicate commits. Missing or invalid staged content with no equivalent commit produces a stable commit failure before push.
  - Local Git coverage exercises focused content, unrelated changes, empty staging, and retries after a commit already exists.

- [ ] **Push the recorded branch and gate PR handoff on success**

  Publish through the existing Steward credential boundary and return the contract’s `IntegrationCommit` (AS 3.2, AS 3.3, AS 3.4).

  _Acceptance criteria:_
  - Push the verified commit to the exact recorded branch. Accept an equivalent remote head. Fail safely on rejected divergence.
  - Auth, network, rejection, and timeout failures block PR handoff. Preserve the local commit across rollback and report stable, bounded, redacted failures with available identifiers.
  - Bound both Git phases without prompts. Emit deterministic slice child spans, errored on failure. Update affected subsystem contracts.
  - The downstream Steward reviews the published commit and escalates needed corrections without editing or republishing it.
  - Local Git remotes cover exact-ref publication, PR gating, and same-handoff retry after push failure.

**PR Outcome**: The existing PR handoff receives a verified, published branch. A failed publication reports the failure and keeps any focused local commit available for retry.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The exact persistence owner for `PrIntegrationResult` must be confirmed against the live Brood registry and any Herald projection expectations before implementation tasks are cut. | Domain & Data Model | Medium | Medium | inherited | US3 returns `IntegrationCommit` to its caller and records no persisted state. Durable recording of the full outcome remains US5 scope. |
| SD-003 | inherited from spec: The exact verification commands to run before PR creation are not specified here; implementation planning must decide whether to run repository defaults, spec-provided checks, or no verification in the initial slice. | Functional Scope | Medium | Medium | inherited | US3 publishes the branch without choosing a pre-PR verification policy. The decision moves to US4, which consumes the published head. |

## Open Implementation Questions

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which existing handoff interface can carry commit and push outcomes back to the integration caller without committing to a persistence owner? | S1 | reading code plus a check of the live Brood registry and Herald projection expectations | spec:SD-002 |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Publish the Recorded Integration Branch | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US2 | depends on | Supplies the authorized checkout and verified staged changes for a fresh commit. |
| US4 | depended upon by | Consumes the published head. Pre-PR verification policy in SD-003 remains open. |
| US5 | depended upon by | Owns durable recording of the full integration outcome. |
