# Data Model: Steward Role Contract

## Overview

This model supports a documentation-only contract for the Steward role. Steward is not a standalone service in the current codebase; it is the Castra-hosted manager session that consumes validated spawn output, applies a patch to the expected worktree, and reaches a PR-ready or failed outcome. The model captures the contract artifact, launch envelope, patch-application promise, lifecycle correlation, and cross-contract ownership boundaries that later tests, presence checks, freshness checks, and AUTOGEN extraction consume.

## Entities

### 1) Steward Contract (`docs/subsystems/steward/contract.md`)

Purpose: Represents the explicit contract artifact for the Steward role boundary.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | `docs/subsystems/steward/contract.md`. |
| `subsystem` | enum | Yes | `steward`. |
| `publicInterfaceSection` | markdown H2 section | Yes | Documents externally consumed launch, role, prompt, patch-application, lifecycle, and outcome surfaces. |
| `invariantsSection` | markdown H2 section | Yes | Documents assertable role and patch promises. |
| `errorModesSection` | markdown H2 section | Yes | Documents observable failure conditions and outcomes. |
| `autogenRegion` | marker pair | Yes | Empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` pair inside `## Public Interface`. |

Validation rules:
- The contract has exactly one `## Public Interface`, `## Invariants`, and `## Error Modes` section.
- The AUTOGEN marker pair is present but empty in this feature.
- Invariants and error modes are written as observable, testable claims.
- The contract describes Steward as a role-level Castra consumer, not as a new HTTP service.

### 2) Steward Launch Envelope (`steward_launch_envelope`)

Purpose: Captures the facts required before a Steward session may be launched.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `validatedPatch` | patch payload | Yes | Spawn output that has already passed validation and is safe to attempt applying. |
| `worktreePath` | absolute path | Yes | Target checkout associated with the spawn/steward correlation. |
| `branch` | git ref | Yes | Branch where the patch is applied and later PR tooling acts. |
| `spawnId` | string | Yes | Parent spawn identity. |
| `sliceId` | string | Yes | Slice identity used for trace and Herald correlation. |
| `stewardSessionId` | string | Yes after launch | Castra or agent-deck session id for the manager session. |
| `profile` | string | Yes | Profile/group used when launching through Castra. |
| `rolePromptContext` | prompt metadata | Yes | Hatchery instructions and acceptance/reporting constraints for the manager role. |

Validation rules:
- Launch is permitted only when the spawn output is validated and non-empty.
- Failed, malformed, missing, ambiguous, unsafe, or no-op output fails closed and does not launch Steward.
- The worktree, branch, spawn id, and slice id remain correlated for Brood, Herald, Castra, and Legate observation.

### 3) Patch Application Contract (`steward_patch_application_contract`)

Purpose: Captures Steward-owned promises for applying validated output.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `applyMode` | rule | Yes | Index-aware git patch application such as `git apply --index`, with documented fallback/conflict behavior when supported. |
| `targetWorktreeRule` | rule | Yes | Patch application happens only in the expected worktree. |
| `dirtyWorktreeRule` | rule | Yes | Dirty or mismatched worktree state is diagnosed before success is reported. |
| `successOutcome` | state | Yes | PR-ready branch/index/worktree state. |
| `failureOutcome` | state | Yes | Terminal or evented failure with bounded diagnostics. |

Validation rules:
- Success requires the expected branch/worktree to contain the accepted patch.
- Failure does not request interactive input inside the autonomous role.
- Diagnostics are bounded and suitable for event, session, or operator display.
- PR-ready state does not imply this feature creates, pushes, merges, or opens a PR.

### 4) Steward Lifecycle Correlation (`steward_lifecycle_correlation`)

Purpose: Records the observable session-tracking facts for one Steward session.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `broodSpawnRow` | session reference | Yes | Parent spawn row carrying container/worktree/branch ownership. |
| `broodStewardRow` | session reference | Yes after launch | Steward row linked to the parent spawn. |
| `heraldAttachedEvent` | event reference | Yes after publish | `slice.steward.attached` with slice/session/spawn correlation. |
| `castraSession` | session reference | Yes after launch | Interactive session hosted by Castra/agent-deck. |
| `legateObservation` | loop state | Conditional | Legate-observed steward attachment, loss, timeout, or terminal outcome. |
| `teardownBoundary` | rule | Yes | Castra removes the interactive session; Brood owns exact worktree and branch cleanup ordering. |

