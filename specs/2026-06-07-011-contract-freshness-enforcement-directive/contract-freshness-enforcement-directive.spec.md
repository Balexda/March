# Feature Specification: Contract-Freshness Maintenance Convention

**Spec Folder**: `2026-06-07-011-contract-freshness-enforcement-directive`
(folder slug retained from this feature's prior "enforcement directive" framing;
renaming is deferred to avoid branch/PR churn — see the 2026-06-15 clarification)
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f6`
**Created**: 2026-06-07
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 6, reconciled against the source feature map present in this checkout.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 6: Contract-Freshness Maintenance Convention

## Clarifications

### Session 2026-06-07

- This spec is reconciled against the source feature map (`docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md`), whose Feature 6 entry pairs the freshness verdict (Feature 5) with the SD-002 question of how — if at all — that verdict is enforced.
- Feature 5 owns the single local verdict authority (`npm run docs:contracts:check`) and the populated `contract-freshness.config.json` source-glob → contract mapping. Feature 6 does not reimplement presence, section-schema, freshness-config, or drift logic.

### Session 2026-06-15

- **Operator decision (PR #294): pull back from per-PR enforcement.** SD-002 is resolved toward **no enforcement gate** — neither a Smithy-agent directive that fails PRs nor a `.github/workflows/contract-freshness.yml` CI workflow. The operator's rationale: we do not want to spend tokens running an AI bot on every check-in to validate that documentation is up to date.
- **Feature 6 is reframed as a maintenance convention, not an enforcement vehicle.** Contract docs are kept current by the work that already happens during editing: the Smithy agents used for most edits already update affected docs as part of their change, and the mechanically-derivable parts of a contract can be refreshed by a **deterministic** auto-generation tool (Feature 7's `docs:contracts:extract`) — e.g. from Fastify controller endpoints and exported TypeScript signatures. No LLM/AI step runs on every check-in.
- **Feature 5's verdict stays available, but advisory.** `npm run docs:contracts:check` is an opt-in local sanity check a contributor *may* run; it is never wired as a blocking PR/slice/merge gate and no autonomous agent is required to run it.
- **The convention is documented where contributors and agents look.** `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` reference that subsystem contract docs are maintained at edit time (Smithy edits + deterministic auto-gen), not enforced by a freshness gate.
- **SD-011 is closed as moot.** It asked whether the directive enforced as review-advisory or merge-blocking; with no enforcement gate, enforcement strength is no longer a question. The folder slug retains the older "enforcement directive" name for branch/PR continuity.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Maintain a subsystem's contract doc as part of the change that alters its surface (Priority: P1)

As the Operator-as-Test-Author, I want a subsystem's `contract.md` to be updated in
the same change that alters that subsystem's public surface, so that contract docs
stay current at edit time rather than relying on a separate gate or after-the-fact
sweep.

**Why this priority**: This is the load-bearing behavior of the reframed feature.
The Smithy agents used for most edits already maintain affected docs as they work;
the convention makes contract docs part of that same edit-time upkeep instead of a
policed checkpoint.

**Independent Test**: Take a change that edits a subsystem's mapped public source
and confirm the convention directs the author/agent to update that subsystem's
`contract.md` in the same change, with no separate enforcement step required to make
that happen.

**Acceptance Scenarios**:

1. **Given** a change that alters a subsystem's mapped public surface, **When** the change is authored, **Then** the convention requires updating that subsystem's `contract.md` within the same change.
2. **Given** a change that touches no mapped public surface, **When** the change is authored, **Then** no contract update is required.
3. **Given** a Smithy agent is making the edit, **When** it updates the surface, **Then** maintaining the contract doc is part of its normal edit-time documentation upkeep, not a separate gating step.

---

### User Story 2: Refresh the mechanical parts of a contract deterministically (Priority: P1)

As a contract maintainer, I want the mechanically-derivable regions of a contract
(e.g. Fastify controller endpoints and exported TypeScript signatures) refreshed by a
**deterministic** generator rather than by hand or by an AI step, so that the
drift-prone parts stay accurate without spending tokens on per-check-in validation.

**Why this priority**: Auto-generation removes the most error-prone manual upkeep and
is explicitly the mechanism the operator endorsed — provided it is deterministic and
not an AI bot on every commit.

**Independent Test**: Confirm the convention delegates mechanical region population to
Feature 7's deterministic `docs:contracts:extract` tool and names no per-check-in
LLM/AI validation step.

**Acceptance Scenarios**:

1. **Given** a subsystem with a mechanically-derivable surface, **When** its contract's generated regions need refreshing, **Then** the convention points to Feature 7's deterministic extractor rather than hand-maintenance or an AI step.
2. **Given** the extractor runs, **When** it populates generated regions, **Then** the output is deterministic and ordered so it does not churn on cosmetic source moves.
3. **Given** Feature 7's tool is not yet present, **When** a contract is maintained, **Then** the convention degrades cleanly to manual edit-time upkeep with no gate.

---

### User Story 3: Document the convention in the contributor guides (Priority: P2)

As a contributor or autonomous agent, I want `CONTRIBUTING.md`, `CLAUDE.md`, and
`AGENTS.md` to state that subsystem contract docs are maintained at edit time (Smithy
edits plus deterministic auto-gen) and are not enforced by a per-PR freshness gate, so
that the expectation is discoverable where I already look.

**Why this priority**: A convention nobody can find is not a convention. Putting it in
the three guides agents and humans read makes the edit-time expectation legible and
prevents anyone from reintroducing a freshness gate by accident.

**Independent Test**: Confirm each of the three guides references the edit-time
maintenance + deterministic auto-gen behavior and the absence of a freshness gate.

**Acceptance Scenarios**:

1. **Given** the contributor guides, **When** they are read, **Then** each of `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` references the edit-time contract-maintenance convention.
2. **Given** the guides, **When** they describe the convention, **Then** they state there is no per-PR CI/AI freshness gate.
3. **Given** the guides, **When** they point to tooling, **Then** they describe the Feature 5 check as opt-in/advisory and the Feature 7 extractor as deterministic.

---

### User Story 4: Record the SD-002 "no enforcement gate" decision (Priority: P2)

As a future maintainer, I want the recorded decision that SD-002 resolved toward no
enforcement gate — with both the prior Smithy-agent enforcement directive and the CI
workflow named as rejected-but-cheaply-reversible alternatives — so that a later pivot
to enforcement is a deliberate, legible choice rather than a rediscovery.

**Why this priority**: The earlier framing of this feature *was* an enforcement
directive. Recording why it was pulled back, and that re-adding a gate is cheap if
drift later proves to need one, keeps the decision honest and reversible.

**Independent Test**: Review the spec package and confirm it records the SD-002
resolution toward no gate, names the directive and workflow alternatives as out of
scope but reversible, notes the deferred AST-diff escalation, and closes SD-011 as
moot.

**Acceptance Scenarios**:

1. **Given** the SD-002 decision, **When** the spec is authored, **Then** it records that this milestone enforces nothing automatically and relies on edit-time maintenance plus deterministic auto-gen.
2. **Given** drift could later slip through, **When** the decision record is read, **Then** it states that re-adding a Smithy-agent directive or a `.github/workflows/contract-freshness.yml` workflow is a cheap, deliberate reversal.
3. **Given** RFC SD-002 defers the structural AST-diff escalation, **When** the spec is authored, **Then** it does not implement that escalation, and SD-011 (enforcement strength) is closed as moot.

### Edge Cases

- A change alters a subsystem's public surface but not its `contract.md` — the convention asks the author/agent to update it in the same change; nothing automatically fails the PR.
- A change edits a `contract.md` without touching any mapped source — allowed; no verdict is required.
- Feature 5's check or Feature 7's extractor is not yet present — the convention degrades to manual edit-time maintenance.
- A contributor wants reassurance — they MAY run the opt-in `npm run docs:contracts:check` locally; it advises, it does not block.
- Mechanically-derivable surface (Fastify endpoints, exported types) changes — the deterministic extractor refreshes the generated regions.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Maintain a subsystem's contract doc as part of the change that alters its surface | — | specs/2026-06-07-011-contract-freshness-enforcement-directive/01-maintain-a-subsystems-contract-doc-as-part-of-the-change-that-alters-its-surface.tasks.md |
| US2 | Refresh the mechanical parts of a contract deterministically | US1 | — |
| US3 | Document the convention in the contributor guides | US1 | — |
| US4 | Record the SD-002 "no enforcement gate" decision | US1 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The convention MUST require that a change altering a subsystem's mapped public surface updates that subsystem's `contract.md` within the same change.
- **FR-002**: The convention MUST rely on the edit-time documentation maintenance the Smithy agents already perform, rather than a separate per-PR enforcement step.
- **FR-003**: The convention MAY refresh mechanically-derivable contract regions via Feature 7's **deterministic** `docs:contracts:extract` tool (e.g. Fastify endpoints, exported TypeScript signatures); it MUST NOT introduce an AI/LLM step that runs on every check-in.
- **FR-004**: The convention MUST NOT fail, block, or gate any PR, slice, or merge on a contract-freshness verdict.
- **FR-005**: Feature 5's `npm run docs:contracts:check` MUST remain an opt-in, advisory local check a contributor MAY run; no autonomous agent or CI job is required to run it as a gate.
- **FR-006**: The convention MUST be referenced in `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md`, stating that contract docs are maintained at edit time and not enforced by a freshness gate.
- **FR-007**: The feature MUST NOT add a `.github/workflows/contract-freshness.yml` workflow or any CI job that validates contract freshness.
- **FR-008**: The feature MUST record that SD-002 is resolved toward no per-check-in enforcement gate, and that both the Smithy-agent directive and the CI workflow remain cheaply available if drift later proves to need them.
- **FR-009**: The feature MUST NOT implement the structural AST-diff escalation path, which RFC SD-002 defers until drift is observed.
- **FR-010**: The convention MUST follow March's autonomous-component posture (non-interactive, minimum access, clean exits) per `docs/vision.md` and `docs/operating-philosophy.md`.
- **FR-011**: The deterministic auto-gen mechanism MUST be owned by Feature 7; this feature defines the convention and its contributor-doc references, not the extractor itself.

### Key Entities

- **Contract Maintenance Convention**: The repository convention that subsystem contract docs are kept current at edit time rather than by an enforcement gate.
- **Edit-Time Contract Update**: The same-change update of a subsystem's `contract.md` performed by the author or Smithy agent that altered its surface.
- **Deterministic Contract Autogen (Feature 7)**: The deterministic extractor that refreshes mechanically-derivable contract regions; owned by Feature 7.
- **Opt-In Freshness Check (Feature 5)**: `npm run docs:contracts:check`, an advisory local check that never gates work.
- **SD-002 Decision Record**: The recorded resolution toward no enforcement gate, with the directive and workflow as reversible alternatives.

## Assumptions

- The Smithy agents used for most edits already maintain affected documentation as part of their change, so contract docs can ride that same edit-time upkeep.
- Feature 5 supplies the opt-in `npm run docs:contracts:check` command and the freshness mapping; Feature 7 supplies the deterministic `docs:contracts:extract` extractor. Neither is required to exist for the convention to be authored.
- Contributors and agents read `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md`, so a reference there is sufficient to make the convention discoverable.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-011 | Whether the (former) Smithy-agent directive enforced at PR-review time (advisory) or as a blocking pre-merge gate. | feedback:Risks (SD-002 sub-question) | Medium | High | resolved | Closed as moot. Operator resolved SD-002 toward **no enforcement gate** (PR #294); with no gate, enforcement strength is no longer a question. |

## Out of Scope

- Implementing or changing the Feature 5 verdict command or its freshness mapping.
- Implementing the Feature 7 deterministic extractor (this feature only references it).
- Authoring subsystem contract prose or the contract content itself (Features 2/3/4).
- Any per-PR enforcement gate, blocking merge step, or AI freshness bot that validates documentation on check-in.
- Adding a `.github/workflows/contract-freshness.yml` GitHub Actions workflow (a reversible alternative, not chosen for this milestone).
- Implementing the structural AST-diff escalation path (RFC SD-002 defers it until drift is observed).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A change that alters a subsystem's mapped public surface updates that subsystem's `contract.md` in the same change, by convention rather than by a gate.
- **SC-002**: No PR, slice, or merge is blocked by a contract-freshness verdict; `npm run docs:contracts:check` is opt-in and advisory.
- **SC-003**: `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md` each reference the edit-time maintenance plus deterministic auto-gen convention and the absence of a freshness gate.
- **SC-004**: Mechanically-derivable contract regions can be populated by Feature 7's deterministic extractor with no AI/LLM-on-check-in step.
- **SC-005**: The SD-002 "no enforcement gate" resolution and the SD-011 closure are recorded so the decision stays legible and cheaply reversible.
