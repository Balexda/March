# Contracts: Contract Presence and Freshness Verdict

## Overview

This feature defines a repository-local verdict boundary for subsystem contracts. The command consumes Markdown contract artifacts, the populated freshness configuration, and deterministic changed-file input. It produces pass/fail results with bounded diagnostics. No live March service, container, agent session, runtime route, CI workflow, Smithy-agent directive, or AUTOGEN extraction behavior is introduced by this feature.

## Interfaces

### Contract Verdict Command

**Purpose**: Validates required contract presence, required section schema, freshness config correctness, and source/contract freshness drift.
**Consumers**: Operators, local development, CI, later Smithy-agent enforcement, L2/L3 test authors.
**Providers**: A repository-local npm script and its underlying checker module.

#### Signature

```text
npm run <contract-verdict-script> [-- optional changed-file input or diff-base options]
```

The final script name is selected during implementation slicing. The interface contract is that callers use `npm run`, not an ad hoc binary invocation.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoRoot` | filesystem path | Yes | Repository root used to resolve contracts, config, and source paths. |
| `contractPaths` | required contract set | Yes | Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward contract paths. |
| `freshnessConfigPath` | repo-relative path | Yes | `docs/subsystems/contract-freshness.config.json`. |
| `changedFiles` | repo-relative path list | Conditional | Explicit freshness input. Required when not deriving paths from git. |
| `diffBase` | git ref | Conditional | Base ref for git-derived changed-file input. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `pass` or `fail`. |
| `summary` | stable text/object | Count of checked contracts, config entries, changed paths, and failed diagnostics. |
| `diagnostics` | diagnostic list | Bounded findings for presence, section schema, config, or freshness failures. |
| `exitCode` | integer | `0` on pass, non-zero on any failed check. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing contract | Non-zero verdict | Reports the required repo-relative contract path. |
| Missing or duplicate required H2 section | Non-zero verdict | Reports contract path and heading name. |
| Missing or malformed freshness config | Non-zero verdict | Reports config path and failing field. |
| Duplicate contract mapping | Non-zero verdict | Reports duplicate contract path and entry names. |
| Overlapping source ownership | Non-zero verdict | Reports selector and owning entries. |
| Source drift | Non-zero verdict | Reports source path, owning contract path, and owner name. |
| Unavailable git base | Non-zero verdict or explicit-input fallback | Fails cleanly unless the caller provides changed files directly. |

### Contract Freshness Configuration

**Purpose**: Defines the populated source-to-contract ownership map consumed by the verdict command.
**Consumers**: Contract verdict command, reviewers, later Smithy-agent enforcement.
**Providers**: `docs/subsystems/contract-freshness.config.json`.

#### Signature

```json
{
  "version": 1,
  "contracts": [
    {
      "name": "hatchery",
      "contractPath": "docs/subsystems/hatchery/contract.md",
      "publicSourcePaths": ["src/hatchery/**"],
      "notes": "optional ownership note"
    }
  ]
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `version` | integer | Yes | Checker-supported schema version. |
| `contracts[].name` | string | Yes | Required contract owner. |
| `contracts[].contractPath` | repo-relative path | Yes | Contract artifact path. |
| `contracts[].publicSourcePaths` | path selector list | Yes | Non-empty selectors for the owner's public source surface. |
| `contracts[].notes` | string | No | Ownership context for role-level or cross-subsystem boundaries. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `validatedEntries` | freshness entries | Entries accepted for drift checking. |
| `ownershipMap` | selector map | Deterministic mapping from source selectors to contract paths. |
| `configDiagnostics` | diagnostic list | Validation findings for malformed or overlapping config. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown `version` | Config failure | Checker refuses ambiguous schema behavior. |
| Missing required contract entry | Config failure | A required M2 contract cannot be checked for freshness. |
| Empty `publicSourcePaths` | Config failure | A contract has no source surface to watch. |
| Selector escapes repo root | Config failure | Path ownership cannot refer outside the repository. |
| Steward maps to `src/steward/` only | Config failure | Steward is a role-level Castra/Hatchery consumer, not a standalone module. |

## Events / Hooks

No runtime events or hooks are introduced by this feature. Later CI or Smithy-agent enforcement may call the same local command, but this feature does not add workflow files, daemon events, Herald events, or service callbacks.

## Integration Boundaries

- **Feature 1 contract scaffold**: Provides the required section schema and config shape consumed here.
- **Feature 2 contracts**: Hatchery, Brood, Herald, and Castra contract artifacts are required inputs to presence and freshness checks.
- **Feature 3 contracts**: Spawn and Legate contract artifacts are required inputs to presence and freshness checks.
- **Feature 4 Steward contract**: Steward is included as a role-level contract with freshness selectors bound to role-consumer surfaces.
- **Git and filesystem**: The verdict command consumes deterministic local file state and changed-file inputs. It does not depend on live March services.
- **Future Feature 6 enforcement**: Smithy-agent or merge enforcement can consume this verdict later but is outside this feature.
- **Future Feature 7 AUTOGEN extraction**: Generated public-interface content may be checked by the same contract artifacts later, but extraction and replacement are outside this feature.
