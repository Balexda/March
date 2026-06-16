# Tasks: Apply the Policy on a Touching PR Without Relitigation

**Source**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.spec.md` — User Story 3
**Data Model**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.data-model.md`
**Contracts**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.contracts.md`
**Story Number**: 03

---

## Slice 1: Add Touching-PR Classification Guidance
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `CONTRIBUTING.md` makes the Test Layer Migration policy directly applicable to a touching PR so an author and reviewer classify the same governed-test diff the same way without external clarification.

**Justification**: User Story 3 depends on the rule text from User Story 1 and the governed-set record from User Story 2, then validates their day-to-day use in review. A single documentation slice is sufficient because the feature remains a written policy and introducing runtime enforcement, a deferral system, or port mechanics would exceed the spec.

**Addresses**: FR-003, FR-004, FR-005, FR-008, FR-009, FR-010; Acceptance Scenarios 3.1, 3.2, 3.3

### Tasks

- [ ] **Add touching-PR classification guidance**

  Update `CONTRIBUTING.md`'s Test Layer Migration policy so a PR author and reviewer can apply the written conditions to concrete governed-file diffs for AS 3.1-3.3. Keep the change documentation-only and preserve the existing governed set, starting-state record, non-preemptive-port rule, and adjacent-feature boundaries.

  _Acceptance criteria:_
  - The policy clearly classifies material governed-file edits for AS 3.1.
  - The policy clearly classifies non-material governed-file edits for AS 3.2.
  - The policy gives authors and reviewers the same written basis for AS 3.3.
  - The policy continues to key the trigger on edits to governed test files themselves.
  - Material edits still require a same-PR Cucumber.js port of the affected scenario.
  - Non-material edits and absent triggers still leave the governed tests in vitest.
  - The change adds no runtime enforcement, staged-script changes, quarantine routing, or port mechanics.

**PR Outcome**: A touching PR can cite the policy to classify its governed-test diff as material or non-material, and reviewers have the same documented decision path without reopening the material-change debate.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The RFC gap-analysis baseline (2026-05-20), the feature map, and the merged Feature 1 spec (`specs/2026-05-23-006-tag-taxonomy-and-coverage-lint`, FR-011) all name `src/hatchery/legate-container.test.ts` as a governed L2 test, but that file and its source were deleted in commit `6983f5f` (#256, retiring the per-profile legate docker-run path). This spec narrows the governed set to the two surviving files; the upstream artifacts still reference the removed file and should be reconciled. | review:Staleness | Medium | High | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Add Touching-PR Classification Guidance | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Author the Test Layer Migration Policy | depends on | US3 depends on the written material and non-material trigger rule before applying it to concrete touching-PR diffs. |
| User Story 2: Record the Starting State of the Governed Tests | depends on | US3 depends on the governed-set and starting-state record before deciding whether the migration trigger applies to a touched file. |
