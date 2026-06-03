# Data Model: Spawn and Legate Contracts

## Overview

This model supports documentation-only contracts for the Spawn and Legate subsystems. It captures contract artifacts, public surfaces, lifecycle promises, loop-state promises, cross-contract ownership boundaries, and AUTOGEN placeholders that later L2/L3 tests, presence checks, and freshness checks consume.

## Entities

### 1) Runtime Contract (`docs/subsystems/<name>/contract.md`)

Purpose: Represents one explicit contract artifact for a runtime subsystem whose public behavior is broader than a single HTTP service.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | One of `docs/subsystems/spawn/contract.md` or `docs/subsystems/legate/contract.md`. |
| `subsystem` | enum | Yes | `spawn` or `legate`. |
| `publicInterfaceSection` | markdown H2 section | Yes | Documents externally consumed command, process, lifecycle, event, and handoff surfaces. |
| `invariantsSection` | markdown H2 section | Yes | Documents assertable lifecycle or loop promises. |
| `errorModesSection` | markdown H2 section | Yes | Documents observable failure conditions and outcomes. |
| `autogenRegion` | marker pair | Yes | Empty `<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` pair inside `## Public Interface`. |

Validation rules:
- The contract has exactly one `## Public Interface`, `## Invariants`, and `## Error Modes` section.
- The AUTOGEN marker pair is present but empty in this feature.
- Invariants and error modes are written as observable, testable claims.
- Cross-contract references identify owning subsystem contracts rather than restating their route or role details.

### 2) Spawn Lifecycle Contract (`spawn_lifecycle_contract`)

Purpose: Captures the Spawn-owned execution promises that tests can assert without depending on internal helper layout.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `acceptedInputs` | field list | Yes | Prompt, repository context, backend, profile, branch, task identity, and slice correlation metadata. |
| `lifecycleStates` | state list | Yes | Observable progression from accepted work to terminal success or failure. |
| `terminalOutputRule` | rule | Yes | Output extraction consumes only terminal successful spawn output. |
| `handoffEligibilityRule` | rule | Yes | Steward handoff is allowed only after validated non-empty in-worktree patch output. |
| `cleanupBoundary` | rule list | Yes | Cleanup ownership and failure reporting promises visible to callers. |

Validation rules:
- Dispatch inputs distinguish required execution fields from optional metadata.
- Terminal output and handoff rules fail closed for malformed, missing, unsafe, failed, or no-op output.
- Cleanup rules name observable outcomes without depending on an interactive operator prompt.

### 3) Legate Loop Contract (`legate_loop_contract`)

Purpose: Captures the Legate-owned autonomous loop promises around sensing, dispatching, babysitting, and terminal decisions.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `commandSurface` | command/process description | Yes | The operator-visible way Legate is started and configured. |
| `serviceDependencies` | dependency list | Yes | Herald, Hatchery, Brood, Castra, and local repo/tooling dependencies observed by the loop. |
| `cursorPolicy` | rule | Yes | Herald event cursor ownership, replay, and delta behavior. |
| `sliceStateModel` | state list | Yes | Runnable, running, attached, failed, merged, skipped, stale, or terminal slice outcomes as documented by the contract. |
| `dispatchPolicy` | rule | Yes | Hatchery spawn request metadata and deterministic trace relationship for selected slices. |
| `babysitPolicy` | rule | Yes | Timeout, relaunch, steward loss, and clean terminal failure behavior. |

Validation rules:
- Cursor behavior is deterministic across service restarts and replay.
- Dispatch and babysit actions do not require interactive input inside autonomous components.
- Terminal outcomes are justified by events or service state rather than by reading terminal logs.

### 4) Cross-Contract Boundary (`cross_contract_boundary`)

Purpose: Records a dependency from Spawn or Legate to a separately owned contract.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `consumerContract` | contract path | Yes | Spawn or Legate contract path. |
| `providerContract` | contract path or future path | Yes | Hatchery, Brood, Herald, Castra, or Steward contract path. |
| `relationship` | string | Yes | Dispatch, lifecycle, event observation, session hosting, handoff, cleanup, or freshness ownership. |
| `ownershipRule` | string | Yes | States which side owns the public interface and which side only consumes it. |

Validation rules:
- A boundary reference does not duplicate the provider contract's route table or role interface.
- Future freshness mappings can use the relationship to associate source changes with the right contract artifact.

## Relationships

- A Runtime Contract contains zero or one Spawn Lifecycle Contract when `subsystem = spawn`.
- A Runtime Contract contains zero or one Legate Loop Contract when `subsystem = legate`.
- A Runtime Contract contains many Cross-Contract Boundary entries.
- Spawn depends on Hatchery for submitted work, Brood for lifecycle authority, Castra for hosted sessions through Hatchery-managed handoff, and Steward for downstream patch application after validation.
- Legate depends on Herald for events/projection, Hatchery for dispatch, Brood for lifecycle state, Castra for steward/session observation, and Steward for post-spawn integration outcomes.

## State Transitions

### Spawn contract lifecycle

1. `scaffolded` -> `authored`
   - Trigger: This feature writes the Spawn-specific public interface, invariants, and error modes.
   - Effects: Spawn becomes an explicit test target for dispatch lifecycle, output eligibility, and failure behavior.

2. `authored` -> `freshness_checked`
   - Trigger: A later checker maps Spawn public-source paths to the contract.
   - Effects: Source changes that alter public behavior can require contract updates.

### Legate contract lifecycle

1. `scaffolded` -> `authored`
   - Trigger: This feature writes the Legate-specific public interface, invariants, and error modes.
   - Effects: Legate becomes an explicit test target for loop sensing, dispatch, babysit, and terminal-state behavior.

2. `authored` -> `freshness_checked`
   - Trigger: A later checker maps Legate public-source paths to the contract.
   - Effects: Loop behavior changes can be checked against the contract artifact.

### AUTOGEN region lifecycle

1. `empty` -> `populated`
   - Trigger: A later extraction tool writes generated command or exported-signature content between the marker pair.
   - Effects: Human-authored contract prose remains stable outside the generated block.

## Identity & Uniqueness

- A Runtime Contract is uniquely identified by its repo-relative contract path.
- A Spawn Lifecycle Contract is uniquely identified by `docs/subsystems/spawn/contract.md`.
- A Legate Loop Contract is uniquely identified by `docs/subsystems/legate/contract.md`.
- A Cross-Contract Boundary is uniquely identified by `(consumerContract, providerContract, relationship)`.
