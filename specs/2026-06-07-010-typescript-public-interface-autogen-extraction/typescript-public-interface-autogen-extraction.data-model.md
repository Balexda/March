# Data Model: TypeScript Public Interface AUTOGEN Extraction

## Overview

This model supports deterministic extraction of public TypeScript source surfaces into generated Markdown blocks inside subsystem contract artifacts. It defines the extraction configuration view, exported declaration summaries, marker-bounded replacement blocks, command results, and diagnostics consumed by local checks, contract maintainers, CI, and later Smithy-agent enforcement.

## Entities

### 1) Extraction Config View (`extraction_config_view`)

Purpose: Represents the contract-source ownership entries consumed by AUTOGEN extraction.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | Yes | Supported config schema version. |
| `owners` | `ExtractionOwner[]` | Yes | Contract owners selected for extraction. |
| `source` | repo-relative path | Yes | Path to the ownership configuration used to build this view. |

Validation rules:
- `version` must be supported by the extractor.
- `owners` must include only repo-relative contract and source paths.
- Ownership must be non-overlapping for extraction inputs.

### 2) Extraction Owner (`extraction_owner`)

Purpose: Associates one contract artifact with the source selectors whose exported surface can populate its AUTOGEN region.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Stable subsystem or role owner name. |
| `contractPath` | repo-relative path | Yes | Target contract artifact. |
| `publicSourcePaths` | string[] | Yes | Non-empty source selectors used for extraction. |
| `notes` | string | No | Ownership context, including role-level Steward surfaces. |

Validation rules:
- `contractPath` must be unique across owners.
- `publicSourcePaths` must not overlap another owner.
- Steward ownership must not depend on a standalone `src/steward/` module.

### 3) Source Surface (`source_surface`)

Purpose: Represents the resolved TypeScript files for one owner.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `ownerName` | string | Yes | Owning extraction entry. |
| `contractPath` | repo-relative path | Yes | Contract receiving generated content. |
| `sourcePaths` | repo-relative path[] | Yes | Matched TypeScript files in deterministic order. |
| `empty` | boolean | Yes | Whether selectors matched no current files. |

Validation rules:
- Source paths must stay inside the repository root.
- Generated or dependency directories excluded by the test taxonomy must not be treated as public surfaces.
- Empty surfaces are allowed only when the owner configuration intentionally permits a future or role-level surface.

### 4) Public Export Summary (`public_export_summary`)

Purpose: Captures externally relevant TypeScript declaration information without implementation bodies.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Exported name or `default`. |
| `kind` | enum | Yes | Function, class, interface, type, const, enum, re-export, namespace, or default. |
| `sourcePath` | repo-relative path | Yes | Source file containing or forwarding the export. |
| `signature` | string | Yes | Deterministic signature-level representation. |
| `typeOnly` | boolean | Yes | Whether the export exists only at type level. |

Validation rules:
- Summaries must omit implementation bodies.
- Summaries must sort deterministically by source path, export kind, and name.
- Parse failures must produce diagnostics rather than partial summaries.

### 5) Generated Contract Block (`generated_contract_block`)

Purpose: Represents the Markdown content derived from one owner's export summaries.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `contractPath` | repo-relative path | Yes | Contract artifact to check or update. |
| `beginMarkerLine` | integer | Yes | One-based line of `<!-- BEGIN AUTOGEN -->`. |
| `endMarkerLine` | integer | Yes | One-based line of `<!-- END AUTOGEN -->`. |
| `content` | string | Yes | Deterministic generated Markdown between markers. |
| `digest` | string | Yes | Stable digest of generated content. |

Validation rules:
- The marker pair must be unique.
- The marker pair must live inside `## Public Interface`.
- Replacement must preserve content outside the marker pair byte-for-byte.

### 6) Autogen Command Result (`autogen_command_result`)

Purpose: Captures the pass/fail result of check or write mode.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `mode` | enum | Yes | `check` or `write`. |
| `status` | enum | Yes | `pass` or `fail`. |
| `checkedContracts` | integer | Yes | Number of contract owners evaluated. |
| `staleContracts` | repo-relative path[] | Yes | Contracts whose generated block did not match extracted output. |
| `updatedContracts` | repo-relative path[] | Yes | Contracts written in write mode. |
| `diagnostics` | `AutogenDiagnostic[]` | Yes | Bounded findings. |

Validation rules:
- Check mode must not modify files.
- Write mode must update only valid stale generated blocks.
- Any diagnostic with error severity makes the result fail.

### 7) Autogen Diagnostic (`autogen_diagnostic`)

Purpose: Provides bounded machine-readable or stable-text failure information.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `category` | enum | Yes | Parse, ownership, marker, stale-output, write-safety, or config. |
| `severity` | enum | Yes | Error or warning. |
| `ownerName` | string | No | Owning contract entry when known. |
| `contractPath` | repo-relative path | No | Related contract path. |
| `sourcePath` | repo-relative path | No | Related source path. |
| `message` | string | Yes | Bounded diagnostic text. |

Validation rules:
- Diagnostics must not include unbounded source content or full file dumps.
- Paths must be repo-relative when they refer to repository files.

## Relationships

- Extraction Config View 1:N Extraction Owner via `owners`.
- Extraction Owner 1:N Source Surface via `publicSourcePaths`.
- Source Surface 1:N Public Export Summary via `sourcePaths`.
- Extraction Owner 1:1 Generated Contract Block via `contractPath`.
- Autogen Command Result 1:N Autogen Diagnostic via `diagnostics`.

## State Transitions

### AUTOGEN command lifecycle

1. `configured` -> `extracted`
   - Trigger: The command validates ownership entries and parses source surfaces.
   - Effects: Public export summaries are available or diagnostics are recorded.

2. `extracted` -> `checked`
   - Trigger: The command compares generated blocks with existing AUTOGEN regions.
   - Effects: Matching contracts pass; stale or invalid contracts produce diagnostics.

3. `checked` -> `written`
   - Trigger: Write mode runs with valid marker regions and stale generated content.
   - Effects: Only marker-bounded generated blocks are replaced.

4. `configured` -> `failed`
   - Trigger: Config, parse, ownership, marker, or write-safety validation fails.
   - Effects: The command exits non-zero with bounded diagnostics and no partial unsafe writes.

## Identity & Uniqueness

- Extraction owners are uniquely identified by `name`.
- Contract targets are uniquely identified by `contractPath`.
- Source ownership is unique by resolved source path.
- Public export summaries are uniquely identified within an owner by `sourcePath`, `kind`, and `name`.
- Generated block identity is the pair of `contractPath` and marker region.
