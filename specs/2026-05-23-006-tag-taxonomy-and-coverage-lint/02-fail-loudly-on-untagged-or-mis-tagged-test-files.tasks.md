# Tasks: Fail Loudly on Untagged or Mis-tagged Test Files

**Source**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.spec.md` - User Story 2
**Data Model**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.data-model.md`
**Contracts**: `specs/2026-05-23-006-tag-taxonomy-and-coverage-lint/tag-taxonomy-and-coverage-lint.contracts.md`
**Story Number**: 02

---

## Slice 1: Add The Taxonomy Coverage Lint
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The repository has one deterministic npm-run lint that scans every current Vitest test file and fails with file-level diagnostics when the required tag tuple is missing, duplicated, or conflicting.

**Justification**: This slice delivers the whole User Story 2 contract in one coherent PR because discovery, tag-block parsing, diagnostics, tests, and the npm entrypoint are one validation surface.

**Addresses**: FR-005, FR-006, FR-007, FR-008, FR-009; Acceptance Scenario 2.1, Acceptance Scenario 2.2, Acceptance Scenario 2.3

### Tasks

- [x] **Add the taxonomy coverage lint**

  Add the lint implementation in the repository's script or testing infrastructure and expose it through the Coverage Lint Command contract. The lint should discover `*.test.ts` files according to FR-005, validate only the leading Test File Tag Block, and report failures using the Coverage Lint Verdict model for AS 2.1-2.3.

  _Acceptance criteria:_
  - The lint scans all repo `*.test.ts` files outside the generated dependency directories from FR-005.
  - Missing tag blocks or missing axes fail with diagnostics naming the path and axis.
  - Duplicate and conflicting tags fail with diagnostics naming the path, axis, and invalidity reason.
  - Valid files with exactly one tag from each required axis pass without rewriting files.
  - `npm run test:taxonomy` invokes the lint as the shared local and future CI entrypoint.
  - The change does not add staged layer scripts, quarantine routing, runtime tag guards, or Cucumber.js migration.

**PR Outcome**: Contributors can run `npm run test:taxonomy` and get a clean exit for a fully tagged suite or actionable file-level failures for untagged and mis-tagged Vitest files.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| Item | Resolution |
|------|------------|
| The lint will fail against the current untagged baseline (e.g. `src/castra/steward-skills.test.ts`, `src/contracts/public-surface.test.ts`, `src/herald/profiles/types.test.ts`, `src/pr-integration/eligibility.test.ts`, `src/testing/quarantine.test.ts`). | Expected. Failing on untagged files is this slice's intended outcome, not a defect. Bringing the tree green is **US3's** job (Preserve Existing Test Scope While Tagging the Baseline), which depends on US1+US2 per the spec dependency order. This slice deliberately does **not** tag existing files (acceptance criterion: "pass without rewriting files"). `npm run test:taxonomy` is the **local** entrypoint here; CI wiring is deferred (criterion 5: "future CI entrypoint"), so this slice does not turn `main` red in CI before US3 lands. |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Add The Taxonomy Coverage Lint | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Declare the Frozen Test Tag Vocabulary | depends on | The lint validates the leading tag tuple declarations introduced by User Story 1. |
| User Story 3: Preserve Existing Test Scope While Tagging the Baseline | depended upon by | Baseline preservation can rely on the lint to catch missing or conflicting taxonomy declarations. |
| User Story 4: Keep Operator Documentation Aligned With the New Taxonomy | depended upon by | Operator documentation can name the lint entrypoint after this story defines it. |
