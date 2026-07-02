# Tasks: Map Extraction Inputs to Contract Owners

**Source**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.spec.md` - User Story 3
**Data Model**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.data-model.md`
**Contracts**: `specs/2026-06-07-010-typescript-public-interface-autogen-extraction/typescript-public-interface-autogen-extraction.contracts.md`
**Story Number**: 03

---

## Slice 1: Resolve Owned Extraction Surfaces
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Add the filesystem-only ownership layer that turns configured contract-source selectors into deterministic, non-overlapping source surfaces for the public TypeScript extractor.

**Justification**: User Story 3 is one coherent PR because ownership loading, selector resolution, overlap rejection, and Steward role handling form a single validation boundary. The slice consumes the User Story 1 extractor output shape but stops before AUTOGEN marker replacement, check/write command behavior, CI wiring, or generated contract writes.

**Addresses**: FR-002, FR-013, FR-014, FR-015, FR-016, FR-017; Acceptance Scenarios 3.2, 3.3, and the owner-to-source input precondition of 3.1. The generated-block-to-contract association that completes AS 3.1 is deferred to US2 (see Cross-Story Dependencies), which consumes this slice's validated owner-to-source mapping.

### Tasks

- [x] **Load extraction ownership configuration**

  Add the repository-local ownership config reader in the contracts tooling area and expose the `Extraction Config View` and `Extraction Owner` behavior from the data model. The loader should consume repo-relative configuration for the required M2 contract set and prepare owner records for AS 3.1 without invoking live services or AUTOGEN marker replacement.

  _Acceptance criteria:_
  - The loader accepts repository filesystem inputs only and does not require Docker, network access, live March services, or agent sessions.
  - Owner records include stable owner name, repo-relative contract path, and repo-relative public source selectors.
  - Duplicate contract paths produce bounded ownership diagnostics instead of partially successful ownership output.
  - Unsupported config shape or version produces bounded config diagnostics with the config path.
  - Existing User Story 1 public export extraction behavior remains unchanged.

- [x] **Resolve owner selectors to source surfaces**

  Add deterministic selector resolution that maps each ownership entry to the `Source Surface` model before extraction. It should produce source paths for Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward according to AS 3.1 and AS 3.3, while treating allowed empty or future role-level surfaces as explicit owner state rather than a failure.

  _Acceptance criteria:_
  - Resolved source paths are repo-relative, stay inside the repository root, and are sorted deterministically.
  - Generated output, dependency directories, and non-TypeScript files are excluded from public source surfaces.
  - Each required M2 owner can resolve to exactly one owner surface when configured.
  - Steward can resolve from configured role-consumer surfaces without requiring a standalone `src/steward/` module.
  - Empty surfaces are represented only when the owner configuration explicitly allows that case.

- [x] **Reject overlapping source ownership**

  Add ownership validation that detects when two owners claim the same resolved extraction source or an overlapping selector set. The validation should fail cleanly for AS 3.2 and report enough bounded context for a triager to identify both owners and the conflicting source or selector.

  _Acceptance criteria:_
  - Overlapping resolved source paths fail with ownership diagnostics that name both conflicting owners.
  - Overlapping selector claims fail before public export summaries are associated with contract owners.
  - Non-overlapping selectors for the required M2 owner set pass validation and preserve deterministic owner ordering.
  - Diagnostics include category, severity, contract path when known, source path when known, and bounded message text.
  - The validation does not write contract files or implement check/write command modes.

**PR Outcome**: The repository can load configured extraction owners, resolve deterministic public TypeScript source surfaces for required contract owners, reject overlapping ownership, and support Steward through configured consumer surfaces without requiring a `src/steward/` module. Later slices can use the validated owner-to-source mapping for AUTOGEN region replacement and command check/write behavior.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None — all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Resolve Owned Extraction Surfaces | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Extract Exported TypeScript Surface | depends on | US3 consumes the `PublicExportSummary` shape and filesystem-only extractor boundary from US1. |
| User Story 2: Replace Contract AUTOGEN Regions Safely | depended upon by | US2 needs validated owner-to-source mapping before generated blocks can be associated with target contract artifacts. |
| User Story 4: Provide Deterministic Local Command Output | depended upon by | US4 wraps this ownership mapping with extraction, marker validation, and check/write command modes. |
