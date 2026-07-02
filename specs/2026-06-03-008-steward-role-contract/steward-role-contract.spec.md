# Feature Specification: Steward Role Contract

**Spec Folder**: `2026-06-03-008-steward-role-contract`
**Branch**: `feature/smithy/mark/layered-testing-framework-m2-f4`
**Created**: 2026-06-03
**Status**: Draft
**Input**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` Feature 4, with RFC context from `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md` - Feature 4: Steward Role Contract

## Clarifications

### Session 2026-06-03

- The source RFC, feature map, and `docs/` tree are present in this repository. This spec is derived from them together with the adjacent M2 Feature 1-3 specs and the live Steward-related boundaries in Hatchery, Brood, Herald, Castra, Spawn, and Legate.
- The slice is documentation-only: it authors the Steward role contract artifact but does not implement patch application, PR creation, presence checks, freshness checks, AUTOGEN extraction, CI changes, or runtime behavior.
- Steward is a role-level contract for the Castra-hosted manager session that turns validated spawn output into a git-indexed patch and PR-ready branch state. It is not a standalone TypeScript subsystem with its own service routes.
- The contract consumes Feature 1's required section schema: `## Public Interface`, `## Invariants`, and `## Error Modes`.
- The Steward contract may reference Castra, Hatchery, Brood, Herald, Spawn, and Legate as integration boundaries, but it must not re-document their HTTP route contracts or loop contracts.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Document Steward Launch and Input Contract (Priority: P1)

As the Operator-as-Test-Author, I want Steward's launch inputs and role scope documented so that L2 tests can assert when a validated spawn result is eligible for human-free PR integration.

**Why this priority**: Steward is the final autonomous agent boundary before patch application and PR creation. The testing framework needs to know exactly which validated output and correlation facts are required before a Steward session can be launched.

**Independent Test**: Inspect `docs/subsystems/steward/contract.md` and verify it contains the three required sections, documents validated patch input, spawn/slice/session correlation, repository worktree context, profile selection, role prompt expectations, and an empty AUTOGEN marker pair inside `## Public Interface`.

**Acceptance Scenarios**:

1. **Given** Hatchery has a successful spawn result with validated patch output, **When** it reads the Steward contract, **Then** it can identify the required patch, worktree, branch, spawn id, slice id, and profile/session facts needed to launch the manager session.
2. **Given** a spawn result is failed, malformed, missing, ambiguous, unsafe, or no-op, **When** the Steward contract describes launch eligibility, **Then** it states that no Steward session is launched for that result.
3. **Given** Steward is hosted through Castra, **When** the contract documents launch behavior, **Then** it treats Castra as the session host and not as the owner of Steward's role semantics.

---

### User Story 2: Document Patch Application and PR-Ready Outcome Contract (Priority: P1)

As the CI Failure Triager, I want Steward's patch-application behavior documented so that failed handoffs, dirty worktrees, and PR-ready outcomes can be diagnosed against explicit promises instead of session transcripts.

**Why this priority**: Steward applies untrusted generated output to a real worktree. The role contract must fail closed and expose bounded diagnostics before downstream merge automation or babysitting treats the result as ready.

**Independent Test**: Inspect `docs/subsystems/steward/contract.md` and verify it documents `git apply --index` behavior, fallback or conflict handling, dirty-worktree constraints, acceptance reporting, failure reporting, and the distinction between PR-ready branch state and PR creation tooling.

**Acceptance Scenarios**:

1. **Given** the validated patch applies cleanly to the expected worktree, **When** Steward reports success, **Then** the contract states that the index and worktree reflect the patch and the branch is PR-ready for the owning integration path.
2. **Given** the patch cannot apply, applies outside the allowed worktree, or leaves an incoherent index, **When** Steward reports failure, **Then** the contract states that the failure is terminal or evented with bounded diagnostics rather than an interactive prompt.
3. **Given** PR creation is handled by the manager or a later integration boundary, **When** the Steward contract describes outcomes, **Then** it records only Steward's PR-ready state and does not require this feature to create a PR.

---

### User Story 3: Document Steward Lifecycle, Tracking, and Cleanup Boundaries (Priority: P1)

As the Operator, I want Steward's lifecycle and cleanup boundaries documented so that Brood, Herald, Castra, and Legate can observe or tear down the session without guessing which subsystem owns each fact.

**Why this priority**: Steward sessions can strand worktrees or branches if their lifecycle is not linked to the spawn that created them. M2's explicit contracts must make the spawn-steward correlation and teardown boundary testable.

