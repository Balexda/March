# Tasks: Define Assertable Authoring Rules

**Source**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.spec.md` - User Story 2
**Data Model**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.data-model.md`
**Contracts**: `specs/2026-05-21-005-contract-scaffold-required-section-schema/contract-scaffold-required-section-schema.contracts.md`
**Story Number**: 02

---

## Slice 1: Assertable Scaffold Authoring Rules
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Extend the shared contract scaffold guidance so authors write `## Invariants` and `## Error Modes` as observable, testable contract claims rather than narrative-only documentation.

**Justification**: User Story 2 is documentation-only and its acceptance scenarios all concern the authoring rules for the two required assertion sections. Keeping the rules in one slice gives later L2 and L3 test authors a complete target vocabulary, while avoiding AUTOGEN markers, freshness schema work, subsystem-specific contract bodies, or validation tooling owned by later stories.

**Addresses**: FR-004, FR-005, FR-010; Acceptance Scenarios 2.1, 2.2, 2.3

### Tasks

- [ ] **Add assertable invariant guidance to the scaffold**

  Update the shared contract scaffold documentation so `## Invariants` tells authors to record observable behavioral promises that tests can check. Keep the guidance reusable across subsystems and roles, and keep the change limited to scaffold documentation rather than subsystem-specific contract prose.

  _Acceptance criteria:_
  - `## Invariants` guidance requires entries to be written as observable promises a test can check.
  - The guidance discourages background-only prose that cannot produce a concrete assertion.
  - The guidance works for HTTP routes, CLI commands, exported types, role handoffs, and protocol surfaces without privileging one subsystem shape.
  - The scaffold still preserves the required H2 section vocabulary from User Story 1.
  - No contract body is authored for Hatchery, Brood, Herald, Castra, Spawn, Legate, or Steward.

- [ ] **Add observable error-mode guidance to the scaffold**

  Update the shared contract scaffold documentation so `## Error Modes` tells authors to identify both the failure condition and the externally visible outcome. Keep the error guidance focused on outcomes that callers, operators, or tests can observe without relying on private implementation details.

  _Acceptance criteria:_
  - `## Error Modes` guidance requires each entry to name a failure condition.
  - `## Error Modes` guidance requires each entry to name the expected externally visible outcome.
  - The guidance supports outcomes such as returned errors, emitted events, terminal states, bounded diagnostics, or clean exits without mandating one mechanism for every subsystem.
  - The guidance states failures should be assertable by later L2 or L3 scenarios rather than recorded only as narrative context.
  - No contract presence checker, freshness checker, AUTOGEN extraction tool, CI enforcement, or subsystem-specific freshness glob is introduced.

**PR Outcome**: The shared contract scaffold tells authors how to turn the required invariant and error-mode sections into test targets. Later subsystem contracts and L2/L3 scenarios can derive assertions from observable promises, failure conditions, and externally visible outcomes without changing runtime behavior or adding validation tooling.

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
| S1 | Assertable Scaffold Authoring Rules | User Story 1 | `docs/subsystems/contract-scaffold.md` |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Establish Contract Document Shape | depends on | US2 extends the shared scaffold and required heading vocabulary created by US1. |
| User Story 3: Standardize Autogen Marker Placement | depended upon by | US3 can add AUTOGEN placement after the assertable human-authored section guidance is stable. |
| User Story 4: Record Contract Freshness Schema Shape | depended upon by | US4 records freshness schema shape after the required sections and their authoring rules are stable. |
