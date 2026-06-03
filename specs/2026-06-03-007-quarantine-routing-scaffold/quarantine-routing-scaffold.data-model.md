# Data Model: Quarantine Routing Scaffold

## Overview

This model describes the quarantine scaffold introduced in M1: a canonical `tests/quarantine/` directory, the test files parked within it, a generated roster index, and the directory-path exclusion contract the staged scripts consume. Membership is location-based — a test is quarantined because it lives under `tests/quarantine/`, not because of any tag or metadata. No database or runtime state is introduced; the "model" is the filesystem layout plus the generated index derived from it.

## Entities

### 1) Quarantine Directory (`tests/quarantine/`)

Purpose: The canonical, RFC-pinned location that holds tests parked out of the staged gate. Its existence and path are the stable contract downstream features and milestones key on.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | Fixed at `tests/quarantine/`; pinned by RFC M1 criteria. |
| `contents` | set of test files | Yes | Zero or more `*.test.ts` files currently parked. |

Validation rules:
- The path is exactly `tests/quarantine/`; it is not configurable per-run.
- The directory may be empty; an empty directory is a valid state.

### 2) Quarantined Test

Purpose: A single test file that has been routed into the quarantine directory and is therefore excluded from the staged gate while remaining visible.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | Resolves under `tests/quarantine/`. |
| `originPath` | repo-relative path | No | Where the test lived before parking, when recoverable, to support restore. |
| `tagTuple` | scope + determinism + channel | Yes | The Feature 1 tag tuple, preserved unchanged when the file is parked. |
| `body` | test source | Yes | Preserved verbatim — never skipped, deleted, or commented out. |

Validation rules:
- A quarantined test must physically reside under `tests/quarantine/`.
- The test body and its tag tuple are preserved exactly as they were before parking.
- A quarantined test must not be in any non-quarantine test location simultaneously.

### 3) Quarantine Index (`tests/quarantine/INDEX.md`)

Purpose: The generated, human-visible roster of currently quarantined tests. It is the surface the M6 SLA timer and the cassette-refresh workflow will later read; in M1 it provides visibility only.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | repo-relative path | Yes | Fixed at `tests/quarantine/INDEX.md`. |
| `entries` | list of repo-relative paths | Yes | One per currently quarantined test; empty list is valid. |
| `generated` | boolean | Yes | Always derived from directory contents, never hand-edited. |

Validation rules:
- Entries equal exactly the set of quarantined test files at generation time — no stale or missing rows.
- Regeneration after a directory change yields an index consistent with the new contents.
- An empty quarantine directory yields a valid index that reports zero quarantined tests.

### 4) Directory-Path Exclusion Contract

Purpose: The stable predicate Feature 2's four staged scripts consume to exclude parked tests from the deterministic gate.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `excludePath` | repo-relative path | Yes | `tests/quarantine/`. |
| `appliesTo` | set of script ids | Yes | `test:l0`, `test:l1`, `test:l2-cassette`, `test:l3-cassette`. |
| `mechanism` | enum | Yes | `directory-path` — never `tag-predicate`. |

Validation rules:
- The contract is a directory path, independent of the tag taxonomy and of the routing primitive's source-tree location (SD-101 / SD-103).
- All four staged scripts must honor the same exclusion path.
- The exclusion takes precedence when a quarantined path would otherwise match a script's selection glob.

## Relationships

- A Quarantine Directory contains zero or more Quarantined Tests.
- A Quarantine Index is generated from (and is 1:1 with) the current contents of the Quarantine Directory.
- The Directory-Path Exclusion Contract references the Quarantine Directory's path and is consumed by Feature 2's staged scripts.

## State Transitions

### Test quarantine lifecycle

1. `active` -> `quarantined`
   - Trigger: The Operator routes a failing test via the quarantine primitive.
   - Effects: The test file moves under `tests/quarantine/`, is excluded from the staged scripts, and appears in the regenerated `INDEX.md`. Its body and tags are preserved.

2. `quarantined` -> `active` (restore)
   - Trigger: The test is fixed or re-recorded and routed back out of quarantine.
   - Effects: The file leaves `tests/quarantine/`, re-enters the staged gate, and drops off the regenerated `INDEX.md`.

3. `quarantined` -> `removed`
   - Trigger: The coverage is deleted or replaced because the parked test is no longer useful.
   - Effects: The file is removed and the regenerated `INDEX.md` no longer lists it.

_The one-week SLA clock that bounds how long a test may stay `quarantined` is M6 and is not modeled here._

## Identity & Uniqueness

- A Quarantined Test is uniquely identified by its repo-relative path under `tests/quarantine/`.
- The Quarantine Directory and the Quarantine Index each have a single fixed path.
- The Quarantine Index is fully derived from directory contents, so it has no independent identity to reconcile.
