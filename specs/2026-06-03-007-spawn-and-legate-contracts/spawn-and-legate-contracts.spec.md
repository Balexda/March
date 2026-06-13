# Feature Specification: Spawn and Legate Contracts

**Spec Folder**: `2026-06-03-007-spawn-and-legate-contracts`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f3`
**Created**: 2026-06-03
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 3, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 3: Spawn and Legate Contracts

## Clarifications

### Session 2026-06-03

- The current Hatchery snapshot contains the existing Feature 1 and Feature 2 specs for this track but does not contain the source RFC, feature map, or `docs/` tree. This spec is derived from the adjacent track artifacts and live subsystem boundaries. [Critical Assumption]
- The slice is documentation-only: it authors Spawn and Legate contract artifacts but does not implement presence checks, freshness checks, AUTOGEN extraction, CI changes, or runtime behavior.
- Feature 2 explicitly leaves Spawn, Legate, and Steward out of the containerized-service contract slice and states that Steward's consumer contract is authored by Feature 4. Feature 3 therefore covers Spawn and Legate only.
- The contracts consume Feature 1's required section schema: `## Public Interface`, `## Invariants`, and `## Error Modes`.
- The Spawn contract documents the public dispatch lifecycle and output handoff promises, not every internal helper or historical M1 flat-file detail.
- The Legate contract documents the autonomous loop's observable command, service-client, event-consumption, and terminal-state behavior in support of the low-touch execution model described in `docs/vision.md` and `docs/operating-philosophy.md`.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Document Spawn Dispatch Contract (Priority: P1)

As the Operator-as-Test-Author, I want Spawn's dispatch and result contract documented so that L2 tests can assert the lifecycle boundary without reverse-engineering the CLI, Hatchery handoff, or legacy spawn artifacts.

**Why this priority**: Spawn is the autonomous execution unit that produces work for downstream validation and Steward handoff. Later contract freshness and L2 cassette tests need a stable description of its input, lifecycle, output, and failure promises before asserting cross-subsystem behavior.

**Independent Test**: Inspect `docs/subsystems/spawn/contract.md` and verify it contains the three required sections, documents accepted dispatch inputs, lifecycle state promises, backend/output handoff behavior, cleanup boundaries, observable errors, and an empty AUTOGEN marker pair inside `## Public Interface`.

**Acceptance Scenarios**:

1. **Given** an operator or Hatchery submits a spawn dispatch, **When** it reads the Spawn contract, **Then** it can identify the required prompt and repository context plus accepted backend/profile metadata.
2. **Given** a spawn moves through execution, **When** the contract describes invariants, **Then** it states the observable lifecycle states, record ownership, and terminal-state requirement before output extraction.
3. **Given** a spawn emits backend output, **When** downstream automation reads the contract, **Then** it can identify that raw backend output is untrusted until validated and that no Steward handoff occurs for failed extraction.
4. **Given** dispatch fails before or during container execution, **When** the contract describes error modes, **Then** it states the externally visible diagnostic and cleanup expectations without requiring an interactive prompt.

---

### User Story 2: Document Legate Loop Contract (Priority: P1)

As the CI Failure Triager, I want Legate's autonomous loop contract documented so that stalled slices, missing events, and terminal outcomes can be diagnosed against explicit promises instead of terminal logs.

**Why this priority**: Legate is the originator of per-slice traces and the consumer of Herald, Hatchery, Brood, and Castra state. The testing framework needs its event-drain, dispatch, babysit, and terminal-state behavior documented before system-level tests can prove the loop does not hang.

**Independent Test**: Inspect `docs/subsystems/legate/contract.md` and verify it contains the three required sections, documents the loop's command surface, observed service dependencies, slice state model, event cursor behavior, dispatch/relaunch actions, terminal outcomes, and an empty AUTOGEN marker pair inside `## Public Interface`.

**Acceptance Scenarios**:

