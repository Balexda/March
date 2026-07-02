# Tasks: Report Source and Contract Freshness Drift

**Source**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.spec.md` - User Story 3
**Data Model**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.data-model.md`
**Contracts**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.contracts.md`
**Story Number**: 03

---

## Slice 1: Evaluate Changed-File Freshness Drift
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Extend `npm run docs:contracts:check` so it can compare deterministic changed-file input with the populated contract freshness mapping and report freshness drift for AS 3.1-3.3.

**Justification**: Freshness drift is only useful when changed files can be supplied deterministically and evaluated against the already-validated config in the same verdict path. Splitting changed-file collection from drift evaluation would leave the command unable to satisfy User Story 3, while deterministic output cleanup, CI wiring, Smithy-agent enforcement, and AUTOGEN extraction remain later work.

**Addresses**: FR-009, FR-010, FR-011, FR-012, FR-013, FR-014; Acceptance Scenarios 3.1, 3.2, 3.3

### Tasks

- [x] **Accept deterministic changed-file input**

  Extend the docs-contract verdict command to build a Changed File Set from local inputs without relying on live March services. The command should accept explicit changed-file input for fixture and local use, support git-derived input when a base ref is provided, normalize paths to repo-relative form, and fail cleanly when the requested changed-file source cannot be evaluated.

  _Acceptance criteria:_
  - Callers can provide an explicit changed-file list that is consumed by the freshness category.
  - Callers can provide a git diff base and receive deterministic repo-relative changed paths.
  - Deleted and renamed paths remain represented as changed paths for freshness evaluation.
  - Absolute paths, escaping paths, and paths outside the repository root fail with bounded diagnostics.
  - An unavailable git base exits non-zero with a bounded diagnostic rather than hanging or prompting.
  - The command still runs from filesystem and git inputs without Docker, network, or live March services.

- [x] **Report source-to-contract freshness drift**

  Extend the verdict evaluator so changed public source paths are matched against validated freshness entries and require the owning contract path to appear in the same changed-file set. The freshness check should satisfy AS 3.1-3.3 while preserving the existing presence, section-schema, and config behavior.

  _Acceptance criteria:_
  - A changed source path matching a configured selector passes freshness when the owning contract path is also changed.
  - A changed source path matching a configured selector fails freshness when the owning contract path is unchanged.
  - Freshness diagnostics include the freshness category, owning name, source path, and contract path.
  - Contract-only changes do not fail freshness solely because no mapped public source changed.
  - Unmapped changed paths do not create freshness failures.
  - Diagnostics remain bounded and deterministic across presence, section-schema, config, and freshness categories.

**PR Outcome**: Operators can run `npm run docs:contracts:check` with deterministic changed-file input to verify that mapped public source changes are accompanied by the owning contract artifact. The command reports freshness drift with bounded diagnostics and still avoids CI enforcement, Smithy-agent enforcement, AUTOGEN extraction, runtime subsystem behavior, or live-service dependencies.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The implementation must choose whether the verdict output is JSON, stable text, or both. The spec requires stable bounded diagnostics but leaves transport shape to slicing. | Interface Shape | Low | Medium | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Evaluate Changed-File Freshness Drift | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Validate Required Contract Presence | depends on | US3 uses the verdict command surface and required contract set established by US1. |
| User Story 2: Populate and Validate Contract Freshness Mapping | depends on | US3 uses the populated freshness config and ownership validation from US2 before comparing changed public sources with contract artifacts. |
| User Story 4: Provide Deterministic Local Verdict Output | depended upon by | US4 can stabilize final local output once freshness drift evaluation exists alongside presence and config checks. |
