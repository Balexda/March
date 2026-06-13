# Data Model: Brood Session Index

## Overview

This feature models a **read-and-derive** layer over the per-spawn record JSON M1 already persists to `~/.march/spawns/`. The persisted `SpawnRecord` remains the source of truth. The optional persisted `failureReason` field is **already present** on `SpawnRecord` in `src/brood/spawn-record.ts`; this feature defines the non-persisted derived view (`SpawnView`) over the record. No new persisted status values are introduced and the schema `version` is unchanged.

## Entities

### 1) SpawnRecord

Purpose: The durable per-spawn record M1 writes to `~/.march/spawns/<id>.json` (defined in `src/brood/spawn-record.ts`). The reader/derive layer reads it untouched; the `failureReason` field below is already present.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | Yes | Unchanged — stays `1`. Adding `failureReason` is forward-compatible and MUST NOT bump it. |
| `id` | string | Yes | Spawn identity; the `<id>.json` filename key. |
| `status` | `SpawnStatus` | Yes | One of `"created" | "running" | "stopped" | "failed"`. Enum is unchanged by this feature. |
| `profile` | string | No | M2-era field owned by M2 F5. The reader MUST tolerate its presence or absence; this feature does not add it. |
| `failureReason` | string | No | Optional; already present in `src/brood/spawn-record.ts`. Carries the `error` string `markSpawnRecordFailed` records. Absent on success-path records. |

Validation rules:
- `version` stays `1`; `failureReason` is additive and optional.
- The persisted `status` is only ever one of the four canonical `SpawnStatus` values.
- A record both with and without `profile` is valid input to the reader.
- The reader never writes derived conditions back into the record.

### 2) SpawnView (derived, non-persisted)

Purpose: A computed view over a `SpawnRecord` that exposes operator-legible conditions without persisting them.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `record` | `SpawnRecord` | Yes | The underlying persisted record the view is derived from. |
| `needsAttention` | boolean | Yes | Derived attention condition (e.g. a `failed` record). Never persisted; `"needs-attention"` is not a `SpawnStatus`. |
| `disposed` | boolean | Yes | Derived from "record JSON present, container/worktree absent". Never persisted; `"disposed"` is not a `SpawnStatus`. |
| `containerLive` | boolean | Yes | Whether the container is live. Reconciled from an optional Docker snapshot when supplied; otherwise inferred from the persisted record. |

Validation rules:
- `SpawnView` is computed on read and never written to disk.
- `needsAttention` and `disposed` are booleans on the view, never status enum values.
- `containerLive` reflects the Docker snapshot when one is passed, else the persisted record.

### 3) Docker Snapshot (optional, caller-supplied)

Purpose: An optional `docker inspect`-style observation the caller passes into derivation to reconcile liveness.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `containerId` | string | Yes (when present) | The container the snapshot describes. |
| `present` | boolean | Yes (when present) | Whether Docker reports the container still exists. |
| `running` | boolean | No | Whether Docker reports it running, when known. |

Validation rules:
- The snapshot is optional; absent it, derivation uses the persisted record alone and makes no Docker call.
- The snapshot is read-only input — derivation never mutates Docker or the record from it.

## Relationships

- A `SpawnView` is derived from exactly one `SpawnRecord`.
- `listSpawnRecords()` yields the set of `SpawnRecord`s under `~/.march/spawns/`; `loadSpawnRecord(id)` yields one.
- `derivedStatus(record, dockerSnapshot?)` returns the `SpawnView` for a `SpawnRecord` (optionally informed by a Docker Snapshot), computing its derived flags.
- A Docker Snapshot, when supplied, informs only the `containerLive` flag of the resulting view.

## State Transitions

This feature introduces no persisted state transitions — it derives view conditions on read; the persisted `SpawnStatus` lifecycle is owned by M1. The derivations are:

1. persisted `status` → `needsAttention`
   - Trigger: A record in an attention-worthy persisted status (e.g. `failed`) is read.
   - Effect: `needsAttention` is `true` on the derived view; nothing is written to disk.

2. (JSON present, container/worktree absent) → `disposed`
   - Trigger: A record's JSON exists but its runtime artifacts are gone (the F3 teardown path leaves the JSON in place).
   - Effect: `disposed` is `true` on the derived view; no `"disposed"` status is persisted.

3. persisted `status` + optional Docker Snapshot → `containerLive`
   - Trigger: Derivation runs with or without a snapshot.
   - Effect: `containerLive` reflects the snapshot when supplied; otherwise it is inferred from the persisted record. No mutation occurs either way.

## Identity & Uniqueness

- A `SpawnRecord` is uniquely identified by its `id` (the `<id>.json` filename).
- A `SpawnView` shares the identity of the `SpawnRecord` it is derived from and has no independent persisted identity.
- A Docker Snapshot is associated with a record by `containerId`.