**Independent Test**: Inspect `docs/subsystems/steward/contract.md` and verify it documents Brood registration, Herald `slice.steward.attached` correlation, Castra session identity, parent spawn ownership, teardown expectations, and loss/timeout behavior.

**Acceptance Scenarios**:

1. **Given** a Steward session is launched, **When** the contract documents tracking, **Then** it states that the steward session id, spawn id, slice id, profile, branch, and worktree facts are publishable to Brood and Herald for later observation.
2. **Given** Steward removal is requested, **When** the contract describes cleanup, **Then** it states that Castra owns removing the interactive session while Brood owns exact worktree and branch cleanup ordering.
3. **Given** a Steward session disappears, stalls, or becomes unreachable, **When** Legate or Brood observes it, **Then** the contract identifies the observable failure state and forbids waiting forever on input the role cannot receive.

---

### User Story 4: Record Cross-Contract Ownership for Steward Consumers (Priority: P2)

As a contract maintainer, I want the Steward contract to name its consumer/provider boundaries so that freshness checks and L2 tests can watch the right sources without duplicating other subsystem contracts.

**Why this priority**: Steward is not a standalone source module. Its contract must be explicit about role ownership and consumer surfaces so later freshness mapping does not omit it or assign it to the wrong subsystem.

**Independent Test**: Inspect the Steward contract and verify it references Spawn, Hatchery, Brood, Herald, Castra, and Legate only as boundaries, with Steward owning role semantics, patch-application promises, and PR-ready outcome semantics.

**Acceptance Scenarios**:

1. **Given** Steward depends on Spawn output validation, **When** a maintainer reads the contract, **Then** it distinguishes Steward-owned application behavior from Spawn-owned validation behavior.
2. **Given** Steward is launched and removed through Castra, **When** a maintainer reads the contract, **Then** it distinguishes Steward-owned role semantics from Castra-owned HTTP/session routes.
3. **Given** freshness tooling lands later, **When** it maps Steward sources, **Then** it binds Steward to the non-overlapping partition the feature map pins — `src/castra/client.ts` plus `src/hatchery/spawn-handoff.ts` — rather than a nonexistent standalone module, leaving the Castra server route surface (`src/castra/server.ts`) and the Brood/Herald/Legate service and loop surfaces owned by F2/F3 so freshness requirements do not overlap.

### Edge Cases

- A validated patch is syntactically valid but conflicts with the current worktree.
- A patch applies to the worktree but not cleanly to the index.
- The target worktree is missing, dirty, or different from the spawn/steward correlation record.
- Castra launches the session but Brood or Herald registration fails best-effort.
- Steward accepts work but never reports a terminal outcome.
- Steward is removed before worktree cleanup and may already have removed or modified files.
- A future freshness mapping needs to watch role prompt templates and Hatchery/Castra consumer surfaces rather than a single `src/steward/` directory.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Document Steward Launch and Input Contract | — | specs/2026-06-03-008-steward-role-contract/01-document-steward-launch-and-input-contract.tasks.md |
| US2 | Document Patch Application and PR-Ready Outcome Contract | US1 | specs/2026-06-03-008-steward-role-contract/02-document-patch-application-and-pr-ready-outcome-contract.tasks.md |
| US3 | Document Steward Lifecycle, Tracking, and Cleanup Boundaries | US1 | specs/2026-06-03-008-steward-role-contract/03-document-steward-lifecycle-tracking-and-cleanup-boundaries.tasks.md |
| US4 | Record Cross-Contract Ownership for Steward Consumers | US1, US2, US3 | specs/2026-06-03-008-steward-role-contract/04-record-cross-contract-ownership-for-steward-consumers.tasks.md |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST author `docs/subsystems/steward/contract.md`.
- **FR-002**: The authored contract MUST include `## Public Interface`, `## Invariants`, and `## Error Modes` as H2 sections.
- **FR-003**: The authored contract MUST place an empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker pair inside `## Public Interface`.
- **FR-004**: The Steward contract MUST document required launch inputs: validated patch output, target worktree, target branch, spawn id, slice id, session/profile metadata, and role prompt context.
- **FR-004a**: The Steward `## Public Interface` MUST pin the Castra session-launch consumer surface — the `launch`, `send`, `output`, and `remove` methods of `src/castra/client.ts` as consumed by `src/hatchery/spawn-handoff.ts` — naming those methods explicitly rather than documenting only the data envelope, while cross-referencing Castra's contract for the server-side `/v1/sessions*` wire shapes instead of restating them.
- **FR-005**: The Steward contract MUST state that failed, malformed, missing, ambiguous, unsafe, or no-op spawn output is not eligible for Steward launch.
- **FR-006**: The Steward contract MUST document patch-application behavior, including index-aware application, conflict/failure handling, dirty-worktree constraints, and bounded diagnostics.
- **FR-007**: The Steward contract MUST document PR-ready outcome semantics without requiring this feature to create, push, or merge a PR.
- **FR-008**: The Steward contract MUST document lifecycle tracking through Brood steward rows, Herald `slice.steward.attached` correlation, Castra session identity, and parent spawn ownership.
- **FR-009**: The Steward contract MUST document cleanup boundaries: Castra owns interactive-session removal; Brood owns exact tracked worktree and branch cleanup ordering.
- **FR-010**: The Steward contract MUST document loss, timeout, unavailable-session, patch-apply, registration, and cleanup error modes as clean events or terminal diagnostics rather than interactive prompts.
- **FR-011**: The Steward contract MUST name cross-contract ownership boundaries without re-documenting Feature 2 service HTTP routes, Feature 3 Spawn/Legate contracts, or Spawn output-validation internals.
- **FR-012**: This feature MUST NOT implement contract checkers, freshness globs, AUTOGEN generation, CI enforcement, runtime behavior changes, PR creation, push/merge behavior, or a new standalone Steward service.

