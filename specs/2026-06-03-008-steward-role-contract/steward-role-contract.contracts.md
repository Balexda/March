# Contracts: Steward Role Contract

## Overview

This feature creates a documentation contract for the Steward role: the Castra-hosted manager session that consumes validated spawn output, applies the patch in the expected worktree, and reports a PR-ready or failed outcome. The integration boundary is the Markdown contract artifact and the role semantics it must document. No runtime API, route, command, prompt, or PR-creation behavior is introduced or changed by this feature.

## Interfaces

### Steward Contract Artifact

**Purpose**: Documents Steward launch eligibility, role inputs, patch application, lifecycle tracking, cleanup boundaries, PR-ready outcomes, and externally visible failures.
**Consumers**: Hatchery handoff, Castra session hosting, Brood lifecycle tracking, Herald event projection, Legate babysit logic, Spawn output extraction, PR integration, L2/L3 tests, contract freshness checks.
**Providers**: `docs/subsystems/steward/contract.md`.

#### Signature

```text
docs/subsystems/steward/contract.md
  ## Public Interface
    <!-- BEGIN AUTOGEN -->
    <!-- END AUTOGEN -->
  ## Invariants
  ## Error Modes
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `validatedPatch` | patch payload | Yes | Spawn output that has already passed validation and is eligible for application. |
| `worktreePath` | absolute path | Yes | Expected worktree where the patch is applied. |
| `branch` | git ref | Yes | Branch associated with the spawn/steward handoff. |
| `spawnId` | string | Yes | Parent spawn identity used for lifecycle and cleanup correlation. |
| `sliceId` | string | Yes | Slice identity used for Herald, Legate, and trace correlation. |
| `profile` | string | Yes | Profile or group used to launch the interactive session through Castra. |
| `stewardSessionId` | string | Yes after launch | Castra/agent-deck session identity for the manager role. |
| `rolePromptContext` | prompt metadata | Yes | Instructions that constrain acceptance, patch application, reporting, and no-interactive-block behavior. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `launchEligibility` | boolean/rule | Whether the validated output and repository context permit launching a Steward session. |
| `applicationOutcome` | state | Patch-applied, PR-ready, failed, or unavailable outcome for the Steward role. |
| `worktreeState` | git/index state | Observable branch, worktree, and index state after patch application or failure. |
| `lifecycleCorrelation` | id metadata | Brood, Herald, Castra, Spawn, and Legate facts linking the steward to its parent spawn/slice. |
| `diagnostic` | bounded text/event | Externally visible explanation for launch, application, session, registration, timeout, or cleanup failure. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Invalid spawn output | No Steward launch | Failed, malformed, missing, ambiguous, unsafe, or no-op output is rejected before the role starts. |
| Missing or mismatched worktree | Failed handoff diagnostic | Steward does not report success against an absent or wrong checkout. |
| Dirty or incoherent index/worktree | Failed handoff diagnostic | Steward fails closed unless the expected patch can be applied to a coherent target state. |
| Patch apply conflict | Failed application diagnostic | Conflicts or rejected hunks produce a bounded diagnostic instead of an interactive prompt. |
| Castra launch or session loss | Evented or terminal failure | Hosted-session failure is observable through the owning service/state boundaries. |
| Brood or Herald registration failure | Observable best-effort diagnostic | Registration/publish failures are visible and do not silently erase the spawn/steward correlation. |
| Timeout or stalled role | Evented relaunch or terminal failure decision | Consumers can act on bounded state rather than waiting indefinitely. |
| Cleanup failure | Diagnostic plus retained lifecycle evidence | Cleanup issues remain observable and defer exact artifact removal where owning contracts require it. |

### Steward Cross-Contract Ownership References

**Purpose**: Defines how the Steward role contract refers to other subsystem contracts without re-authoring their public interfaces.
**Consumers**: Contract authors, reviewers, future freshness checks, L2/L3 test authors.
**Providers**: `docs/subsystems/steward/contract.md`.

#### Signature

```text
steward contract -> provider contract: relationship and ownership rule
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `consumerContract` | contract path | Yes | `docs/subsystems/steward/contract.md`. |
| `providerContract` | contract path | Yes | Spawn, Hatchery, Brood, Herald, Castra, or Legate contract path. |
| `relationship` | string | Yes | Output eligibility, launch host, registry, event correlation, babysit observation, cleanup, or freshness ownership. |
| `ownershipRule` | statement | Yes | Identifies which contract owns the provider surface. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `boundaryReference` | prose/table entry | A named relationship that later tests and freshness checks can follow. |
| `nonDuplicationRule` | prose constraint | A guarantee that provider route, loop, or validation details remain in the provider contract. |
| `freshnessBindingHint` | path/role description | The role-prompt and consumer surfaces later freshness checks should watch for Steward drift. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Provider route details duplicated | Review or freshness finding | The contract starts owning another subsystem's public interface. |
| Spawn validation re-authored | Review finding | The contract duplicates raw-output parsing or validation instead of consuming validated output eligibility. |
| Steward omitted from freshness mapping | Coverage gap | Future checks cannot locate the role owner because there is no standalone `src/steward/` module. |

## Events / Hooks

No new runtime events or hooks are introduced by this feature. The Steward contract documents the existing or intended observable lifecycle around a Castra-hosted session, including Brood steward rows and Herald `slice.steward.attached` correlation, but this feature does not add event types or service routes.

## Integration Boundaries

- **Steward -> Spawn**: Steward consumes validated output and handoff eligibility; Spawn owns raw backend output parsing, validation, and failed-output gating.
- **Steward -> Hatchery**: Hatchery owns launching the handoff path and passing the role prompt/session context; Steward owns the role semantics once launched.
- **Steward -> Castra**: Castra owns the HTTP session API and agent-deck hosting/removal; Steward owns what the hosted manager role is allowed to do and report.
- **Steward -> Brood**: Brood owns lifecycle registry, parent/child session records, and exact teardown ordering; Steward owns whether its role outcome is PR-ready or failed.
- **Steward -> Herald**: Herald owns event append/projection semantics; Steward-related events carry correlation facts and outcomes for observers.
- **Steward -> Legate**: Legate owns loop observation, babysit, relaunch, and terminal decisions; Steward owns the session outcome facts Legate observes.
- **Future F5/F6/F7 tooling**: Presence checks, freshness checks, Smithy-agent enforcement, and AUTOGEN extraction consume this contract artifact but are outside this feature.
