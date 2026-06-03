# Contracts: Spawn and Legate Contracts

## Overview

This feature creates documentation contracts for two March runtime subsystems that are not covered by the containerized-service HTTP contracts: Spawn and Legate. The integration boundaries are the Markdown contract artifacts, the lifecycle and loop surfaces those artifacts must document, and their references to separately owned service and Steward contracts. No runtime API is introduced or changed by this feature.

## Interfaces

### Spawn Contract Artifact

**Purpose**: Documents Spawn's dispatch lifecycle, terminal output, validation-gated handoff, cleanup boundary, and externally visible failures.
**Consumers**: Hatchery manager flow, Brood lifecycle tracking, output extraction, Steward handoff, L2/L3 tests, contract freshness checks.
**Providers**: `docs/subsystems/spawn/contract.md`.

#### Signature

```text
docs/subsystems/spawn/contract.md
  ## Public Interface
    <!-- BEGIN AUTOGEN -->
    <!-- END AUTOGEN -->
  ## Invariants
  ## Error Modes
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Work instruction handed to the selected backend. |
| `repoContext` | path/ref metadata | Yes | Repository path, base ref or branch, and worktree context for execution. |
| `backend` | backend name | Yes | Selected backend recorded for launch and output parsing. |
| `profile` | profile name | No | Execution profile metadata resolved outside the Spawn contract. |
| `taskIdentity` | string map | No | Task type, task name, title, and slice id metadata used for trace and lifecycle correlation. |
| `validatedOutput` | extraction result | Conditional | Required before downstream Steward handoff; absent or failed output blocks handoff. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `lifecycleState` | state | Observable state from accepted work to terminal success or failure. |
| `spawnIdentity` | id metadata | Stable identity used for container, worktree, branch, lifecycle, and trace correlation. |
| `terminalOutput` | backend output envelope | Output source eligible for extraction only after terminal successful execution. |
| `handoffEligibility` | boolean/rule | Whether validated output can be handed to Steward without re-parsing raw backend logs. |
| `diagnostic` | bounded text | Externally visible failure reason suitable for operator display and test assertions. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing required input | Clean failed dispatch diagnostic | Spawn work is not accepted without the required prompt, repository context, and backend. |
| Dependency unavailable | Clean failed dispatch diagnostic | Missing git, Docker, backend credential, service, or profile dependency fails before unbounded work starts. |
| Launch or execution failure | Terminal failed lifecycle state | The failure is recorded and cleanup is attempted according to the owning lifecycle contract. |
| Timeout | Terminal failed lifecycle state | Long-running work is bounded and converted into an observable failure. |
| Output capture or validation failure | No Steward handoff | Malformed, missing, ambiguous, unsafe, failed, or no-op output stops at diagnostics. |
| Cleanup failure | Diagnostic plus retained lifecycle evidence | Cleanup failure is visible and does not block forever on input the autonomous component cannot receive. |

### Legate Contract Artifact

**Purpose**: Documents Legate's autonomous loop surface: sensing state, dispatching slices, observing events, babysitting workers and stewards, and producing terminal outcomes.
**Consumers**: Operators, Hatchery, Herald, Brood, Castra, Steward integration, L2/L3 tests, contract freshness checks.
**Providers**: `docs/subsystems/legate/contract.md`.

#### Signature

```text
docs/subsystems/legate/contract.md
  ## Public Interface
    <!-- BEGIN AUTOGEN -->
    <!-- END AUTOGEN -->
  ## Invariants
  ## Error Modes
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoPath` | path | Yes | Repository whose Smithy artifacts and slice state are managed. |
| `profile` | string | Yes | Execution profile or manager group used to select service context. |
| `heraldCursor` | non-negative integer | Yes | Event cursor used to drain and replay Herald state deterministically. |
| `sliceState` | projection | Yes | Current planned, running, attached, terminal, or blocked slice state. |
| `serviceReadiness` | readiness projection | Yes | Hatchery, Herald, Brood, and Castra availability as observed by Legate. |
| `stewardAttachment` | session metadata | No | Castra/Herald-provided steward session state attached to a slice. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `dispatchRequest` | Hatchery request metadata | Spawn request for a selected runnable slice, including task and trace correlation. |
| `eventCursor` | integer | Persisted or carried cursor after draining Herald events. |
| `sliceDecision` | decision | Dispatch, wait, relaunch, mark terminal, cleanup, or no-op. |
| `terminalOutcome` | status | Merged, failed, skipped, stale, or other terminal label that stops autonomous action. |
| `traceRelationship` | deterministic trace metadata | Slice-scoped trace relationship where service-side spans nest below Legate dispatch. |
| `diagnostic` | bounded text/event | Observable explanation for a failed or stalled loop action. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Required service not ready | No dispatch plus diagnostic | Legate does not submit new work when required service dependencies are unavailable. |
| Invalid or inconsistent event stream | Diagnostic and bounded retry/failure behavior | Cursor gaps, invalid events, or contradictory projection state are surfaced instead of silently corrupting slice state. |
| Hatchery dispatch failure | Failed or waiting slice decision | Dispatch failure is recorded through observable state and does not require terminal interaction. |
| Worker or steward lost | Relaunch or terminal failure decision | Babysit behavior converts missing sessions into clean actions or failures. |
| Timeout | Terminal failure or relaunch event | Stalled work does not hang indefinitely. |
| Cleanup failure | Diagnostic/event | Cleanup issues remain observable and do not hide the slice's prior terminal state. |

### Cross-Contract Ownership References

**Purpose**: Defines how the Spawn and Legate contracts refer to other subsystem contracts without re-authoring their public interfaces.
**Consumers**: Contract authors, reviewers, future freshness checks, L2/L3 test authors.
**Providers**: `docs/subsystems/spawn/contract.md` and `docs/subsystems/legate/contract.md`.

#### Signature

```text
consumer contract -> provider contract: relationship and ownership rule
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `consumerContract` | contract path | Yes | Spawn or Legate contract path. |
| `providerContract` | contract path | Yes | Hatchery, Brood, Herald, Castra, or future Steward contract path. |
| `relationship` | string | Yes | Dispatch, lifecycle state, event observation, session hosting, handoff, or cleanup. |
| `ownershipRule` | statement | Yes | Identifies which contract owns the provider surface. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `boundaryReference` | prose/table entry | A named relationship that later tests and freshness checks can follow. |
| `nonDuplicationRule` | prose constraint | A guarantee that provider route or role details remain in the provider contract. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Provider route details duplicated | Review or freshness finding | The contract starts owning another subsystem's public interface. |
| Steward role preempted | Review finding | Feature 3 improperly documents Feature 4's Steward-specific contract. |
| Boundary omitted | Coverage gap | Future tests cannot locate the owner of a cross-subsystem promise. |

## Events / Hooks

No new runtime events or hooks are introduced by this feature. The Legate contract documents its consumption of Herald events and its expected publication of dispatch, relaunch, terminal, or cleanup observations where those events already exist, but this feature does not add event types.

## Integration Boundaries

- **Spawn -> Hatchery**: Hatchery may submit or manage spawn work; the Hatchery HTTP route surface remains owned by the Hatchery contract.
- **Spawn -> Brood**: Brood is the lifecycle authority for managed sessions and cleanup state; the Spawn contract documents only the Spawn-side lifecycle promises.
- **Spawn -> Steward**: Spawn exposes validated handoff eligibility; the Steward role interface remains Feature 4 scope.
- **Legate -> Herald**: Legate consumes event logs and projections; Herald route and cursor semantics remain owned by the Herald contract.
- **Legate -> Hatchery**: Legate dispatches runnable slices through Hatchery; the request route remains owned by the Hatchery contract.
- **Legate -> Brood/Castra**: Legate observes lifecycle and steward/session state through those services; their HTTP APIs remain owned by their Feature 2 contracts.
- **Future F5/F6/F7 tooling**: Presence checks, freshness checks, Smithy-agent enforcement, and AUTOGEN extraction consume these contract artifacts but are outside this feature.
