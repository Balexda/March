# Contracts: Spawn Output Extraction

## Overview

Spawn Output Extraction defines the boundary between completed spawn execution and downstream Steward / PR integration. It consumes lifecycle state and backend output, validates patch content, persists a backend-neutral result, and exposes only validated patch data for handoff.

## Types

These named types appear in the signatures below. They map onto the entities in the [data model](spawn-output-extraction.data-model.md); field-level validation rules live there.

| Type | Kind | Shape |
|------|------|-------|
| `ExtractSpawnOutputInput` | input | `{ spawnId: string; backend: string; worktreePath: string; outputSource: OutputSource }` — matches the Extraction Runner inputs below. |
| `OutputSource` | adapter | `{ readOutput(spawnId: string): { rawJson: string; truncated: boolean } }` — returns bounded output for a terminal spawn; abstracts container / Castra-session / Hatchery-job sources. |
| `CandidatePatch` | value | `{ patchText: string; summary?: string }` — unvalidated patch payload parsed from a backend envelope. |
| `ValidateSpawnPatchInput` | input | `{ patchText: string; worktreePath: string }` — matches the Patch Validator inputs below. |
| `ValidatedPatch` | value | `{ patchText: string; touchedPaths: string[]; sha256: string }` — accepted patch; the validated core of `SpawnPatch` in the data model. |
| `ExtractionResult` | result | Backend-neutral terminal result returned by `extractSpawnOutput`; the `ExtractionResult` entity in the data model. |
| `SpawnPatch` | value | Persisted validated patch entity (`spawnId`, `backend`, `patchText`, `touchedPaths`, `sha256`); see the data model. |

## Interfaces

### Extraction Runner

**Purpose**: Extract a validated patch result from a terminal spawn.
**Consumers**: Hatchery spawn runner, future lifecycle automation.
**Providers**: Spawn output extraction module.

#### Signature

```typescript
extractSpawnOutput(input: ExtractSpawnOutputInput): ExtractionResult
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spawnId` | string | Yes | Spawn to extract. |
| `backend` | string | Yes | Backend recorded for the spawn. |
| `worktreePath` | string | Yes | Spawn or manager worktree path used for patch path validation. |
| `outputSource` | OutputSource | Yes | Adapter capable of returning bounded output for the spawn. |

#### Outputs

Returns an `ExtractionResult` (see the data model for the authoritative entity):

| Field | Type | Description |
|-------|------|-------------|
| `spawnId` | string | Source spawn identifier. |
| `backend` | `"claude-code" \| "codex"` | Backend used for parsing and diagnostics. |
| `status` | `"succeeded" \| "failed"` | Terminal extraction status. |
| `patch` | `SpawnPatch` | Validated patch (`patchText`, `touchedPaths`, `sha256`); present only when `status` is `"succeeded"`. |
| `failureReason` | string | Stable failure category; present only when `status` is `"failed"`. |
| `diagnostic` | string | Bounded human-readable diagnostic. |
| `extractedAt` | ISO-8601 timestamp | Time the result was finalized. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Spawn is not terminal | Failed result | Extraction refuses to process running or nonterminal spawns. |
| Unknown backend | Failed result | No parser adapter is available for the recorded backend. |
| Output unavailable | Failed result | Source cannot return output for the spawn. |
| Malformed JSON | Failed result | Backend envelope cannot be parsed. |
| Invalid patch paths | Failed result | Patch targets escape the spawn worktree or are otherwise unsafe. |

---

### Backend Output Parser Adapter

**Purpose**: Convert backend-specific JSON envelopes into a candidate patch payload.
**Consumers**: Extraction Runner.
**Providers**: Claude Code parser, Codex parser.

#### Signature

```typescript
parseBackendEnvelope(backend: string, rawJson: string): CandidatePatch
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `backend` | string | Yes | Backend name used to choose the adapter. |
| `rawJson` | string | Yes | Bounded raw backend JSON output. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `patchText` | string | Candidate unified git patch text. |
| `summary` | string | Optional backend-provided summary, bounded for diagnostics. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Backend unsupported | Parser error | No adapter exists for the backend. |
| JSON malformed | Parser error | Output is not valid JSON for the adapter. |
| Patch absent | Parser error | Envelope contains no usable patch payload. |
| Patch ambiguous | Parser error | Envelope contains multiple incompatible candidate patches. |

---

### Patch Validator

**Purpose**: Treat candidate patches as untrusted input and ensure every target is safe for downstream application.
**Consumers**: Extraction Runner, tests for F4 A6 mitigation.
**Providers**: Spawn output extraction module.

#### Signature

```typescript
validateSpawnPatch(input: ValidateSpawnPatchInput): ValidatedPatch
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `patchText` | string | Yes | Candidate unified git patch text. |
| `worktreePath` | string | Yes | Root path used to validate normalized patch targets. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `patchText` | string | Original accepted patch text. |
| `touchedPaths` | string[] | Normalized relative paths touched by the patch. |
| `sha256` | string | Stable digest for retry deduplication. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Empty patch | Validation error | Patch contains no file changes. |
| Absolute path | Validation error | Patch target is absolute. |
| Path traversal | Validation error | Patch target resolves outside the worktree. |
| Unsupported patch form | Validation error | Patch cannot be safely parsed by the downstream apply path. |

## Events / Hooks

No public event schema is introduced by this feature. Existing Hatchery and Brood lifecycle state may record extraction completion, but this spec does not define a new Herald event.

## Integration Boundaries

- **Feature 2 (Spawn Dispatch)**: F5 consumes terminal spawn state, container/session output, worktree path, branch name, and exit code produced by dispatch.
- **Feature 3 (Multi-Backend Execution Interface)**: F5 reads the recorded backend name and uses it to select the output parser. `parseExitCode` remains outside `SpawnBackend`.
- **Feature 4 (Spawn Sandbox Security)**: F5 implements the A6 output-channel manipulation contract: validate JSON structure, reject malformed output, validate patch paths, and never apply patches to the main checkout.
- **Feature 6 (PR Integration)**: F6 consumes only successful `ExtractionResult` values. It does not parse raw backend logs and does not bypass F5 validation.
- **Hatchery**: Hatchery invokes extraction after spawn completion and gates Steward handoff on a successful extraction result.
- **Brood**: Brood remains the lifecycle authority. F5 reads lifecycle state and may write extraction status through the owning persistence boundary selected during implementation.
- **Castra / Steward**: Castra-hosted Steward sessions receive validated patch content and metadata, not arbitrary raw spawn output.
