# Feature Specification: Contract Presence and Freshness Verdict

**Spec Folder**: `2026-06-06-009-contract-presence-and-freshness-verdict`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f5`
**Created**: 2026-06-06
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 5, with inferred context from adjacent M2 Feature 1-4 specs.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 5: Contract Presence and Freshness Verdict

## Clarifications

### Session 2026-06-06

- The source feature map (`docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md`) is present in this checkout, and this spec was reconciled against its explicit Feature 5 prose. Adjacent M2 Feature 1-4 specs and the live repository layout supplied additional context.
- Feature 1 defines the required contract section schema and freshness configuration shape. Features 2, 3, and 4 author the Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward contract artifacts. This feature consumes those artifacts and specifies deterministic local verdict tooling.
- The verdict is local and non-interactive: it reports contract presence, required-section compliance, freshness-config validity, and source/contract drift as clean pass/fail output. It does not prompt the operator or block on unavailable input.
- This feature owns populated freshness mappings for the M2 contract set. Smithy-agent enforcement, CI wiring, and AUTOGEN extraction remain later features.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Validate Required Contract Presence (Priority: P1)

As the Operator-as-Test-Author, I want one local verdict command to confirm every M2 subsystem contract exists and contains the required section headings so that contract coverage is testable before L2 scenarios depend on it.

**Why this priority**: The layered testing framework treats explicit subsystem contracts as test inputs. Presence and required-section checks must fail deterministically before freshness checking can produce meaningful drift results.

**Independent Test**: Run the verdict command against fixtures or a temporary workspace with a missing contract and a malformed contract, then verify it exits non-zero with repo-relative paths and named missing sections.

**Acceptance Scenarios**:

1. **Given** every required M2 contract exists, **When** the verdict command runs, **Then** it confirms coverage for Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward.
2. **Given** a contract file is missing, **When** the verdict command runs, **Then** it exits non-zero and reports the missing repo-relative path.
3. **Given** a contract lacks `## Public Interface`, `## Invariants`, or `## Error Modes`, **When** the verdict command runs, **Then** it exits non-zero and names the contract path plus missing heading.

---

### User Story 2: Populate and Validate Contract Freshness Mapping (Priority: P1)

As a contract maintainer, I want a checked freshness configuration that maps each contract to non-overlapping public source selectors so that later source changes can be tied to the contract that must be reviewed.

**Why this priority**: Feature 1 intentionally recorded only the schema shape. This feature must provide the populated M2 mapping before source/contract drift can be evaluated without ad hoc path inference.

**Independent Test**: Inspect `docs/subsystems/contract-freshness.config.json` and run config validation to prove each required contract has one entry, every contract path is unique, every source selector is owned by one entry, and Steward binds to its role-consumer surfaces rather than a nonexistent `src/steward/` module.

**Acceptance Scenarios**:

1. **Given** the config is valid, **When** the verifier reads it, **Then** each required M2 contract has exactly one entry with a contract path and at least one public source selector.
2. **Given** two entries claim the same public source selector, **When** the verifier reads the config, **Then** it exits non-zero and reports the overlapping entries.
3. **Given** the Steward entry is evaluated, **When** the verifier reads its source selectors, **Then** it maps to Castra/Hatchery role-consumer surfaces rather than requiring a standalone Steward source directory.

---

### User Story 3: Report Source and Contract Freshness Drift (Priority: P1)

As the CI Failure Triager, I want the verdict command to compare changed public sources with changed contract artifacts so that behavior-affecting subsystem changes do not merge with stale contracts.

**Why this priority**: The contract track exists to make tests and docs agree on subsystem boundaries. A presence-only checker would still allow source changes to drift away from the contracts that tests read.

**Independent Test**: Run the verdict command with an injected changed-file list or git diff base where a mapped source path changes without its contract, then verify it fails with the owning contract path; rerun with both source and contract changed and verify it passes the freshness check.

**Acceptance Scenarios**:

1. **Given** a changed file matches a configured public source selector, **When** the owning contract path is also changed, **Then** freshness passes for that entry.
2. **Given** a changed file matches a configured public source selector but the owning contract path is unchanged, **When** the verdict command runs, **Then** it exits non-zero and reports the source path, contract path, and owning subsystem.
3. **Given** only a contract artifact changes, **When** the verdict command runs, **Then** it does not fail freshness solely because no public source changed.

---

### User Story 4: Provide Deterministic Local Verdict Output (Priority: P2)

As the Operator, I want a stable npm-run verdict command with bounded diagnostics so that local development, CI, and future Smithy-agent enforcement can consume the same result without interactive triage.

**Why this priority**: March's autonomous flow requires clean exits rather than hangs. The verdict command must be scriptable and bounded before later enforcement layers reuse it.

**Independent Test**: Invoke the npm script in passing and failing states and verify the exit code, stable diagnostic fields, and absence of prompts or live service dependencies.

**Acceptance Scenarios**:

1. **Given** all checks pass, **When** the npm script runs, **Then** it exits zero with stable summary output.
2. **Given** any presence, config, or freshness check fails, **When** the npm script runs, **Then** it exits non-zero with bounded diagnostics that name the failing category and paths.
3. **Given** Docker, Castra, Hatchery, Brood, Herald, or Legate services are not running, **When** the verdict command runs, **Then** it still completes from filesystem and git inputs only.

### Edge Cases

