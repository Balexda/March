# Feature Specification: TypeScript Public Interface AUTOGEN Extraction

**Spec Folder**: `2026-06-07-010-typescript-public-interface-autogen-extraction`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f7`
**Created**: 2026-06-07
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 7: TypeScript Public-Interface Autogen Tool, reconciled against the source feature map present in this checkout.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 7: TypeScript Public Interface AUTOGEN Extraction

## Clarifications

### Session 2026-06-07

- This spec is reconciled against the source feature map (`docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md`), whose Feature 7 entry defines the autogen extraction tool and pins its runnable command as `npm run docs:contracts:extract`.
- Feature 1 defines the `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker convention inside `## Public Interface`. Features 2, 3, and 4 reserve empty marker pairs in subsystem contracts. Feature 5 explicitly excludes AUTOGEN extraction and generated signature replacement.
- This feature defines deterministic local extraction and replacement for exported TypeScript public surfaces. It does not author contract prose, change runtime subsystem behavior, introduce Smithy-agent enforcement, or wire CI.
- The extraction tool supports March's low-intervention model from `docs/vision.md` and `docs/operating-philosophy.md`: it must complete from local filesystem inputs, fail with bounded diagnostics, and never prompt inside an autonomous component.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Extract Exported TypeScript Surface (Priority: P1)

As the Operator-as-Test-Author, I want a deterministic extractor to summarize each watched subsystem's exported TypeScript surface so that contract public-interface sections can be checked against actual source exports.

**Why this priority**: Contract artifacts already reserve AUTOGEN regions, but empty regions cannot help L2 or L3 tests reason about source-level drift. Extraction must be stable before any replacement or verification logic can consume its output.

**Independent Test**: Run the extractor against fixture TypeScript modules with functions, classes, interfaces, types, constants, re-exports, default exports, and non-exported declarations, then verify the generated surface includes only public exports in deterministic order.

**Acceptance Scenarios**:

1. **Given** a watched source file exports functions, types, interfaces, classes, constants, and re-exports, **When** extraction runs, **Then** the output lists the public exported surface with names, export kind, and signature-level details.
2. **Given** a source file contains private helpers or local declarations, **When** extraction runs, **Then** those declarations are omitted from the generated surface.
3. **Given** the same source tree is extracted twice without changes, **When** output is compared, **Then** the generated content is byte-stable.

---

### User Story 2: Replace Contract AUTOGEN Regions Safely (Priority: P1)

As a contract maintainer, I want generated public-interface summaries written only between AUTOGEN markers so that human-authored contract prose remains stable while generated surface details refresh.

**Why this priority**: The marker convention exists to isolate generated content. Replacement must honor that boundary before the tool can be trusted on real subsystem contracts.

**Independent Test**: Run the updater against contract fixtures with valid, missing, duplicate, misplaced, and unbalanced marker pairs, then verify valid contracts are updated and invalid contracts fail without partial writes.

**Acceptance Scenarios**:

1. **Given** a contract contains exactly one AUTOGEN marker pair inside `## Public Interface`, **When** the updater runs, **Then** only the content between the markers is replaced.
2. **Given** a contract has human-authored prose before or after the marker pair, **When** the updater runs, **Then** that prose remains byte-for-byte unchanged.
3. **Given** markers are missing, duplicated, unbalanced, or outside `## Public Interface`, **When** the updater runs, **Then** it exits non-zero with bounded diagnostics and leaves the contract unchanged.

---

### User Story 3: Map Extraction Inputs to Contract Owners (Priority: P1)

As a CI Failure Triager, I want extraction to consume the same contract ownership mapping as freshness checks so that generated public surfaces land in the correct subsystem or role contract without overlapping ownership.

**Why this priority**: The contract track already treats source-to-contract ownership as explicit input. AUTOGEN extraction must reuse that ownership model rather than inferring paths ad hoc, especially for Steward where no standalone source directory exists.

**Independent Test**: Run extraction with a populated contract ownership fixture that covers Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward, then verify each output block is associated with exactly one contract and that overlapping selectors fail.

**Acceptance Scenarios**:

1. **Given** each required M2 contract has a configured public-source selector set, **When** extraction runs, **Then** each generated block is associated with exactly one owning contract path.
2. **Given** two contract entries claim the same extraction source, **When** extraction runs, **Then** it exits non-zero and reports both owners and the overlapping source selector.
3. **Given** the Steward entry is evaluated, **When** extraction resolves inputs, **Then** it uses configured role-consumer surfaces rather than requiring `src/steward/`.

---

### User Story 4: Provide Deterministic Local Command Output (Priority: P2)

As the Operator, I want a scriptable local AUTOGEN command with check and write modes so that developers, CI, and later Smithy-agent enforcement can either verify generated regions or refresh them without live service dependencies.

**Why this priority**: March's autonomous workflow needs clean exits and stable diagnostics. A local command surface lets humans and automation use the same result without Docker, service readiness, or prompts.

**Independent Test**: Invoke the command in check mode against stale generated content and in write mode against the same fixture, then verify check mode fails without editing, write mode updates only AUTOGEN regions, and both modes produce bounded output.

**Acceptance Scenarios**:

1. **Given** contract AUTOGEN regions already match extracted source surfaces, **When** check mode runs, **Then** it exits zero with stable summary output.
2. **Given** a contract AUTOGEN region is stale, **When** check mode runs, **Then** it exits non-zero and reports the owning contract path without editing files.
3. **Given** a contract AUTOGEN region is stale, **When** write mode runs, **Then** it refreshes the generated block and reports the owning contract path.
4. **Given** Docker, Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward sessions are unavailable, **When** either mode runs, **Then** it completes from filesystem inputs only.

