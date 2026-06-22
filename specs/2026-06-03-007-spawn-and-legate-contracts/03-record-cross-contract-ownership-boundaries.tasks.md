# Tasks: Record Cross-Contract Ownership Boundaries

**Source**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.spec.md` - User Story 3
**Data Model**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.data-model.md`
**Contracts**: `specs/2026-06-03-007-spawn-and-legate-contracts/spawn-and-legate-contracts.contracts.md`
**Story Number**: 03

---

## Slice 1: Consolidate Cross-Contract Boundary References
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Update the Spawn and Legate contracts so their dependency references name Hatchery, Brood, Herald, Castra, and Steward as ownership boundaries without duplicating the service route contracts from Feature 2 or the Steward role contract from Feature 4.

**Justification**: User Story 3 is a documentation-maintenance slice that depends on both subsystem contracts existing. A single coordinated pass keeps the boundary language consistent across Spawn and Legate, gives future freshness mappings stable owner references, and avoids changing runtime behavior or re-authoring provider contracts.

**Addresses**: FR-012, FR-013; Acceptance Scenarios 3.1, 3.2, 3.3

### Tasks

- [ ] **Add Spawn boundary ownership references**

  Review `docs/subsystems/spawn/contract.md` and make the Spawn-owned relationships to Hatchery, Brood, Castra, and Steward explicit. Keep the prose focused on Spawn's lifecycle, output, validation, cleanup, and handoff promises while pointing provider interface details back to their owning contracts or future contract.

  _Acceptance criteria:_
  - Hatchery is named only as the submitter or manager boundary for spawn work; Hatchery HTTP route details are not restated.
  - Brood is named only as the lifecycle and cleanup-state authority observed by Spawn; Brood service routes are not restated.
  - Castra is named only as an integration boundary for hosted sessions or downstream session context; Castra routes and adapter details are not restated.
  - Steward is named only as the validated-output handoff consumer, pointing to the existing Steward contract (`docs/subsystems/steward/contract.md`); Steward's role commands, prompts, and public interface are not restated — they remain owned by the Steward contract.
  - Spawn-owned lifecycle, terminal output, validation-gated handoff, and cleanup promises remain the only detailed behavior documented in the Spawn contract.

- [ ] **Add Legate boundary ownership references**

  Review `docs/subsystems/legate/contract.md` and make the Legate-owned relationships to Herald, Hatchery, Brood, Castra, and Steward explicit. Keep the prose focused on Legate's loop decisions, event consumption, dispatch, babysit, relaunch, terminal outcomes, and trace ownership while pointing provider interface details back to their owning contracts or future contract.

  _Acceptance criteria:_
  - Herald is named only as the event-log and projection boundary consumed by Legate; Herald route details are not restated.
  - Hatchery is named only as the dispatch boundary for runnable slices; Hatchery HTTP route details are not restated.
  - Brood is named only as lifecycle state observed for worker and cleanup decisions; Brood service routes are not restated.
  - Castra is named only as the session-hosting and steward-attachment boundary observed by Legate; Castra routes and adapter details are not restated.
  - Steward is named only as a role boundary whose attachment, loss, or terminal outcome can affect Legate decisions, pointing to the existing Steward contract (`docs/subsystems/steward/contract.md`); Steward's role commands, prompts, and public interface are not restated — they remain owned by the Steward contract.
  - Legate-owned loop decisions, cursor handling, trace origin, babysit behavior, and terminal outcomes remain the only detailed behavior documented in the Legate contract.

- [ ] **Verify non-duplication and future freshness usefulness**

  Check both updated contracts against the User Story 3 acceptance scenarios and the cross-contract boundary model. The final wording should be specific enough for later freshness mappings to identify source owners, but not so detailed that Spawn or Legate becomes the owner of another subsystem's public surface.

  _Acceptance criteria:_
  - Both contracts reference Hatchery, Brood, Herald, Castra, and Steward only where relevant to their own boundary.
  - No provider HTTP route table, endpoint list, request schema, or response schema is duplicated into the Spawn or Legate contracts.
  - No Steward-specific role interface, command surface, prompt contract, or review behavior is duplicated from the existing Steward contract.
  - The boundary references can be mapped to the `Cross-Contract Boundary` entity fields: consumer contract, provider contract or future path, relationship, and ownership rule.
  - The change does not introduce contract checkers, freshness globs, AUTOGEN generation, CI enforcement, runtime route changes, loop behavior changes, or Steward-specific contract content.

**PR Outcome**: Spawn and Legate both name their cross-contract ownership boundaries in a way future freshness checks and L2 tests can follow, while Hatchery, Brood, Herald, Castra, and Steward retain ownership of their own public interfaces.

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
| S1 | Consolidate Cross-Contract Boundary References | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Document Spawn Dispatch Contract | depends on | Spawn boundary references can be consolidated after the Spawn contract exists. |
| User Story 2: Document Legate Loop Contract | depends on | Legate boundary references can be consolidated after the Legate contract exists. |
