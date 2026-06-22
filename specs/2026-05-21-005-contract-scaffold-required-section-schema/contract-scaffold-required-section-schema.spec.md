# Feature Specification: Contract Scaffold & Required-Section Schema

**Spec Folder**: `2026-05-21-005-contract-scaffold-required-section-schema`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f1`
**Created**: 2026-05-21
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 1, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 1: Contract Scaffold & Required-Section Schema

## Clarifications

### Session 2026-05-21

- The slice is documentation-only: it establishes the reusable contract scaffold and schema shape, but it does not author any subsystem-specific contract body or implement freshness tooling.
- The required contract section vocabulary is fixed for this milestone as `## Public Interface`, `## Invariants`, and `## Error Modes`.
- Steward is treated as a Castra-consumer surface for contract ownership even though no standalone Steward module exists. [Critical Assumption]

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Establish Contract Document Shape (Priority: P1)

As the Operator-as-Test-Author, I want every subsystem contract to share the same required section headings so that downstream tests can assert against stable artifact structure instead of bespoke prose layouts.

**Why this priority**: The RFC's M2 contract track depends on explicit contract artifacts before L2 and L3 tests can assert subsystem boundaries. The shared section shape must land before any subsystem-specific contract body so later contracts do not churn when the scaffold is standardized.

**Independent Test**: Inspect the scaffolded contract template and verify it includes the three mandatory H2 sections: `## Public Interface`, `## Invariants`, and `## Error Modes`. Additional sections (e.g., an overview or glossary) are permitted — the schema requires these three to be present, not that they be the only sections.

**Acceptance Scenarios**:

1. **Given** a subsystem author starts a new contract artifact, **When** they use the shared scaffold, **Then** the artifact contains `## Public Interface`, `## Invariants`, and `## Error Modes` as top-level required sections.
2. **Given** a downstream contract-presence check is defined later, **When** it validates a scaffold-compliant contract, **Then** it can key on the same three required headings for every subsystem.
3. **Given** the testing RFC requires explicit contracts for Spawn, Hatchery, Brood, Herald, Castra, Legate, and Steward, **When** this scaffold lands, **Then** each later authoring feature has one canonical document shape to fill.

---

### User Story 2: Define Assertable Authoring Rules (Priority: P1)

As the Operator-as-Test-Author, I want the invariant and error-mode sections to be written as assertable statements so that contracts become test targets rather than general documentation.

**Why this priority**: The testing strategy states that tests are the contract and contracts are explicit artifacts. A heading scaffold without authoring rules would still allow untestable prose, weakening M2's value before F2 through F4 author subsystem bodies.

**Independent Test**: Review the scaffold guidance and confirm it tells authors to write invariants and error modes as observable, testable claims.

**Acceptance Scenarios**:

1. **Given** an author fills `## Invariants`, **When** they follow the scaffold guidance, **Then** each invariant is phrased as an observable promise a test can check.
2. **Given** an author fills `## Error Modes`, **When** they follow the scaffold guidance, **Then** each error mode identifies the condition and expected externally visible outcome.
3. **Given** a later L2 or L3 scenario references a subsystem contract, **When** it chooses assertions, **Then** the contract sections provide concrete statements instead of narrative-only context.

---

### User Story 3: Standardize Autogen Marker Placement (Priority: P2)

As a contract maintainer, I want a shared AUTOGEN delimiter convention inside public-interface sections so that generated exported-signature blocks can be inserted later without disrupting human-authored contract prose.

**Why this priority**: The autogen extraction tool is later work, but the marker convention must be available before F2 and F3 place empty markers in subsystem contracts. It depends on the base document shape from User Story 1.

**Independent Test**: Inspect the scaffold and confirm it defines `<!-- BEGIN AUTOGEN -->` and `<!-- END AUTOGEN -->` as a paired block placed inside `## Public Interface` where generated surface details belong.

**Acceptance Scenarios**:

1. **Given** a subsystem contract has generated public-surface content, **When** the marker convention is applied, **Then** generated content is bounded by `<!-- BEGIN AUTOGEN -->` and `<!-- END AUTOGEN -->`.
2. **Given** a subsystem contract does not yet have generated content, **When** authors reserve the region, **Then** the empty marker pair still identifies where F7 will backfill exported signatures.
3. **Given** human prose surrounds generated signatures, **When** the autogen region is refreshed later, **Then** the bounded block is the only region intended for automated replacement.

---

### User Story 4: Record Contract Freshness Schema Shape (Priority: P2)

As the CI Failure Triager, I want the freshness configuration schema shape recorded before the checker exists so that the later local verdict command has a stable artifact contract to implement.

