# Tasks: Validate Required Contract Presence

**Source**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.spec.md` - User Story 1
**Data Model**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.data-model.md`
**Contracts**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.contracts.md`
**Story Number**: 01

---

## Slice 1: Check Required Contract Sections
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Provide the local `docs:contracts:check` verdict path for required M2 contract presence and required-section validation, with deterministic pass/fail behavior for AS 1.1-1.3.

**Justification**: Presence and required-section validation is the smallest useful verdict increment because it proves the seven M2 contract artifacts are available before later slices add freshness configuration and drift analysis. Splitting the script from section parsing would leave the command unable to satisfy the story, while adding freshness mapping or git diff behavior would cross into later user stories.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-012, FR-013, FR-014; Acceptance Scenarios 1.1, 1.2, 1.3

### Tasks

- [ ] **Add the contract presence verdict command**

  Add the repository-local verdict entrypoint in the docs-contract tooling source area and expose it through `npm run docs:contracts:check`. The command should evaluate the Required Contract set from the data model and satisfy AS 1.1-1.2 without adding freshness config validation, git diff checking, CI wiring, Smithy-agent enforcement, AUTOGEN extraction, or runtime subsystem behavior.

  _Acceptance criteria:_
  - `package.json` exposes the `docs:contracts:check` npm script.
  - The command checks the seven required M2 contract paths from FR-002.
  - A complete required contract set produces a zero exit status for the presence category.
  - A missing required contract produces a non-zero exit status with its repo-relative path.
  - Diagnostics remain bounded and include the presence category.
  - The command runs from filesystem inputs without Docker, network, or live March services.

- [ ] **Validate required Markdown H2 sections**

  Extend the verdict command's contract parser to validate the required section schema for every present contract. The parser should satisfy AS 1.3 and the Required Contract model by recognizing Markdown headings structurally, treating missing or duplicate required H2 headings as failures, and keeping this slice limited to section-schema verdict behavior.

  _Acceptance criteria:_
  - Each present required contract is checked for exactly one required `## Public Interface`, `## Invariants`, and `## Error Modes` section.
  - Required heading detection ignores prose mentions, code blocks, and nested headings.
  - Missing required sections produce non-zero verdict output with the contract path and heading name.
  - Duplicate required H2 sections produce non-zero verdict output with the contract path and heading name.
  - Diagnostics remain bounded and include the section-schema category.
  - Passing output confirms coverage for Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward.

**PR Outcome**: Operators can run `npm run docs:contracts:check` locally to verify that every required M2 contract exists and carries exactly one required H2 section for public interface, invariants, and error modes. The command exits cleanly with bounded diagnostics and does not introduce freshness mapping, drift checking, CI enforcement, or live-service dependencies.

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
| S1 | Check Required Contract Sections | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Populate and Validate Contract Freshness Mapping | depended upon by | US2 depends on the verdict command surface and required contract set established here before adding populated freshness config validation. |
| User Story 3: Report Source and Contract Freshness Drift | depended upon by | US3 depends on the local verdict command and required contract entries before it can compare changed public sources with changed contract artifacts. |
| User Story 4: Provide Deterministic Local Verdict Output | depended upon by | US4 can stabilize cross-category output once presence, config, and freshness checks exist. |
