# Tasks: Record The SD-002 No Enforcement Gate Decision

**Source**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.spec.md` - User Story 4
**Data Model**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.data-model.md`
**Contracts**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.contracts.md`
**Story Number**: 04

---

## Slice 1: Record The Reversible No-Gate Decision
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make the spec package record SD-002's no-enforcement-gate decision, including the rejected-but-cheaply-reversible alternatives, deferred structural escalation, and SD-011 closure.

**Justification**: User Story 4 is decision-record documentation, not runtime behavior. A single slice is the smallest coherent increment because the chosen vehicle, rejected alternatives, deferred AST-diff escalation, and moot enforcement-strength question must stay together for the decision to remain legible and reversible.

**Addresses**: FR-004, FR-007, FR-008, FR-009, FR-010; Acceptance Scenarios 4.1, 4.2, 4.3

### Tasks

- [ ] **Record the no-gate decision in the spec**

  Update the feature spec so the SD-002 decision is visible in the story, requirements, debt, out-of-scope, and success-criteria surfaces that future maintainers read. The prose should satisfy AS 4.1-4.3 while preserving this feature as a maintenance convention rather than an enforcement vehicle.

  _Acceptance criteria:_
  - The spec records that this milestone enforces nothing automatically.
  - The spec ties the chosen path to edit-time maintenance plus deterministic auto-gen.
  - The spec names the Smithy-agent directive and `.github/workflows/contract-freshness.yml` workflow as rejected-but-cheaply-reversible alternatives.
  - The spec keeps structural AST-diff escalation deferred until drift is observed.
  - SD-011 is closed as moot because there is no enforcement-strength choice without a gate.

- [ ] **Align the model and contract decision surfaces**

  Update the data model and contracts artifacts so their SD-002 decision surfaces agree with the spec. Keep the entities and integration boundaries documentation-only, satisfying AS 4.1-4.3 without introducing a new provider, command, route, or event.

  _Acceptance criteria:_
  - The data model includes a decision-record entity or equivalent field coverage for the chosen no-gate vehicle.
  - The data model names both rejected alternatives and their reversibility.
  - The contracts artifact states that no PR, slice, or merge is gated on a freshness verdict.
  - The contracts artifact records the deferred AST-diff escalation and SD-011 moot closure.
  - The contracts artifact does not define a live service API, runtime hook, or autonomous prompt.

- [ ] **Preserve the no-enforcement implementation boundary**

  Keep the implementation limited to the spec package and any directly necessary decision-record documentation. This task guards AS 4.1-4.3 by ensuring the record does not accidentally create the enforcement machinery it rejects.

  _Acceptance criteria:_
  - No `.github/workflows/contract-freshness.yml` workflow or equivalent CI job is added.
  - No Smithy-agent enforcement directive is added or made mandatory.
  - No Feature 5 verdict path is changed from opt-in advisory behavior to a gate.
  - No Feature 7 extractor behavior or structural AST-diff escalation is implemented.
  - No runtime subsystem behavior, service route, Herald event, Hatchery job, Brood record, Castra session, or Legate loop action is introduced.

**PR Outcome**: The spec package carries a durable SD-002 decision record: this milestone chooses edit-time maintenance plus deterministic auto-gen, rejects both enforcement vehicles while keeping them cheap to re-add deliberately, defers structural AST-diff escalation, and closes SD-011 as moot without adding enforcement machinery.

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
| S1 | Record The Reversible No-Gate Decision | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Maintain a subsystem's contract doc as part of the change that alters its surface | depends on | US4 records the broader SD-002 vehicle decision after US1 establishes the same-change, non-gating maintenance convention. |
| User Story 2: Refresh the mechanical parts of a contract deterministically | depends on | US4 relies on US2's deterministic autogen handoff as part of the chosen no-gate maintenance path. |
| User Story 3: Document the convention in the contributor guides | depends on | US4 records the no-gate decision after US3 makes the convention discoverable in contributor and agent guide surfaces. |
