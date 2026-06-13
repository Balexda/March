# Tasks: Record the Starting State of the Governed Tests

**Source**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.spec.md` — User Story 2
**Data Model**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.data-model.md`
**Contracts**: `specs/2026-06-06-009-test-layer-migration-policy/test-layer-migration-policy.contracts.md`
**Story Number**: 02

---

## Slice 1: Record the Governed Test Set
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `CONTRIBUTING.md` names the exact governed legacy L2 tests and records the corrected starting-state facts that make the migration trigger actionable.

**Justification**: User Story 2 is a documentation-only increment that completes the policy's scope record without changing the trigger conditions owned by User Story 1. The governed files and their starting state are tightly coupled, so splitting them would leave contributors unable to decide whether AS 2.1-2.3 applies to a file they are touching.

**Addresses**: FR-002, FR-007; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [x] **Record the governed test starting state**

  Update `CONTRIBUTING.md`'s Test Layer Migration policy content so it records the governed set and corrected starting state for AS 2.1-2.3. Keep the change documentation-only and avoid altering runtime code, staged scripts, tag taxonomy, quarantine routing, or port mechanics.

  _Acceptance criteria:_
  - The policy names exactly the governed files required by AS 2.1.
  - The deleted baseline file from SD-002 is not named as governed.
  - The policy records the starting-state facts required by AS 2.2.
  - The policy states the migration trigger applies only to the governed set for AS 2.3.
  - The policy does not redefine the material and non-material trigger behavior owned by User Story 1.
  - No governed test is ported or edited as part of this slice.

**PR Outcome**: Contributors can identify whether a file is governed by the migration policy and see the corrected vitest, tag, mock, and no-real-Docker starting state before applying the trigger rule.

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
| S1 | Record the Governed Test Set | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Apply the Policy on a Touching PR Without Relitigation | depended upon by | US3 depends on both the written trigger rule from US1 and this governed-set record before validating concrete diff classification. |