**Why this priority**: F5 owns the populated globs and checking logic, but it should consume a pre-agreed schema instead of inventing one while implementing the verdict authority.

**Independent Test**: Inspect the schema documentation and confirm it identifies contract path mappings, public-source path selectors, and non-overlapping ownership as required concepts without committing populated subsystem globs.

**Acceptance Scenarios**:

1. **Given** the freshness check is implemented later, **When** it reads the configuration, **Then** the schema shape can express which contract belongs to which public source paths.
2. **Given** this feature excludes populated globs, **When** the schema shape lands, **Then** no subsystem-specific freshness watch list is finalized by this slice.
3. **Given** Steward has no standalone source module, **When** ownership is documented, **Then** Steward's contract source binding is represented as a Castra-consumer surface rather than omitted.

### Edge Cases

- A subsystem has no HTTP surface and still needs the same required contract headings.
- A subsystem has generated public-interface content later, but the surrounding human prose remains stable.
- Steward has no standalone source directory, so contract ownership must be documented by role and consumer surface rather than by module name.
- A future presence checker must not treat AUTOGEN markers as substitutes for the three required sections.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Establish Contract Document Shape | — | specs/2026-05-21-005-contract-scaffold-required-section-schema/01-establish-contract-document-shape.tasks.md |
| US2 | Define Assertable Authoring Rules | US1 | specs/2026-05-21-005-contract-scaffold-required-section-schema/02-define-assertable-authoring-rules.tasks.md |
| US3 | Standardize Autogen Marker Placement | US1 | — |
| US4 | Record Contract Freshness Schema Shape | US1, US2 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define `docs/subsystems/<name>/contract.md` as the canonical location pattern for subsystem contract documents.
- **FR-002**: The contract scaffold MUST require the H2 sections `## Public Interface`, `## Invariants`, and `## Error Modes`.
- **FR-003**: The contract scaffold MUST define `## Public Interface` as the section for externally consumed route, command, type, role, or protocol surfaces, depending on subsystem shape.
- **FR-004**: The contract scaffold MUST require `## Invariants` content to be written as assertable behavioral promises.
- **FR-005**: The contract scaffold MUST require `## Error Modes` content to identify observable failure conditions and outcomes.
- **FR-006**: The contract scaffold MUST define the `<!-- BEGIN AUTOGEN -->` and `<!-- END AUTOGEN -->` marker pair for generated public-interface content.
- **FR-007**: The AUTOGEN marker pair MUST be placed inside `## Public Interface` when a contract reserves generated exported-signature content.
- **FR-008**: The schema shape for `docs/subsystems/contract-freshness.config.json` MUST represent contract document paths and their associated public-source path selectors.
- **FR-009**: The schema shape MUST allow the Steward contract to bind to a Castra-consumer surface instead of a standalone source module.
- **FR-010**: This feature MUST NOT author subsystem-specific contract bodies, populate freshness globs, implement presence or freshness checks, or implement the AUTOGEN extraction tool.

### Key Entities

- **Subsystem Contract**: A documentation artifact for one runtime boundary, located under the subsystem contract directory convention and carrying the three required sections.
- **Required Section Schema**: The fixed set of mandatory headings that every subsystem contract must include.
- **Autogen Region**: A bounded region inside `## Public Interface` reserved for generated exported-signature content.
- **Contract Freshness Config Shape**: The documented JSON structure that later maps public source changes to the contract artifacts they must update.
- **Steward Source Binding Decision**: The documented ownership rule that treats Steward as a Castra-consumer surface for contract purposes.

## Assumptions

- The feature's output is a planning/documentation scaffold, not executable validation logic.
- The existing March philosophy applies: this scaffold supports low-touch execution by making contract expectations explicit before automated checks consume them.
- Later features own concrete subsystem prose and any validation tooling.

## Specification Debt

None — all ambiguities resolved.

## Out of Scope

- Authoring contract bodies for Hatchery, Brood, Herald, Castra, Spawn, Legate, or Steward.
- Implementing the contract presence or freshness checker.
- Populating subsystem public-source globs in the freshness configuration.
- Implementing or running a TypeScript public-interface extraction tool.
- Adding CI, Smithy-agent enforcement, or merge-blocking behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader can identify the canonical subsystem contract path convention and the three required section headings from the spec artifacts.
- **SC-002**: A later authoring feature can create a subsystem contract without making a new section-vocabulary decision.
- **SC-003**: A later presence-check feature can validate required sections without inferring heading names from prose.
- **SC-004**: A later AUTOGEN extraction feature can rely on one marker-pair convention and placement rule.
- **SC-005**: Steward contract ownership is explicitly recorded as a Castra-consumer surface, preventing omission from the M2 contract set.
