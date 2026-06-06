# Data Model: Test Layer Migration Policy

## Overview

This feature introduces **no runtime data, storage, or type definitions**. Its only artifact is a written policy section in `CONTRIBUTING.md`. The entities below are documentation concepts that describe the policy's internal structure so downstream task decomposition has a shared vocabulary; none of them are persisted, queried, or represented in code.

## Entities

### 1) Test Layer Migration Policy (documentation section)

Purpose: The `CONTRIBUTING.md` section that states the migration trigger and records the governed tests' starting state.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `heading` | text | Yes | The "Test Layer Migration" heading under `## Testing`. |
| `governedSet` | path list | Yes | The three governed vitest file paths. |
| `triggeringConditions` | enumerated text | Yes | Verbatim list of material-change conditions. |
| `nonMaterialConditions` | enumerated text | Yes | Verbatim list of non-triggering change classes. |
| `startingState` | text | Yes | The corrected `@l2` / mocks-`node:child_process` / no-real-Docker premise. |

Validation rules:
- The section lives in `CONTRIBUTING.md`, not in a generated manifest or runtime store.
- The governed set is fixed at exactly the three named files for this feature.
- The conditions are written so a material/non-material classification is reproducible from the text alone.

### 2) Governed Legacy L2 Test (referenced, not stored)

Purpose: One of the three pre-existing vitest files the policy governs.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | enum path | Yes | `src/spawn/container-launch.test.ts`, `src/spawn/snapshot-build.test.ts`, or `src/hatchery/legate-container.test.ts`. |
| `tags` | text | Yes | `@l2 @deterministic @ci` (assigned by Feature 1, recorded here). |
| `mockSurface` | text | Yes | Mocks `node:child_process`; exercises no real Docker. |

Validation rules:
- Only these three files are governed by this feature.
- The tag and mock-surface facts are inherited from Feature 1 and recorded, not re-decided.

### 3) Migration Trigger (decision, not stored)

Purpose: The per-PR classification a contributor derives from the policy.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `governedPath` | path | Yes | The governed file the PR touches. |
| `classification` | enum | Yes | `material` or `nonMaterial`, derived from the verbatim conditions. |
| `requiredOutcome` | enum | Yes | `portToCucumber` when material; `none` when non-material. |

Validation rules:
- The classification is produced by reading the policy, not by any tool.
- A `material` classification requires a Cucumber.js port of the affected scenario in the same change PR.

## Relationships

- A Test Layer Migration Policy references exactly three Governed Legacy L2 Tests.
- A Migration Trigger is evaluated against one Governed Legacy L2 Test using the policy's conditions.

## State Transitions

### Governed test lifecycle (informational)

1. `vitestInPlace` -> `materialChangeTouches`
   - Trigger: A PR makes a semantic change matching a triggering condition.
   - Effects: The policy requires a Cucumber.js port of the affected scenario in that PR.

2. `vitestInPlace` -> `vitestInPlace`
   - Trigger: A PR makes only non-material edits.
   - Effects: No port; the test stays in vitest.

## Identity & Uniqueness

- The policy is identified by its "Test Layer Migration" heading in `CONTRIBUTING.md`.
- A Governed Legacy L2 Test is identified by its repo-relative `path`.
