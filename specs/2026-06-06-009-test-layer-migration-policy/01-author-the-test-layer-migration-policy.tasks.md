# Tasks: Author the Test Layer Migration Policy

**Source**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.spec.md` — User Story 1
**Data Model**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.data-model.md`
**Contracts**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.contracts.md`
**Story Number**: 01

---

## Slice 1: Add The Migration Trigger Policy
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `CONTRIBUTING.md` contains a discoverable "Test Layer Migration" policy that classifies material and non-material edits to governed legacy L2 tests without requiring a preemptive port.

**Justification**: User Story 1 is a documentation-only deliverable whose acceptance scenarios all depend on one coherent policy section. Splitting the material, non-material, and no-trigger outcomes would leave the rule uncitable, while recording the governed set's corrected starting state belongs to User Story 2.

**Addresses**: FR-001, FR-003, FR-004, FR-005, FR-006, FR-008, FR-009, FR-010; Acceptance Scenarios 1.1, 1.2, 1.3, 1.4

### Tasks

- [x] **Document the migration trigger policy**

  Add a "Test Layer Migration" heading under `CONTRIBUTING.md`'s `## Testing` section and write the policy text for material, non-material, and no-trigger outcomes. The text should satisfy AS 1.1-1.4 and the Test Layer Migration Policy contract without introducing runtime code, staged-script changes, quarantine routing, or the governed-set starting-state record owned by User Story 2.

  _Acceptance criteria:_
  - `CONTRIBUTING.md` has a discoverable "Test Layer Migration" heading under `## Testing`.
  - The policy enumerates the material edit conditions required by AS 1.2.
  - The policy states the trigger keys on a material edit to a governed test file itself.
  - The policy enumerates the non-material edit classes required by AS 1.3.
  - A material edit requires a same-PR Cucumber.js port of the affected scenario.
  - When no material trigger is met, the governed tests stay in vitest with no preemptive port.
  - The change does not redefine tag taxonomy, staged scripts, quarantine routing, or port mechanics.

**PR Outcome**: Contributors can cite `CONTRIBUTING.md` to decide whether an edit to a governed legacy L2 test is material, non-material, or no-trigger, without relying on a new command or preemptively porting tests.

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
| S1 | Add The Migration Trigger Policy | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Apply the Policy on a Touching PR Without Relitigation | depended upon by | US3 depends on the written trigger rule from this story and the governed-set record from US2 before validating concrete diff classification. |
