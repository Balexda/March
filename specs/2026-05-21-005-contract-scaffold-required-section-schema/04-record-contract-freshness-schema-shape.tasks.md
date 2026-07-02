# Tasks: Record Contract Freshness Schema Shape

**Source**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.spec.md` - User Story 4
**Data Model**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.data-model.md`
**Contracts**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.contracts.md`
**Story Number**: 04

---

## Slice 1: Freshness Configuration Schema Shape
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Record the reusable shape for `docs/subsystems/contract-freshness.config.json` so later freshness-checker work can map contract artifacts to public-source selectors without deciding the schema during implementation.

**Justification**: User Story 4 is documentation-only and its acceptance scenarios all concern the schema concepts the future verdict command will consume. Keeping the schema shape in one slice gives F5 a stable artifact contract while avoiding populated subsystem watch lists, freshness-checking logic, presence checks, CI enforcement, generated output, or subsystem contract bodies owned by later work.

**Addresses**: FR-008, FR-009, FR-010; Acceptance Scenarios 4.1, 4.2, 4.3

### Tasks

- [x] **Document the freshness config entry shape**

  Add schema-shape documentation for `docs/subsystems/contract-freshness.config.json` that identifies the top-level version field and the contract entry fields a later checker will consume. Keep the guidance focused on artifact shape and concepts rather than concrete subsystem watch lists.

  _Acceptance criteria:_
  - The schema shape identifies `docs/subsystems/contract-freshness.config.json` as the future freshness configuration artifact.
  - The schema shape includes contract document paths and their associated public-source path selectors as required concepts.
  - The schema shape records a stable version field for future checker behavior.
  - The schema shape does not finalize populated public-source globs for Hatchery, Brood, Herald, Castra, Spawn, Legate, Steward, or any other subsystem.
  - No contract freshness checker, presence checker, AUTOGEN extraction tool, generated signature output, CI enforcement, runtime behavior, or subsystem-specific contract body is introduced.

- [x] **Record ownership and non-overlap rules**

  Clarify how freshness entries express ownership so a public source surface maps to the contract artifact that owns it. Include the Steward role binding as a Castra-consumer surface, and keep the ownership rule assertable enough for later tooling without implementing that tooling here.

  _Acceptance criteria:_
  - The schema guidance states that freshness ownership entries should not overlap unless later work explicitly defines a conflict rule.
  - The schema guidance represents Steward as a role-level contract bound to a Castra-consumer surface rather than a standalone source module.
  - The guidance makes clear that populated selectors are deferred to the later freshness-checker feature.
  - The documented shape lets a later local verdict command determine which contract belongs to which public source paths.
  - No new operator prompt, blocking review gate, or runtime enforcement path is added by this documentation-only slice.

**PR Outcome**: The repository records the contract-freshness configuration shape that later tooling can implement. It defines the versioned mapping between contract paths and public-source selectors, documents non-overlapping ownership, and preserves Steward as a Castra-consumer role binding without finalizing subsystem globs or adding checker behavior.

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
| S1 | Freshness Configuration Schema Shape | - | `docs/subsystems/contract-scaffold.md` |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Establish Contract Document Shape | depends on | US4 maps freshness entries to the canonical contract path convention and required contract artifact shape created by US1. |
| User Story 2: Define Assertable Authoring Rules | depends on | US4 records freshness ownership after contracts have assertable invariant and error-mode guidance. |
| User Story 3: Standardize Autogen Marker Placement | compatible with | US4 does not alter AUTOGEN replacement boundaries and only records source-to-contract freshness shape. |