### Edge Cases

- A TypeScript file has syntax errors or cannot be parsed.
- A source file has barrel re-exports, renamed exports, type-only exports, default exports, or namespace exports.
- Two selectors match the same source file.
- A selector matches no files because a role-level surface is future or optional.
- A contract has generated-looking content outside the marker pair.
- A contract uses marker text in a code block rather than as standalone marker lines.
- Extraction output changes only because declaration ordering is nondeterministic.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Extract Exported TypeScript Surface | — | specs/2026-06-07-010-typescript-public-interface-autogen-extraction/01-extract-exported-typescript-surface.tasks.md |
| US3 | Map Extraction Inputs to Contract Owners | US1 | — |
| US2 | Replace Contract AUTOGEN Regions Safely | US1, US3 | — |
| US4 | Provide Deterministic Local Command Output | US1, US2, US3 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a local AUTOGEN extraction command with check mode and write mode.
- **FR-002**: The command MUST run from repository filesystem inputs and MUST NOT require Docker, live March services, agent sessions, or network access.
- **FR-003**: The extractor MUST parse TypeScript source files using a syntax-aware parser rather than regular-expression matching.
- **FR-004**: The extractor MUST include exported functions, classes, interfaces, type aliases, constants, enums, re-exports, default exports, and type-only exports when they belong to the configured public source surface.
- **FR-005**: The extractor MUST omit non-exported local declarations and implementation bodies from generated public-interface output.
- **FR-006**: Generated output MUST be deterministic for unchanged source and configuration.
- **FR-007**: Generated output MUST identify export name, export kind, source file, and signature-level shape sufficient for contract review.
- **FR-008**: The updater MUST replace only content between `<!-- BEGIN AUTOGEN -->` and `<!-- END AUTOGEN -->`.
- **FR-009**: The updater MUST require exactly one AUTOGEN marker pair inside each target contract's `## Public Interface` section.
- **FR-010**: Invalid marker placement, missing markers, duplicate markers, unbalanced markers, or parse failures MUST produce a non-zero exit with bounded diagnostics and no partial contract write.
- **FR-011**: Check mode MUST report stale generated regions without modifying files.
- **FR-012**: Write mode MUST update only stale generated regions and leave human-authored prose outside markers unchanged.
- **FR-013**: Extraction ownership MUST be driven by the populated contract-source mapping used by contract freshness checks, including the required M2 contracts for Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward.
- **FR-014**: Ownership validation MUST reject duplicate contract paths and overlapping extraction source ownership.
- **FR-015**: Steward extraction ownership MUST support role-consumer source surfaces and MUST NOT require a standalone `src/steward/` module.
- **FR-016**: The command's failing output MUST include the failure category, owning contract path when available, source path when available, and a bounded diagnostic.
- **FR-017**: This feature MUST NOT author or rewrite human contract prose, change runtime subsystem behavior, add CI workflow enforcement, or implement Smithy-agent directives.

### Key Entities

- **AUTOGEN Extraction Command**: The local scriptable entrypoint that extracts public TypeScript surfaces and either verifies or refreshes generated contract regions.
- **Extraction Source Selector**: A configured repo-relative source selector that identifies public TypeScript inputs for one contract owner.
- **Public Export Summary**: A deterministic representation of an exported TypeScript declaration's externally relevant signature shape.
- **Generated Contract Block**: The Markdown content written between AUTOGEN markers inside `## Public Interface`.
- **Autogen Diagnostic**: A bounded failure record for parse, ownership, marker, stale-output, or write-safety failures.

## Assumptions

- Feature 1's AUTOGEN marker convention and required section schema are authoritative.
- Feature 5's populated freshness mapping is the canonical source-to-contract ownership input for extraction.
- The generated block supplements human-authored contract prose; it does not replace prose-level invariants or error modes.
- Deterministic local checks satisfy March's intervention-avoidance rules by turning drift into clean pass/fail output rather than interactive operator archaeology.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | The source Feature 7 prose is unavailable in this checkout, so the exact feature title and command name are inferred from adjacent specs rather than confirmed from the feature map. | Source Artifact Availability | Medium | Medium | resolved | Resolved 2026-06-07 — the source feature map is present in this checkout; Feature 7's title and command (`npm run docs:contracts:extract`) are confirmed against `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md`. |
| SD-002 | The spec requires a local command with check and write modes, but the exact npm script name is not confirmed because the source feature map is unavailable. | Interface Shape | Low | Medium | resolved | Resolved 2026-06-07 — the feature map pins the command as `npm run docs:contracts:extract`; the contracts artifact now uses that name. |

## Out of Scope

- Creating or revising the human-authored subsystem contract bodies.
- Implementing contract presence or freshness verdict logic beyond consuming its ownership mapping.
- Adding CI workflow files or merge-blocking enforcement.
- Adding Smithy-agent directives.
- Launching or querying Hatchery, Brood, Herald, Castra, Spawn, Legate, Steward, Docker, or agent-deck services.
- Generating runtime clients, SDKs, or compiled declaration files as public release artifacts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A local command can extract deterministic public export summaries for configured TypeScript source surfaces.
- **SC-002**: Valid contract AUTOGEN regions can be refreshed without changing human-authored prose outside marker pairs.
- **SC-003**: Invalid marker placement or overlapping ownership fails with bounded diagnostics and no partial writes.
- **SC-004**: Check mode detects stale generated blocks without modifying files.
- **SC-005**: Steward is supported through configured role-consumer surfaces rather than a standalone source directory.
- **SC-006**: The command runs without live service dependencies and exits cleanly in pass and fail states.