- A contract contains the required heading text in a code block or nested heading rather than as an H2.
- A selector matches generated or dependency directories that should not participate in freshness checks.
- A changed-file list contains deleted files, renamed files, or paths outside the repository root.
- A contract path is duplicated under two config entries.
- A source selector is syntactically valid but currently matches no files because the owning surface is future or role-level.
- The git diff base is unavailable in a shallow or detached checkout; the command must fail cleanly or accept an explicit changed-file input.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Validate Required Contract Presence | — | — |
| US2 | Populate and Validate Contract Freshness Mapping | US1 | — |
| US3 | Report Source and Contract Freshness Drift | US1, US2 | — |
| US4 | Provide Deterministic Local Verdict Output | US1, US2, US3 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a local contract verdict command reachable through the `npm run docs:contracts:check` script (the entrypoint name committed by the Feature 5 feature map).
- **FR-002**: The verdict command MUST check for required contract artifacts at `docs/subsystems/hatchery/contract.md`, `docs/subsystems/brood/contract.md`, `docs/subsystems/herald/contract.md`, `docs/subsystems/castra/contract.md`, `docs/subsystems/spawn/contract.md`, `docs/subsystems/legate/contract.md`, and `docs/subsystems/steward/contract.md`.
- **FR-003**: Each checked contract MUST contain exactly one H2 `## Public Interface`, exactly one H2 `## Invariants`, and exactly one H2 `## Error Modes`. Uniqueness is intentional: it keeps section lookup unambiguous for the presence check and downstream AUTOGEN/marker placement, so a duplicated required heading is a verdict failure rather than a tolerated case.
- **FR-004**: Required-heading detection MUST parse Markdown headings rather than matching arbitrary body text.
- **FR-005**: The system MUST author and validate `docs/subsystems/contract-freshness.config.json` with populated entries for the required M2 contracts.
- **FR-006**: Each freshness config entry MUST contain a stable `name`, `contractPath`, and non-empty `publicSourcePaths` selector list.
- **FR-007**: Freshness config validation MUST reject duplicate contract paths and overlapping public-source ownership.
- **FR-008**: The Steward freshness entry MUST bind to role-consumer surfaces, including the Castra client and Hatchery handoff path, rather than a standalone `src/steward/` module.
- **FR-009**: The verdict command MUST compare changed public source paths with changed contract paths using deterministic filesystem and git inputs.
- **FR-010**: A public source change that matches a config entry MUST require the owning contract path to be present in the same changed-file set, unless the caller explicitly disables freshness checking for a documented local mode.
- **FR-011**: Contract-only changes MUST NOT fail freshness solely because no mapped public source changed.
- **FR-012**: Failing verdict output MUST include the check category, owning name when available, source path when available, contract path when available, and a bounded diagnostic.
- **FR-013**: The verdict command MUST NOT require live Docker, Hatchery, Brood, Herald, Castra, Legate, agent-deck, or network services.
- **FR-014**: The verdict command MUST NOT implement Smithy-agent enforcement, CI workflow changes, AUTOGEN extraction, generated signature replacement, or runtime subsystem behavior changes.

### Key Entities

- **Contract Verdict Command**: The local scriptable checker that returns pass/fail results for contract presence, required sections, config validity, and freshness drift.
- **Required Contract Set**: The seven M2 contract paths for Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward.
- **Contract Freshness Config**: The populated JSON mapping from contract paths to public source selectors.
- **Freshness Entry**: One mapping row containing a subsystem or role name, a contract path, source selectors, and optional ownership notes.
- **Changed File Set**: The deterministic list of repo-relative changed paths used to evaluate freshness.
- **Verdict Diagnostic**: A bounded machine-readable or stable text finding emitted when a check fails.

## Assumptions

- Feature 1's section schema and freshness config shape are authoritative.
- Features 2, 3, and 4 define the required M2 contract artifact set.
- The verdict command supports March's `docs/vision.md` and `docs/operating-philosophy.md` model by replacing operator archaeology with clean local pass/fail output and no interactive prompts inside autonomous components.
- Freshness checking is conservative: a mapped public source change requires its contract to be reviewed in the same change set.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Earlier drafting assumed the source feature map was unavailable; it is in fact present in-repo, and this spec was reconciled against its explicit Feature 5 prose ("Contract Presence & Freshness Check", `npm run docs:contracts:check`). | Source Artifact Availability | Low | High | resolved | Reconciled against `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 5; no further action. |
| SD-002 | The implementation must choose whether the verdict output is JSON, stable text, or both. The spec requires stable bounded diagnostics but leaves transport shape to slicing. | Interface Shape | Low | Medium | open | Resolve during task slicing before implementation. |

## Out of Scope

- Authoring or changing the subsystem contract bodies from Features 2, 3, and 4.
- Implementing Smithy-agent directives or merge-blocking behavior.
- Updating CI workflow files.
- Implementing AUTOGEN extraction or generated signature replacement.
- Launching services, querying live HTTP APIs, or changing runtime subsystem behavior.
- Inferring freshness from untracked files outside the repository root.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A local npm-run command reports whether all required M2 contract artifacts exist.
- **SC-002**: The command fails when any required contract lacks one of the three required H2 sections.
- **SC-003**: A populated freshness configuration maps each required M2 contract to non-overlapping public source selectors.
- **SC-004**: A mapped public source change without the owning contract change fails the freshness verdict with bounded diagnostics.
- **SC-005**: The verdict command runs without live service dependencies and exits cleanly in pass and fail states.
