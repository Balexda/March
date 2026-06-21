# Tasks: Exclude Quarantined Tests From the Staged Gate

**Source**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.spec.md` — User Story 2
**Data Model**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.data-model.md`
**Contracts**: `specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.contracts.md`
**Story Number**: 02

---

## Slice 1: Exclude Quarantine From Staged Selection
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The four staged test scripts honor `tests/quarantine/` as a stable repo-relative directory-path exclusion before selecting tests by layer tags.

**Justification**: This slice stands alone because it makes parked tests stop blocking the deterministic staged gate while preserving normal staged execution for non-quarantined tests in the same layer.

**Addresses**: FR-004, FR-005; Acceptance Scenario 2.1, Acceptance Scenario 2.2, Acceptance Scenario 2.3

### Tasks

- [x] **Honor the quarantine exclusion contract**

  Keep the staged-script selector in `scripts/run-layered-tests.mjs` and its tests aligned with the Directory-Path Exclusion Contract. The four staged scripts must exclude `tests/quarantine/` by path before layer/tag matching while continuing to select non-quarantined deterministic CI tests for AS 2.1-AS 2.3.

  _Acceptance criteria:_
  - Each staged script exposes `tests/quarantine/` as its quarantine exclusion path.
  - Tests under `tests/quarantine/` are excluded from `test:l0`, `test:l1`, `test:l2-cassette`, and `test:l3-cassette`.
  - Exclusion is directory-path based and does not depend on tag predicates.
  - Non-quarantined tests with matching layer, deterministic, and CI tags remain selected.
  - The behavior is covered by focused local tests without adding CI fan-out, routing, roster, or M6 SLA behavior.

**PR Outcome**: A parked test under `tests/quarantine/` is excluded from every staged script, while matching non-quarantined tests in the same layer still run.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Inherited SD-101 (feature map): does the routing primitive's source live in `src/testing/` (production code, operator-CLI growth path) or in test-only code (`tests/support/` / co-located under `tests/quarantine/`)? The RFC pins the `tests/quarantine/` directory but does not pin where the `quarantine.ts` logic lives; the choice changes which source tree this feature writes into. | clarify:Constraints | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Inherited SD-103 (feature map): make explicit that SD-101 blocks only the routing logic's source-tree location, not all of Feature 3 — the `tests/quarantine/` directory-path contract Feature 2 consumes is pinned by the RFC and is independent of the open location question. | plan-review:Logical gap | Important | Low | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Exclude Quarantine From Staged Selection | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Park a Failing Test Without Deleting It | depends on | This story consumes the canonical `tests/quarantine/` location established by parking. |
| User Story 3: List Quarantined Tests in a Generated Roster | depended upon by | The generated roster can assume the staged gate treats `tests/quarantine/` as the exclusion surface. |
| User Story 4: Document the Quarantine Primitive for Contributors | depended upon by | Contributor documentation can describe the staged-gate effect after the exclusion contract exists. |
