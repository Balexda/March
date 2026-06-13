# Contracts: Brood Session Index

## Overview

This feature introduces a repository-internal **TypeScript module contract**, not an HTTP, event, or CLI surface. `src/brood-index.ts` exposes the tolerant read-and-derive API every downstream Brood verb consumes, and `src/spawn-record.ts` gains one optional persisted field plus the wiring that fills it. No runtime events, metrics, logs, or spans are introduced.

## Interfaces

### Spawn Index Reader (`src/brood-index.ts`)

**Purpose**: One tolerant API to list, load, and derive status over the per-spawn records.
**Consumers**: Brood verbs `list` / `inspect` / `logs` / `teardown` / `attach` (F2–F5), and Smithy task verification.
**Providers**: `src/brood-index.ts`, reading the JSON M1 writes under `~/.march/spawns/`.

#### Signature

```ts
// Listed shapes are the contract surface; exact field names follow src/spawn-record.ts.
function listSpawnRecords(): SpawnRecord[];          // tolerant: skips unreadable records
function loadSpawnRecord(id: string): SpawnRecord | undefined;
function derivedStatus(record: SpawnRecord, dockerSnapshot?: DockerSnapshot): SpawnView;

interface SpawnView {
  record: SpawnRecord;
  needsAttention: boolean;   // derived, never persisted
  disposed: boolean;         // derived, never persisted
  containerLive: boolean;    // reconciled from dockerSnapshot when supplied
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | For `loadSpawnRecord` | Spawn identity / record filename key under `~/.march/spawns/`. |
| `record` | `SpawnRecord` | For `derivedStatus` | The persisted record to derive a view from. |
| `dockerSnapshot` | `DockerSnapshot` | No | Optional caller-supplied `docker inspect` observation reconciling `containerLive`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `SpawnRecord[]` | array | Valid records under `~/.march/spawns/`; unreadable ones are skipped, not thrown. |
| `SpawnRecord \| undefined` | record | The single record for `id`, or `undefined` not-found. |
| `SpawnView` | derived view | `record` plus `needsAttention` / `disposed` / `containerLive`, none persisted. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Record fails JSON parse (concurrent dispatch write) | Retry once, then skip-and-warn | The safe-read protocol keeps `list` from failing on a mid-write file. |
| Unknown `id` for `loadSpawnRecord` | Return `undefined` (deterministic not-found) | No thrown parse error for a missing record. |
| Record lacks the M2-era `profile` field | Load successfully | The reader tolerates records with and without `profile`. |
| No Docker snapshot supplied to `derivedStatus` | Derive from the record alone | The module makes no Docker call and no mutation. |

### SpawnRecord failureReason wiring (`src/spawn-record.ts`)

**Purpose**: Persist *why* a spawn failed, captured from the `error` previously dropped by `markSpawnRecordFailed`.
**Consumers**: F2 `inspect` (surfaces `failureReason`), the reader above.
**Providers**: `src/spawn-record.ts` — the `SpawnRecord` shape and `markSpawnRecordFailed`.

#### Signature

```ts
interface SpawnRecord {
  version: 1;                 // unchanged — no bump
  // ...existing fields...
  failureReason?: string;     // new, optional, forward-compatible
}

// MarkSpawnRecordFailedOptions already declares `error` in its JSDoc;
// markSpawnRecordFailed wires that error through to record.failureReason.
function markSpawnRecordFailed(id: string, options: MarkSpawnRecordFailedOptions): void;
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The spawn whose record is marked failed. |
| `options.error` | string | No | The failure reason to persist into `failureReason`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `failureReason` | string (optional) | Persisted on the record when `error` was supplied; absent otherwise. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| `error` supplied | Persist `failureReason` | The previously-dropped argument now reaches disk. |
| `error` omitted | Leave `failureReason` absent | Field stays optional; older records load without it. |
| Schema read of a record without `failureReason` | Load successfully at `version` 1 | Additive field requires no migration or version bump. |

## Events / Hooks

No runtime events, metrics, logs, or spans are introduced. This feature is a repository-internal read-and-derive module plus one additive persisted field.

## Integration Boundaries

- **M1 spawn records (`src/spawn-record.ts`, `~/.march/spawns/`)**: The source of truth this feature reads and minimally extends; the `SpawnStatus` enum and `version` are unchanged.
- **Brood CLI read surface (F2)**: Consumes `listSpawnRecords` / `loadSpawnRecord` / `SpawnView` and surfaces `failureReason`; not implemented here.
- **Lifecycle teardown (F3)**: Leaves the record JSON in place after removing the container/worktree — the condition this feature's `disposed` derivation keys on; teardown itself is out of scope here.
- **Docker**: Liveness reconciliation is caller-driven via an optional snapshot; this module never shells out to Docker or mutates Docker state.
- **M2 profile (M2 F5)**: This feature tolerates the `profile` field's presence or absence and does not add it.
- **Architecture-note supersession**: If Brood binds this API to the SQLite registry rather than the JSON directory, the module contract above is the seam that stays stable (spec SD-001).
