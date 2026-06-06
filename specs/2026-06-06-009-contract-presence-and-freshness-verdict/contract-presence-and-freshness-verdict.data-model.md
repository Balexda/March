# Data Model: Contract Presence and Freshness Verdict

## Overview

This model supports deterministic local contract verdict tooling for the subsystem contract documentation track. It defines the required contract set, populated freshness configuration, changed-file inputs, and bounded verdict diagnostics consumed by local checks, CI, and later Smithy-agent enforcement.

## Entities

### 1) Required Contract (`required_contract`)

Purpose: Represents one subsystem or role contract artifact that must exist and follow the required section schema.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | enum | Yes | One of `hatchery`, `brood`, `herald`, `castra`, `spawn`, `legate`, or `steward`. |
| `contractPath` | repo-relative path | Yes | `docs/subsystems/<name>/contract.md`. |
| `requiredSections` | heading list | Yes | `## Public Interface`, `## Invariants`, `## Error Modes`. |
| `sourceFeature` | reference | Yes | M2 Feature 2, 3, or 4 depending on which feature authored the contract. |

Validation rules:
- `contractPath` exists for every Required Contract.
- Each required section appears exactly once as an H2 heading.
- Heading validation ignores code blocks, prose mentions, and nested headings.
- The Required Contract set contains exactly the seven M2 contract owners.

### 2) Contract Freshness Config (`docs/subsystems/contract-freshness.config.json`)

Purpose: Maps public source selectors to the contract artifacts that must be reviewed when those sources change.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | Yes | Starts at `1`. |
| `contracts` | `FreshnessEntry[]` | Yes | One entry per required contract. |

Validation rules:
- `version` is supported by the checker.
- `contracts` contains one entry for each Required Contract.
- No two entries use the same `contractPath`.
- Source selector ownership is non-overlapping.

### 3) Freshness Entry (`freshness_entry`)

Purpose: Represents one config row that binds a contract to its public source selectors.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | enum | Yes | Matches a Required Contract name. |
| `contractPath` | repo-relative path | Yes | Must match the Required Contract path. |
| `publicSourcePaths` | path selector list | Yes | Non-empty selectors for the subsystem or role public surface. |
| `notes` | string | No | Ownership context, especially Steward's role-consumer binding. |

Validation rules:
- Selectors are repo-relative and cannot escape the repository root.
- Generated dependency directories such as `.git/`, `dist/`, and `node_modules/` are not valid public-source ownership roots.
- Steward maps to Castra/Hatchery role-consumer surfaces rather than `src/steward/`.
- A selector may be role-level or future-facing, but it must be explicit and owned by only one entry.

### 4) Changed File Set (`changed_file_set`)

Purpose: Provides deterministic freshness input independent of live services.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `paths` | repo-relative path list | Yes | Files changed in the current check scope. |
| `source` | enum | Yes | Git diff, explicit file list, or test fixture. |
| `baseRef` | git ref | Conditional | Required when the source is a git diff base. |

Validation rules:
- Paths are normalized to repo-relative form.
- Paths outside the repository root are rejected.
- Deleted and renamed paths remain checkable as changed paths.
- If the git diff base is unavailable, the command fails cleanly or uses an explicit changed-file input.

### 5) Contract Verdict (`contract_verdict`)

Purpose: Represents the pass/fail result of presence, config, and freshness checks.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | enum | Yes | `pass` or `fail`. |
| `checks` | `CheckResult[]` | Yes | Presence, section schema, config, and freshness categories. |
| `diagnostics` | `VerdictDiagnostic[]` | Yes on fail | Bounded findings. Empty on pass. |
| `summary` | string/object | Yes | Stable summary suitable for local and CI display. |

Validation rules:
- Any failed check makes the overall status `fail`.
- Diagnostics are bounded and do not include unbounded file contents.
- Output ordering is deterministic by category, contract name, and path.

### 6) Verdict Diagnostic (`verdict_diagnostic`)

Purpose: Captures one actionable failure without requiring interactive triage.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `category` | enum | Yes | `presence`, `section-schema`, `config`, or `freshness`. |
| `name` | string | Conditional | Required when a finding belongs to a known contract entry. |
| `sourcePath` | repo-relative path | Conditional | Present for source freshness failures. |
| `contractPath` | repo-relative path | Conditional | Present for contract-related failures. |
| `message` | bounded string | Yes | Stable diagnostic text. |

Validation rules:
- Messages are concise and deterministic.
- Diagnostics include enough path context for a developer or agent to update the right artifact.
- Diagnostics never prompt for operator input.

## Relationships

- A Contract Freshness Config contains many Freshness Entries.
- A Freshness Entry references exactly one Required Contract.
- A Changed File Set may match zero or more Freshness Entries through `publicSourcePaths`.
- A Contract Verdict contains many Check Results and zero or more Verdict Diagnostics.
- A Freshness Diagnostic links a changed public source path to the contract path that must change with it.

## State Transitions

### Contract verdict lifecycle

1. `not_evaluated` -> `passing`
   - Trigger: Required contracts exist, required sections are valid, the freshness config is valid, and changed public sources have matching contract changes.
   - Effects: The local command exits zero.

2. `not_evaluated` -> `failing`
   - Trigger: Any presence, section schema, config, or freshness check fails.
   - Effects: The local command exits non-zero with bounded diagnostics.

### Freshness entry lifecycle

1. `declared` -> `validated`
   - Trigger: Config validation confirms the entry references a Required Contract and has non-overlapping source selectors.
   - Effects: The entry can participate in drift checks.

2. `validated` -> `drift_detected`
   - Trigger: A changed source path matches the entry and the contract path is absent from the changed-file set.
   - Effects: The verdict contains a freshness diagnostic.

3. `drift_detected` -> `reviewed`
   - Trigger: The owning contract path is included in the changed-file set.
   - Effects: Freshness passes for that entry.

## Identity & Uniqueness

- A Required Contract is uniquely identified by `name`.
- A Freshness Entry is uniquely identified by `name` and must also have a unique `contractPath`.
- A source selector is uniquely owned by one Freshness Entry.
- A Verdict Diagnostic is uniquely identified by `(category, name, sourcePath, contractPath, message)`.