Validation rules:
- Brood and Herald registration failures are observable and best-effort unless the launching boundary makes them terminal.
- Steward loss or timeout becomes an evented or terminal diagnostic, not an indefinite wait.
- Cleanup references Feature 2 Brood/Castra contracts rather than restating their route tables.

### 5) Cross-Contract Boundary (`steward_cross_contract_boundary`)

Purpose: Records a dependency from the Steward role contract to a separately owned contract.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `consumerContract` | contract path | Yes | `docs/subsystems/steward/contract.md`. |
| `providerContract` | contract path | Yes | Spawn, Hatchery, Brood, Herald, Castra, or Legate contract path. |
| `relationship` | string | Yes | Output eligibility, launch host, lifecycle registry, event correlation, babysit observation, cleanup, or freshness ownership. |
| `ownershipRule` | string | Yes | States which side owns the public interface and which side only consumes it. |

Validation rules:
- Boundary references do not duplicate provider route tables, loop rules, or output-validation internals.
- Future freshness mappings can watch role prompt and consumer source paths rather than a nonexistent standalone Steward module.

## Relationships

- A Steward Contract contains one Steward Launch Envelope definition.
- A Steward Contract contains one Patch Application Contract.
- A Steward Contract contains one Steward Lifecycle Correlation definition.
- A Steward Contract contains many Cross-Contract Boundary entries.
- Steward consumes Spawn's validated-output eligibility and does not own raw output parsing.
- Steward is launched through Hatchery and hosted/removed through Castra.
- Steward is tracked by Brood and Herald for lifecycle, teardown, and slice/session correlation.
- Steward is observed or babysat by Legate through service state and events.

## State Transitions

### Steward contract lifecycle

1. `scaffolded` -> `authored`
   - Trigger: This feature writes the Steward-specific public interface, invariants, and error modes.
   - Effects: Steward becomes an explicit test target for launch eligibility, patch application, lifecycle correlation, and failure behavior.

2. `authored` -> `freshness_checked`
   - Trigger: A later checker maps Steward role prompt and consumer source paths to the contract.
   - Effects: Source changes that alter Steward role behavior can require contract updates.

### Steward session lifecycle

1. `eligible` -> `launched`
   - Trigger: A validated spawn output and launch envelope are handed to Castra through the Hatchery-managed path.
   - Effects: A steward session id exists and can be registered or published for observation.

2. `launched` -> `pr_ready`
   - Trigger: Steward applies the validated patch to the expected worktree and reports success.
   - Effects: The branch/index/worktree are ready for downstream PR integration.

3. `launched` -> `failed`
   - Trigger: Patch application, worktree validation, session execution, registration, timeout, or cleanup fails.
   - Effects: A bounded diagnostic is available and the autonomous flow does not wait for interactive input.

4. `launched` or `failed` or `pr_ready` -> `torndown`
   - Trigger: Brood/Castra teardown removes the interactive session and exact tracked artifacts according to their owning contracts.
   - Effects: The session is no longer live; cleanup evidence remains observable.

### AUTOGEN region lifecycle

1. `empty` -> `populated`
   - Trigger: A later extraction tool writes generated role prompt, command, or exported-surface content between the marker pair.
   - Effects: Human-authored contract prose remains stable outside the generated block.

## Identity & Uniqueness

- A Steward Contract is uniquely identified by `docs/subsystems/steward/contract.md`.
- A Steward Launch Envelope is uniquely identified by `(spawnId, sliceId, stewardSessionId)`.
- A Patch Application Contract is uniquely identified by `docs/subsystems/steward/contract.md`.
- A Steward Lifecycle Correlation is uniquely identified by `(spawnId, stewardSessionId)`.
- A Cross-Contract Boundary is uniquely identified by `(consumerContract, providerContract, relationship)`.
