# Contracts: Contract Scaffold & Required-Section Schema

## Overview

This feature introduces documentation contracts rather than runtime APIs. The relevant boundaries are the Markdown contract artifact shape, the AUTOGEN marker convention consumed by a future extraction tool, and the freshness configuration schema shape consumed by a future local verdict command and Smithy-agent directive.

## Interfaces

### Subsystem Contract Document Shape

**Purpose**: Defines the minimum Markdown structure every subsystem contract must expose.
**Consumers**: Contract authors, M2 authoring features, future presence checks, L2/L3 test authors.
**Providers**: The shared scaffold and each later subsystem contract artifact.

#### Signature

```text
docs/subsystems/<name>/contract.md
  # Contract: <Subsystem or Role>
  ## Public Interface
  ## Invariants
  ## Error Modes
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | subsystem or role slug | Yes | Directory segment naming the contract owner. |
| `publicInterface` | markdown section | Yes | Externally consumed route, type, command, role, or protocol surface. |
| `invariants` | markdown section | Yes | Assertable promises the subsystem maintains. |
| `errorModes` | markdown section | Yes | Observable failure conditions and outcomes. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `contractPath` | repo-relative path | Canonical path to the contract artifact. |
| `requiredSections` | markdown headings | The three required H2 sections present in the artifact. |
| `assertableContract` | prose constraints | Invariants and error modes suitable for test derivation. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing required section | Presence check failure in F5 | A later checker can reject artifacts without all three headings. |
| Non-assertable invariant or error mode | Review finding | The artifact does not yet provide useful test targets. |
| Contract stored outside the convention | Freshness mapping ambiguity | Later tooling cannot reliably map source changes to contract updates. |

### Public-Interface Autogen Region

**Purpose**: Defines the generated-content boundary inside `## Public Interface`.
**Consumers**: Future TypeScript public-interface extraction tool, contract authors, reviewers.
**Providers**: Contracts that reserve generated exported-signature content.

#### Signature

```text
## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `beginMarker` | literal marker | Yes | Starts the generated region. |
| `endMarker` | literal marker | Yes | Ends the generated region. |
| `ownerSection` | markdown heading | Yes | The containing section, always `## Public Interface`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `replaceableRegion` | markdown block | The only content block intended for automated replacement. |
| `stableHumanProse` | markdown content | Human-authored prose outside the marker pair. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Marker pair is unbalanced | Extraction failure in F7 | A future tool cannot safely replace generated content. |
| Markers appear outside `## Public Interface` | Presence or extraction failure | Generated signatures would be disconnected from the documented interface surface. |
| Multiple marker pairs appear in one contract | Review finding unless later specs expand the schema | The replacement target is ambiguous. |

### Contract Freshness Configuration Shape

**Purpose**: Defines the JSON structure that later maps source changes to required contract updates.
**Consumers**: Future local freshness checker, future Smithy-agent enforcement directive, reviewers.
**Providers**: `docs/subsystems/contract-freshness.config.json` when F5 populates it.

#### Signature

```json
{
  "version": 1,
  "contracts": [
    {
      "name": "subsystem-or-role",
      "contractPath": "docs/subsystems/<name>/contract.md",
      "publicSourcePaths": [],
      "notes": "optional ownership note"
    }
  ]
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `version` | integer | Yes | Schema version for deterministic checker behavior. |
| `contracts` | array | Yes | Contract entries. |
| `contracts[].name` | string | Yes | Stable subsystem or role name. |
| `contracts[].contractPath` | repo-relative path | Yes | Contract artifact path. |
| `contracts[].publicSourcePaths` | array | Yes | Source path selectors that F5 will populate. |
| `contracts[].notes` | string | No | Ownership context, including Steward's Castra-consumer binding. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `freshnessMapping` | data shape | A deterministic relationship between public source paths and contract artifacts. |
| `stewardBinding` | ownership note | An explicit representation of Steward as a Castra-consumer surface. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Entry missing `contractPath` | Config validation failure in F5 | The checker cannot identify the contract that must be updated. |
| Entry missing `publicSourcePaths` | Config validation failure in F5 | The checker cannot identify watched source changes. |
| Steward omitted from the mapping | Contract coverage gap | The Spawn-to-Steward handoff loses a documented test target. |

## Events / Hooks

No runtime events or hooks are introduced by this feature. Later freshness enforcement may report verdicts, but that is outside this slice.

## Integration Boundaries

- **Testing strategy and RFC**: The scaffold implements the explicit-contract artifact requirement from the layered testing RFC and its companion strategy.
- **Future M2 authoring features**: F2, F3, and F4 consume the section schema and marker convention when they author subsystem-specific contracts.
- **Future F5/F6 tooling**: The presence checker, freshness checker, and Smithy-agent directive consume the required headings and config shape.
- **Future F7 extraction**: The TypeScript public-interface extraction tool consumes the AUTOGEN marker convention.