### Key Entities

- **Steward Role Contract**: A subsystem contract artifact documenting the Castra-hosted manager role that applies validated spawn output and reaches a PR-ready or failed outcome.
- **Steward Launch Envelope**: The validated patch, worktree, branch, spawn/slice/session ids, profile, and prompt context required to launch the role.
- **Patch Application Promise**: An assertable statement about applying the validated patch to the expected worktree and index, or failing with bounded diagnostics.
- **PR-Ready Outcome**: A terminal Steward success state where the target branch and index/worktree contain the accepted patch and downstream PR tooling can proceed.
- **Steward Lifecycle Correlation**: The Brood, Herald, Castra, Spawn, and Legate facts that identify and observe one Steward session.
- **Role-Consumer Freshness Binding**: The rule that Steward freshness maps to role prompt and consumer surfaces rather than a standalone source module.

## Assumptions

- Feature 1's section schema and AUTOGEN marker convention are the authoritative structure for this contract.
- Feature 2 already owns Hatchery, Brood, Herald, and Castra HTTP route contracts; this feature references those service contracts only as dependencies.
- Feature 3 already owns Spawn and Legate contracts; this feature references their handoff and babysit boundaries without restating their full behavior.
- Steward is represented in live code as a Castra-hosted interactive session plus Hatchery/Brood/Herald/Legate consumer behavior, not as a dedicated `src/steward/` module.
- The contract supports March's intervention-avoidance rules by documenting clean failed outcomes and evented escalations rather than interactive prompts inside autonomous components.

## Specification Debt

None - all ambiguities resolved.

## Out of Scope

- Implementing or modifying Hatchery handoff, Castra launch/removal, Brood registration/teardown, Herald events, Spawn output extraction, Legate babysit behavior, or PR integration.
- Creating a new Steward runtime module, service, HTTP API, CLI command, or agent-deck adapter.
- Implementing contract presence checks, freshness checks, Smithy-agent enforcement, AUTOGEN extraction, or CI workflows.
- Populating `docs/subsystems/contract-freshness.config.json` with concrete source globs.
- Generating command, route, prompt, or TypeScript exported-signature content inside AUTOGEN blocks.
- Creating, pushing, merging, or opening a PR from this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One new contract artifact exists at the Steward subsystem contract path.
- **SC-002**: The new contract contains the three required H2 sections from Feature 1.
- **SC-003**: The new contract includes an empty AUTOGEN marker pair inside `## Public Interface`.
- **SC-004**: Steward's contract records launch eligibility, validated patch input, target worktree/branch context, and role prompt/session metadata.
- **SC-005**: Steward's contract records patch-application, index/worktree, PR-ready, and failed-outcome promises.
- **SC-006**: Steward's contract records Brood, Herald, Castra, Spawn, Hatchery, and Legate lifecycle/correlation boundaries.
- **SC-007**: Cross-contract boundaries are named without duplicating Feature 2 service routes, Feature 3 Spawn/Legate content, or Spawn output-validation internals.
