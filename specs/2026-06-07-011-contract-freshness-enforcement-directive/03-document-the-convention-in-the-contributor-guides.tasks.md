# Tasks: Document The Convention In The Contributor Guides

**Source**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.spec.md` - User Story 3
**Data Model**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.data-model.md`
**Contracts**: `specs/2026-06-07-011-contract-freshness-enforcement-directive/contract-freshness-enforcement-directive.contracts.md`
**Story Number**: 03

---

## Slice 1: Publish Contributor-Guide Convention References
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make the contract-maintenance convention discoverable in `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md`, including the edit-time upkeep expectation, deterministic extractor handoff, advisory check, and absence of a per-PR freshness gate.

**Justification**: User Story 3 is a guide-surface documentation story. A single slice is the smallest coherent increment because AS 3.1 requires all three guides to carry the convention, and AS 3.2/3.3 require the no-gate and tooling boundaries to stay consistent across those references.

**Addresses**: FR-003, FR-004, FR-005, FR-006, FR-007, FR-010; Acceptance Scenarios 3.1, 3.2, 3.3

### Tasks

- [ ] **Document the convention in `CONTRIBUTING.md`**

  Update the contributor-facing guide so its subsystem contract documentation guidance satisfies AS 3.1-3.3. Keep the change scoped to discoverability of the convention and avoid adding implementation details for Feature 5 or Feature 7.

  _Acceptance criteria:_
  - `CONTRIBUTING.md` references edit-time subsystem contract maintenance.
  - The guidance states there is no per-PR CI or AI freshness gate.
  - Feature 5's `docs:contracts:check` is described as opt-in and advisory.
  - Feature 7's extractor is described as deterministic and responsible for mechanical generated regions.
  - No `.github/workflows/contract-freshness.yml` workflow, CI job, runtime behavior, or AI-on-check-in step is introduced.

- [ ] **Document the convention in `CLAUDE.md`**

  Update the Claude agent guide so an autonomous coding agent sees the same convention described in `CONTRIBUTING.md`. The wording should satisfy AS 3.1-3.3 while preserving `AGENTS.md` as the canonical detailed agent guide if the file already delegates there.

  _Acceptance criteria:_
  - `CLAUDE.md` references edit-time subsystem contract maintenance.
  - The guidance states there is no per-PR CI or AI freshness gate.
  - Feature 5's `docs:contracts:check` is described as opt-in and advisory.
  - Feature 7's extractor is described as deterministic and responsible for mechanical generated regions.
  - The file does not introduce a separate enforcement pass, autonomous prompt, or required pre-merge freshness verdict.

- [ ] **Document the convention in `AGENTS.md`**

  Update the canonical agent guide so Smithy and other autonomous agents receive the contract-maintenance convention where repository working rules live. The guidance should satisfy AS 3.1-3.3 and cite `docs/vision.md` plus `docs/operating-philosophy.md` for the autonomous-component posture rather than restating that philosophy.

  _Acceptance criteria:_
  - `AGENTS.md` references edit-time subsystem contract maintenance.
  - The guidance states there is no per-PR CI or AI freshness gate.
  - Feature 5's `docs:contracts:check` is described as opt-in and advisory.
  - Feature 7's extractor is described as deterministic and responsible for mechanical generated regions.
  - The guidance cites `docs/vision.md` and `docs/operating-philosophy.md`.
  - No service route, Herald event, Hatchery job, Brood record, Castra session, Legate loop action, CI workflow, or autonomous prompt is introduced.

**PR Outcome**: Contributors and autonomous agents can find the contract-maintenance convention in the three guide surfaces they already read, with consistent language that contract docs are maintained at edit time, mechanical regions are refreshed deterministically, the local freshness check is advisory, and no per-PR freshness gate exists.

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
| S1 | Publish Contributor-Guide Convention References | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Maintain a subsystem's contract doc as part of the change that alters its surface | depends on | US3 publishes the core same-change maintenance convention established by US1. |
| User Story 2: Refresh the mechanical parts of a contract deterministically | depends on | US3 references the deterministic extractor handoff settled by US2. |
| User Story 4: Record the SD-002 "no enforcement gate" decision | depended upon by | US4 records the broader vehicle decision after the contributor guides expose the convention and no-gate boundary. |
