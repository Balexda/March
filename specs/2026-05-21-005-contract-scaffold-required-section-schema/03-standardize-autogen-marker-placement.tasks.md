# Tasks: Standardize Autogen Marker Placement

**Source**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.spec.md` - User Story 3
**Data Model**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.data-model.md`
**Contracts**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.contracts.md`
**Story Number**: 03

---

## Slice 1: Public-Interface AUTOGEN Marker Convention
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Extend the shared contract scaffold with the paired AUTOGEN delimiter convention inside `## Public Interface` so future generated exported-signature content has one bounded replacement region that does not disturb human-authored prose.

**Justification**: User Story 3 is documentation-only and all acceptance scenarios concern one marker pair and one placement rule. Keeping the convention in a single slice gives F2 and F3 a stable empty-marker pattern before subsystem contracts reserve regions, while avoiding freshness schema work, extraction tooling, generated content, or subsystem-specific contract bodies owned by later features.

**Addresses**: FR-006, FR-007, FR-010; Acceptance Scenarios 3.1, 3.2, 3.3

### Tasks

- [x] **Add the AUTOGEN marker pair to the scaffold guidance**

  Update the shared contract scaffold documentation so `## Public Interface` defines `<!-- BEGIN AUTOGEN -->` and `<!-- END AUTOGEN -->` as the paired delimiter block for generated exported-signature content. Keep the guidance reusable across subsystem and role contracts, and preserve the human-authored prose around the generated region.

  _Acceptance criteria:_
  - The scaffold defines `<!-- BEGIN AUTOGEN -->` and `<!-- END AUTOGEN -->` as a paired block for generated public-interface content.
  - The marker pair is shown inside `## Public Interface`, not as a substitute for any required H2 section.
  - The guidance supports an empty marker pair when generated content does not exist yet.
  - The scaffold states human-authored public-interface prose may surround the marker pair.
  - The scaffold still preserves `## Public Interface`, `## Invariants`, and `## Error Modes` as required H2 sections.

- [x] **Constrain automated replacement to the marker-bounded region**

  Clarify that later AUTOGEN refresh behavior may replace only the content between the paired markers. Keep this as a documentation convention for future tooling rather than implementing extraction, validation, CI enforcement, or generated contract writes in this slice.

  _Acceptance criteria:_
  - The scaffold identifies the bounded AUTOGEN block as the only region intended for automated replacement.
  - The guidance says generated content belongs between the paired markers and human-authored prose belongs outside the replacement boundary.
  - Empty reserved regions remain valid placeholders for later F7 backfill.
  - No contract presence checker, freshness checker, AUTOGEN extraction tool, generated signature output, CI enforcement, runtime behavior, or subsystem-specific freshness glob is introduced.
  - No contract body is authored for Hatchery, Brood, Herald, Castra, Spawn, Legate, or Steward.

**PR Outcome**: The shared contract scaffold records one AUTOGEN marker-pair convention inside `## Public Interface`. Later subsystem contracts can reserve empty generated regions, and the future F7 extraction tool can refresh only the bounded block without changing human-authored contract prose or adding runtime behavior in this slice.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

None - all ambiguities resolved.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Public-Interface AUTOGEN Marker Convention | - | `docs/subsystems/contract-scaffold.md` |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Establish Contract Document Shape | depends on | US3 places the AUTOGEN marker convention inside the `## Public Interface` section established by US1. |
| User Story 2: Define Assertable Authoring Rules | compatible with | US3 preserves the assertable human-authored section guidance and only reserves generated content inside `## Public Interface`. |
| User Story 4: Record Contract Freshness Schema Shape | depended upon by | US4 can record freshness schema shape independently after the contract scaffold and AUTOGEN marker convention are stable. |