1. **Given** Legate observes Herald events, **When** it reads the Legate contract, **Then** it can identify cursor ownership, replay behavior, and how event deltas update slice state.
2. **Given** a runnable slice is selected, **When** the contract documents dispatch behavior, **Then** it states the Hatchery request metadata and deterministic trace/span relationship for that slice.
3. **Given** a slice reaches a terminal state, **When** the contract describes outcomes, **Then** it identifies the terminal labels that stop further autonomous action and the events or service state that justify them.
4. **Given** a worker or steward stalls, **When** the contract describes babysit behavior, **Then** it states that timeout or relaunch decisions become clean events or terminal failures rather than blocked operator prompts.

---

### User Story 3: Record Cross-Contract Ownership Boundaries (Priority: P2)

As a contract maintainer, I want the Spawn and Legate contracts to name their service-boundary dependencies so that later freshness mappings can watch the right source owners without duplicating Hatchery, Brood, Herald, Castra, or Steward content.

**Why this priority**: Spawn and Legate span multiple subsystems. Without explicit ownership boundaries, their contracts could either restate service contracts from Feature 2 or omit the relationships that future L2 tests and freshness checks need.

**Independent Test**: Inspect both new contracts and verify they reference Hatchery, Brood, Herald, Castra, and Steward only as integration boundaries, not as re-authored route or role contracts.

**Acceptance Scenarios**:

1. **Given** the Spawn contract references Hatchery, Brood, Castra, or Steward, **When** a maintainer reads it, **Then** it distinguishes Spawn-owned lifecycle/output promises from service route contracts owned elsewhere.
2. **Given** the Legate contract references Herald, Hatchery, Brood, or Castra, **When** a maintainer reads it, **Then** it distinguishes Legate-owned loop decisions from service route contracts owned elsewhere.
3. **Given** the Steward role contract lands later, **When** these contracts are read, **Then** they do not preempt Feature 4's Steward-specific public interface.

### Edge Cases

- A spawn dispatch can fail before any container or worktree exists.
- A spawn can stop successfully but emit malformed, missing, ambiguous, or unsafe output.
- Hatchery can accept a job while downstream Brood, Herald, or Castra registration fails best-effort.
- Legate can observe events after a cursor gap, duplicate event, or service restart.
- Legate can encounter a nonterminal slice whose worker or steward is gone.
- A contract freshness mapping can need to watch role-consumer source paths rather than a single subsystem directory.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Document Spawn Dispatch Contract | — | specs/2026-06-03-007-spawn-and-legate-contracts/01-document-spawn-dispatch-contract.tasks.md |
| US2 | Document Legate Loop Contract | — | specs/2026-06-03-007-spawn-and-legate-contracts/02-document-legate-loop-contract.tasks.md |
| US3 | Record Cross-Contract Ownership Boundaries | US1, US2 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST author `docs/subsystems/spawn/contract.md` and `docs/subsystems/legate/contract.md`.
- **FR-002**: Each authored contract MUST include `## Public Interface`, `## Invariants`, and `## Error Modes` as H2 sections.
- **FR-003**: Each authored contract MUST place an empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker pair inside `## Public Interface`.
- **FR-004**: The Spawn contract MUST document accepted dispatch inputs and metadata, including prompt, repository context, backend, profile, branch, task identity, and slice correlation.
- **FR-005**: The Spawn contract MUST document lifecycle-state promises from accepted work through terminal completion or failure, including the requirement that output extraction only consumes terminal successful spawn output.
- **FR-006**: The Spawn contract MUST document validated-output handoff expectations and state that malformed, unsafe, failed, or no-op output prevents Steward handoff.
- **FR-007**: The Spawn contract MUST document observable cleanup and failure behavior for dependency failures, launch failures, timeout, backend failure, output capture failure, and validation failure.
- **FR-008**: The Legate contract MUST document the loop's public command or process surface, configuration inputs, and service dependencies.
- **FR-009**: The Legate contract MUST document Herald cursor consumption, state projection, slice selection, dispatch, babysit, relaunch, and terminal-outcome behavior.
- **FR-010**: The Legate contract MUST document deterministic trace ownership for slice dispatch and require service-side actions to nest under the slice trace instead of starting unrelated roots.
- **FR-011**: The Legate contract MUST document error modes for missing service readiness, invalid event streams, duplicate or stale slice state, Hatchery dispatch failure, Castra or steward loss, timeout, and cleanup failure.
- **FR-012**: Both contracts MUST name cross-contract ownership boundaries without re-documenting Feature 2's HTTP route details or Feature 4's Steward role interface.
- **FR-013**: This feature MUST NOT implement contract checkers, freshness globs, AUTOGEN generation, CI enforcement, runtime route changes, loop behavior changes, or Steward-specific contract content.
- **FR-014**: Each authored contract's `## Public Interface` MUST document the subsystem's exported-signature-level TypeScript surface — the entrypoint types and functions of the subsystem module (Spawn's dispatch/execution entrypoints; Legate's loop/serve entrypoints) — as human-authored prose, so the documented interface covers the exported surface that F7's AUTOGEN block later reconciles and not only dispatch metadata or command/process behavior.

