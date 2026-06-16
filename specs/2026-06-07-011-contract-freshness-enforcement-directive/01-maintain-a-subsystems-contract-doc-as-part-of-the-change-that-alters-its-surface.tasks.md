# Tasks: Maintain A Subsystem's Contract Doc As Part Of The Change That Alters Its Surface

**Source**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.spec.md` - User Story 1
**Data Model**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.data-model.md`
**Contracts**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.contracts.md`
**Story Number**: 01

---

## Slice 1: Codify Edit-Time Contract Maintenance
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make the repository convention explicit that a change altering a subsystem's mapped public surface updates that subsystem's `contract.md` in the same change, without introducing a separate freshness gate.

**Justification**: User Story 1 is the foundation for the reframed maintenance-convention feature. A single documentation-focused slice is the smallest coherent increment because it establishes the same-change expectation and the non-gating behavior together; splitting those points would leave the convention either undiscoverable or accidentally enforceable. Deterministic extraction, contributor-guide coverage, and the SD-002 decision record stay with later user stories.

**Addresses**: FR-001, FR-002, FR-004, FR-010; Acceptance Scenarios 1.1, 1.2, 1.3

### Tasks

- [ ] **State the same-change contract update convention**

  Add the edit-time maintenance convention to the repository instructions that govern subsystem contract upkeep. The prose should require same-change updates when mapped public surfaces change, make clear that changes outside mapped public surfaces do not require contract edits, and cite the March vision and operating-philosophy docs for the autonomous-component posture.

  _Acceptance criteria:_
  - The convention requires updating the owning subsystem `contract.md` in the same change when a mapped public surface changes.
  - The convention states that changes touching no mapped public surface do not require a contract update.
  - The convention is framed as normal edit-time upkeep for authors and Smithy agents, not a separate enforcement pass.
  - The convention cites `docs/vision.md` and `docs/operating-philosophy.md` rather than restating their philosophy.
  - No runtime subsystem behavior, service route, Herald event, Hatchery job, Brood record, Castra session, Legate loop action, CI workflow, or AI-on-check-in step is introduced.

- [ ] **Preserve the non-gating boundary**

  Keep the authored convention advisory in effect and non-blocking in mechanism. Any local freshness verdict remains optional guidance, and the slice must not make contract freshness a merge, PR, slice, or autonomous-agent gate.

  _Acceptance criteria:_
  - No `.github/workflows/contract-freshness.yml` workflow or equivalent freshness CI job is added.
  - No command path is changed so contract freshness fails, blocks, or gates PR, slice, or merge completion.
  - No autonomous component is required to prompt, wait for human input, or run a contract-freshness verdict before completing its work.
  - Feature 5's `npm run docs:contracts:check` remains opt-in and advisory if referenced.
  - The implementation degrades cleanly when Feature 5's check or Feature 7's extractor is absent.

**PR Outcome**: Contributors and Smithy agents have an explicit edit-time convention for maintaining subsystem contract docs when mapped public surfaces change, while work that does not touch a mapped surface remains free of contract-update requirements. The change introduces no freshness gate, CI workflow, runtime behavior, or per-check-in AI validation.

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
| S1 | Codify Edit-Time Contract Maintenance | - | Repository contract-maintenance instructions |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Refresh the mechanical parts of a contract deterministically | depended upon by | US2 can add the deterministic extractor handoff after the same-change maintenance convention exists. |
| User Story 3: Document the convention in the contributor guides | depended upon by | US3 broadens discoverability in `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` after the core convention is codified. |
| User Story 4: Record the SD-002 "no enforcement gate" decision | depended upon by | US4 records the broader vehicle decision after the non-gating convention boundary is established. |
