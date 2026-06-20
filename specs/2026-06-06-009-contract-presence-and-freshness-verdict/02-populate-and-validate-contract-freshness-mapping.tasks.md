# Tasks: Populate and Validate Contract Freshness Mapping

**Source**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.spec.md` - User Story 2
**Data Model**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.data-model.md`
**Contracts**: `specs/2026-06-06-009-contract-presence-and-freshness-verdict/contract-presence-and-freshness-verdict.contracts.md`
**Story Number**: 02

---

## Slice 1: Validate Populated Freshness Config
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Add the populated contract freshness configuration and make `npm run docs:contracts:check` validate its required entries, ownership uniqueness, and Steward role-consumer mapping for AS 2.1-2.3.

**Justification**: The config artifact is not useful without validation, and validation cannot satisfy the story without the populated M2 mapping. Delivering both in one slice gives maintainers a working config verdict while leaving changed-file drift evaluation to User Story 3.

**Addresses**: FR-005, FR-006, FR-007, FR-008, FR-012, FR-013, FR-014; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [x] **Author the populated freshness configuration**

  Add `docs/subsystems/contract-freshness.config.json` with one entry for each required M2 contract from the Required Contract set. Keep the mapping limited to public source selectors and include Steward's role-consumer ownership context so AS 2.1 and AS 2.3 can be validated by the existing `npm run docs:contracts:check` verdict command.

  _Acceptance criteria:_
  - The config file uses the Contract Freshness Configuration shape from the contracts artifact.
  - Every subsystem in `docs/subsystems/subsystems.json` — currently Hatchery, Brood, Herald, Castra, Spawn, Legate, Steward, and Statio — has exactly one entry, since `readSubsystems()` derives the required set from that manifest.
  - Every entry has a stable name, a unique contract path, and at least one public source selector.
  - Selectors are repo-relative and avoid generated or dependency directories.
  - Steward maps to role-consumer surfaces instead of a standalone `src/steward/` module.
  - No runtime subsystem behavior, CI workflow, Smithy-agent enforcement, or AUTOGEN extraction is added.

- [x] **Validate freshness config ownership**

  Extend `scripts/docs-contracts/check.mjs` and its tests so the verdict command reads and validates the freshness config as a config category. The validator should satisfy AS 2.1-2.3 by rejecting missing required entries, duplicate contract paths, overlapping public source ownership, malformed selectors, and Steward mappings that rely on a standalone source directory.

  _Acceptance criteria:_
  - Passing verdict output includes a config check for the populated required M2 mapping.
  - Missing or duplicate required contract entries fail with bounded config diagnostics.
  - Duplicate contract paths fail with the affected path and owning entry names.
  - Overlapping public source selectors fail with the affected selector and owning entry names.
  - Empty, escaping, generated, or dependency-rooted selectors fail as config diagnostics.
  - Steward mappings that require `src/steward/` fail, while Castra/Hatchery role-consumer surfaces pass.

**PR Outcome**: Maintainers can inspect the populated `docs/subsystems/contract-freshness.config.json` and run `npm run docs:contracts:check` to prove every required M2 contract has one non-overlapping public source ownership entry. The checker now reports config failures with bounded diagnostics and still avoids freshness drift checking, CI enforcement, AUTOGEN extraction, or live-service dependencies.

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
| S1 | Validate Populated Freshness Config | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Validate Required Contract Presence | depends on | US2 uses the verdict command surface and required contract set established by US1 before adding config validation. |
| User Story 3: Report Source and Contract Freshness Drift | depended upon by | US3 consumes the populated config and ownership validation from US2 to compare changed public sources with owning contract paths. |
| User Story 4: Provide Deterministic Local Verdict Output | depended upon by | US4 can stabilize the final local output once presence, config, and freshness checks are all implemented. |
