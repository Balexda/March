# Data Model: Spawn Output Extraction

## Overview

Spawn Output Extraction converts backend-specific spawn output into a backend-neutral result. The model keeps raw output bounded, treats patch content as untrusted until validated, and exposes only validated patch data to downstream Hatchery and Steward integration.

## Entities

### 1) Spawn Output Envelope (`spawn_output_envelope`)

Purpose: Represents the structured output captured from a completed backend run before March has validated or normalized it.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Identifier of the spawn whose output is being extracted. |
| `backend` | `"claude-code" \| "codex"` | Yes | Backend recorded for the spawn; selects the parser adapter. |
| `source` | `"container" \| "castra-session" \| "hatchery-job"` | Yes | Output source used by the extractor. |
| `rawJson` | string | Yes | Bounded raw JSON payload or diagnostic tail. |
| `truncated` | boolean | Yes | Whether captured output was truncated by the extractor. |
| `capturedAt` | ISO-8601 timestamp | Yes | Time the output was captured. |

Validation rules:
- `rawJson` must be bounded by the extractor's configured capture limit.
- `backend` must match the backend recorded by the spawn lifecycle state.
- Empty output is not a valid envelope.

### 2) Spawn Patch (`spawn_patch`)

Purpose: Represents a git patch extracted from the backend envelope after structure and path validation.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Identifier of the source spawn. |
| `backend` | `"claude-code" \| "codex"` | Yes | Backend that produced the patch. |
| `patchText` | string | Yes | Unified git patch text accepted for downstream handoff. |
| `touchedPaths` | string[] | Yes | Normalized repository-relative paths affected by the patch. |
| `sha256` | string | Yes | Stable digest of `patchText` for deterministic retry behavior. |

Validation rules:
- `patchText` must contain exactly one usable git patch payload.
- `touchedPaths` must be relative paths that resolve inside the spawn worktree.
- Absolute paths, parent-directory escapes, and empty patches are invalid.

### 3) Extraction Result (`extraction_result`)

Purpose: Backend-neutral terminal result consumed by Hatchery and Steward integration.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `spawnId` | string | Yes | Identifier of the source spawn. |
| `backend` | `"claude-code" \| "codex"` | Yes | Backend used for parsing and diagnostics. |
| `status` | `"succeeded" \| "failed"` | Yes | Terminal extraction status. |
| `patch` | SpawnPatch | No | Present only when `status` is `succeeded`. |
| `failureReason` | string | No | Stable failure category when `status` is `failed`. |
| `diagnostic` | string | No | Bounded human-readable diagnostic. |
| `extractedAt` | ISO-8601 timestamp | Yes | Time the result was finalized. |

Validation rules:
- `status: "succeeded"` requires `patch` and forbids `failureReason`.
- `status: "failed"` requires `failureReason` and forbids `patch`.
- `diagnostic` must be bounded and must not contain unbounded raw backend output.

## Relationships

- One spawn has zero or one current `ExtractionResult`.
- One successful `ExtractionResult` owns exactly one `SpawnPatch`.
- One `SpawnOutputEnvelope` is parsed into either one `SpawnPatch` or one failed `ExtractionResult`.

## State Transitions

### Extraction lifecycle

1. `pending` -> `captured`
   - Trigger: A terminal spawn is selected for extraction and output is read.
   - Effects: A bounded `SpawnOutputEnvelope` is available for parsing.

2. `captured` -> `validated`
   - Trigger: Backend-specific parsing succeeds and patch validation passes.
   - Effects: A `SpawnPatch` is ready to persist.

3. `captured` -> `failed`
   - Trigger: Output is missing, malformed, ambiguous, or rejected by patch validation.
   - Effects: A failed `ExtractionResult` is persisted with diagnostics.

4. `validated` -> `succeeded`
   - Trigger: The validated patch result is persisted.
   - Effects: Downstream Hatchery and Steward integration may consume the result.

## Identity & Uniqueness

- `ExtractionResult` is unique by `spawnId`.
- `SpawnPatch.sha256` provides deterministic identity for retry comparison.
- Re-extracting unchanged source output for the same `spawnId` must produce the same `ExtractionResult` content except for operational timestamps.