### Key Entities

- **Spawn Contract**: A subsystem contract artifact documenting dispatch inputs, lifecycle invariants, output handoff promises, and externally visible failure modes for autonomous spawn execution.
- **Legate Contract**: A subsystem contract artifact documenting the autonomous loop's command/process surface, observed state, dispatch actions, babysit behavior, and terminal outcomes.
- **Lifecycle Promise**: An assertable statement about state progression, terminal-state handling, cleanup, or handoff eligibility.
- **Cross-Contract Boundary**: A named relationship to another subsystem contract that identifies dependency ownership without duplicating that contract's public interface.
- **Autogen Region Placeholder**: An empty generated-content region reserved for later TypeScript or command-surface extraction.

## Assumptions

- Feature 1's section schema and AUTOGEN marker convention are the authoritative structure for these contracts.
- Feature 2 already owns Hatchery, Brood, Herald, and Castra HTTP route contracts; this feature references those service contracts only as dependencies.
- Feature 4 owns the Steward role contract; this feature references Steward handoff eligibility and loss only from the Spawn and Legate side of the boundary.
- Brood is the canonical lifecycle authority where live code has moved beyond legacy spawn flat-file records.
- The contracts support March's intervention-avoidance rules by documenting clean terminal failures and evented escalations rather than interactive prompts.

## Specification Debt

None - all ambiguities resolved.

## Out of Scope

- Authoring Hatchery, Brood, Herald, Castra, or Steward contract bodies.
- Implementing or modifying Spawn, Hatchery, Brood, Herald, Castra, Legate, or Steward runtime code.
- Implementing contract presence checks, freshness checks, Smithy-agent enforcement, AUTOGEN extraction, or CI workflows.
- Populating `docs/subsystems/contract-freshness.config.json` with concrete source globs.
- Generating command, route, or TypeScript exported-signature content inside AUTOGEN blocks.
- Changing dispatch, extraction, PR integration, relaunch, babysit, tracing, metrics, or cleanup behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Two new contract artifacts exist at the Spawn and Legate subsystem contract paths.
- **SC-002**: Each new contract contains the three required H2 sections from Feature 1.
- **SC-003**: Each new contract includes an empty AUTOGEN marker pair inside `## Public Interface` for later extraction.
- **SC-004**: Spawn's contract records dispatch input, lifecycle, terminal output, handoff, cleanup, and error-mode promises.
- **SC-005**: Legate's contract records loop input, event cursor, slice-state, dispatch, babysit, terminal-outcome, and error-mode promises.
- **SC-006**: Cross-contract boundaries are named without duplicating Feature 2 service routes or Feature 4 Steward role content.
