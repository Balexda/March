# Contracts: TypeScript Public Interface AUTOGEN Extraction

## Overview

This feature defines a repository-local AUTOGEN extraction boundary. The command consumes contract ownership configuration, TypeScript source files, and Markdown contract artifacts. It produces deterministic generated public-interface blocks, check/write results, and bounded diagnostics. No live March service, container, agent session, runtime route, CI workflow, or Smithy-agent directive is introduced by this feature.

## Interfaces

### AUTOGEN Extraction Command

**Purpose**: Extracts configured TypeScript public surfaces and verifies or refreshes contract AUTOGEN regions.
**Consumers**: Operators, local development, CI, contract maintainers, later Smithy-agent enforcement.
**Providers**: A repository-local npm script and its underlying extractor module.

#### Signature

```text
npm run docs:contracts:autogen -- --check
npm run docs:contracts:autogen -- --write
```

The exact npm script name is provisional because the source Feature 7 prose is unavailable in this checkout. The stable interface contract is that callers use an npm-run command with explicit check and write modes, not an ad hoc live-service operation.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoRoot` | filesystem path | Yes | Repository root used to resolve contracts, configuration, and source paths. |
| `mode` | enum | Yes | `check` verifies generated regions; `write` refreshes valid stale regions. |
| `ownershipConfigPath` | repo-relative path | Yes | Populated contract-source ownership mapping consumed by freshness checks. |
| `contractPaths` | required contract set | Yes | Hatchery, Brood, Herald, Castra, Spawn, Legate, and Steward contract paths. |
| `sourceSelectors` | path selector list | Yes | Public TypeScript source selectors for each owner. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `status` | enum | `pass` or `fail`. |
| `summary` | stable text/object | Count of checked owners, extracted exports, stale contracts, updated contracts, and diagnostics. |
| `diagnostics` | diagnostic list | Bounded findings for config, ownership, parse, marker, stale-output, or write-safety failures. |
| `exitCode` | integer | `0` on pass, non-zero on any failed check. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unsupported config version | Non-zero result | Reports configuration path and supported version expectation. |
| Duplicate contract path | Non-zero result | Reports duplicate owners and contract path. |
| Overlapping source ownership | Non-zero result | Reports selector or source path and conflicting owners. |
| TypeScript parse failure | Non-zero result | Reports source path and bounded parse diagnostic. |
| Missing or invalid marker pair | Non-zero result | Reports contract path and marker failure category. |
| Stale generated block in check mode | Non-zero result | Reports owning contract path without editing files. |
| Write-safety failure | Non-zero result | Leaves contract unchanged and reports the bounded reason. |

### Public Export Summary Format

**Purpose**: Defines the generated content shape inserted into contract AUTOGEN regions.
**Consumers**: Contract readers, L2/L3 test authors, contract freshness checks, later Smithy-agent enforcement.
**Providers**: AUTOGEN extractor.

#### Signature

```text
<!-- BEGIN AUTOGEN -->
### Generated TypeScript Public Surface

- `<sourcePath>`: `<kind>` `<name>` - `<signature>`
<!-- END AUTOGEN -->
```

The concrete Markdown rendering can evolve during task slicing, but it must remain deterministic and must expose source path, export kind, export name, and signature-level shape.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `exports` | `PublicExportSummary[]` | Yes | Extracted public declarations for one owner. |
| `ownerName` | string | Yes | Contract owner name. |
| `contractPath` | repo-relative path | Yes | Target contract artifact. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `markdown` | string | Deterministic generated Markdown block content. |
| `digest` | string | Stable digest used to compare existing and expected content. |
| `exportCount` | integer | Number of exported declarations represented. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Empty export set | Valid generated block or warning | The owner can have no extracted exports only when configuration allows an empty or future surface. |
| Unsupported export syntax | Parse or extraction diagnostic | The source path and bounded unsupported-syntax reason are reported. |
| Nondeterministic ordering detected | Non-zero result | The extractor refuses output that cannot be made byte-stable. |

### Contract AUTOGEN Region Update

**Purpose**: Defines the safe replacement boundary inside subsystem contract artifacts.
**Consumers**: AUTOGEN command, contract maintainers, reviewers.
**Providers**: Contract artifacts that contain the marker pair.

#### Signature

```text
## Public Interface

<!-- BEGIN AUTOGEN -->
<generated content>
<!-- END AUTOGEN -->
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contractPath` | repo-relative path | Yes | Contract artifact to inspect. |
| `beginMarker` | literal marker | Yes | `<!-- BEGIN AUTOGEN -->`. |
| `endMarker` | literal marker | Yes | `<!-- END AUTOGEN -->`. |
| `generatedContent` | string | Yes | Replacement content for the marker-bounded block. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `unchanged` | boolean | Whether existing generated content already matched. |
| `updated` | boolean | Whether write mode replaced the generated region. |
| `changedLines` | integer | Count of generated-region lines changed, excluding marker lines. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Marker pair missing | Non-zero result | The command cannot identify a safe replacement target. |
| Marker pair outside `## Public Interface` | Non-zero result | Generated signatures would be detached from the documented public interface. |
| Multiple marker pairs | Non-zero result | Replacement target is ambiguous. |
| Unbalanced marker pair | Non-zero result | The command cannot safely preserve surrounding prose. |
| Write would change content outside markers | Non-zero result | The command refuses the write and reports contract path. |

## Events / Hooks

No runtime events or hooks are introduced by this feature. Later CI or Smithy-agent enforcement may invoke the same local command, but this feature does not add workflow files, daemon events, Herald events, or service callbacks.

## Integration Boundaries

- **Feature 1 contract scaffold**: Provides the required section schema and AUTOGEN marker convention consumed by the updater.
- **Feature 2, 3, and 4 contracts**: Provide the required M2 contract artifacts with empty AUTOGEN regions.
- **Feature 5 contract verdict mapping**: Provides populated source-to-contract ownership entries reused for extraction.
- **TypeScript source parser**: Supplies syntax-aware exported declaration extraction without matching source text by regular expression.
- **Git and filesystem**: The command consumes deterministic local file state and does not depend on live March services.
- **Future Feature 6 enforcement**: Smithy-agent or merge enforcement can consume the check mode later but is outside this feature.
