# Data Model: Contract Scaffold & Required-Section Schema

## Overview

This model supports documentation-only contract scaffolding for the layered testing framework. It defines the artifact concepts and schema shape that later contract authoring, presence checking, freshness checking, and public-interface extraction features consume.

## Entities

### 1) Subsystem Contract (`docs/subsystems/<name>/contract.md`)

Purpose: Represents the explicit contract artifact for a March subsystem or role boundary.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | Follows `docs/subsystems/<name>/contract.md`. |
| `publicInterfaceSection` | markdown H2 section | Yes | Documents the externally consumed route, type, role, command, or protocol surface. |
| `invariantsSection` | markdown H2 section | Yes | Contains assertable behavioral promises. |
| `errorModesSection` | markdown H2 section | Yes | Contains observable failure conditions and expected outcomes. |
| `autogenRegion` | marker pair | No | Reserved region inside `## Public Interface` for generated exported-signature content. |

Validation rules:
- The document has exactly one `## Public Interface` section.
- The document has exactly one `## Invariants` section.
- The document has exactly one `## Error Modes` section.
- Invariants and error modes are written as assertable statements, not background-only prose.
- AUTOGEN markers, when present, appear as a balanced pair inside `## Public Interface`.

### 2) Autogen Region (`autogen_region`)

Purpose: Marks the replaceable generated block that F7 can backfill without rewriting human-authored contract prose.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `beginMarker` | literal string | Yes | `<!-- BEGIN AUTOGEN -->`. |
| `endMarker` | literal string | Yes | `<!-- END AUTOGEN -->`. |
| `ownerSection` | section reference | Yes | Always `## Public Interface`. |
| `contents` | markdown block | No | Empty until an extraction tool populates it. |

Validation rules:
- `beginMarker` precedes `endMarker`.
- A contract has zero or one AUTOGEN region unless a later spec explicitly expands the schema.
- Generated content is replaceable only between the marker pair.

### 3) Contract Freshness Config Shape (`docs/subsystems/contract-freshness.config.json`)

Purpose: Describes the future mapping between subsystem public source changes and the contract artifacts that must be updated with them.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | Yes | Schema version for future checker compatibility. |
| `contracts` | array | Yes | List of contract freshness entries. |
| `contracts[].name` | string | Yes | Stable subsystem or role name. |
| `contracts[].contractPath` | repo-relative path | Yes | Path to the contract artifact. |
| `contracts[].publicSourcePaths` | array of path selectors | Yes | Shape only in this feature; populated selectors are F5 scope. |
| `contracts[].notes` | string | No | Optional ownership note, such as Steward's Castra-consumer binding. |

Validation rules:
- `version` is present so checker behavior can evolve explicitly.
- Each `contractPath` points at a subsystem contract artifact.
- `publicSourcePaths` is structurally required, but this feature does not populate concrete subsystem selectors.
- Steward can be represented by a role entry whose source binding references its consumer surface rather than a standalone module.

## Relationships

- A Contract Freshness Config Shape contains many Subsystem Contract entries.
- A Subsystem Contract can contain zero or one Autogen Region.
- Steward's Subsystem Contract is owned as a role boundary whose source binding is a Castra-consumer surface.

## State Transitions

### Contract artifact lifecycle

1. `scaffolded` -> `authored`
   - Trigger: A later authoring feature fills subsystem-specific interface, invariant, and error-mode content.
   - Effects: The required section schema remains stable while prose becomes subsystem-specific.

2. `authored` -> `freshness_checked`
   - Trigger: A later checker maps source-path changes to contract updates.
   - Effects: Contract drift can produce a local or enforced verdict.

3. `authored` -> `autogen_populated`
   - Trigger: A later extraction tool writes generated exported-signature content between AUTOGEN markers.
   - Effects: Human-authored public-interface prose remains outside the generated region.

## Identity & Uniqueness

- A subsystem contract is uniquely identified by its repo-relative `contractPath`.
- A freshness config entry is uniquely identified by its `name`.
- An AUTOGEN region is uniquely identified by the marker pair within a contract's `## Public Interface` section.
