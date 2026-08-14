# Data Model: Brood CLI Read Surface
<!-- applicability: code-shaped features only -->

## Entities

### 1) SessionRecord (`brood_session`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Yes | Stable session identifier used by `inspect` and `logs`. |
| `kind` | `spawn \| steward \| legate` | Yes | Filterable by `list --kind`. |
| `status` | SessionStatus | Yes | Filterable by `list --status`; read commands do not change it. |
| `parentId` | string | No | Relationship to a parent spawn for steward rows. |
| `branch` | string | No | Displayed by list and inspect. |
| `worktreePath` | string | No | Displayed by inspect; may inform derived `disposed`. |
| `containerId` | string | No | Displayed by list and inspect; used by `logs` live-source selection. |
| `failureReason` | string | No | Displayed by inspect when present. |
| `createdAt` | ISO timestamp | Yes | Used to derive age. |
| `updatedAt` | ISO timestamp | Yes | Displayed by inspect. |
| `stoppedAt` | ISO timestamp | No | Displayed by inspect. |
| `torndownAt` | ISO timestamp | No | Informs derived `disposed`. |

Validation rules:
- Read commands MUST NOT create, update, delete, or repair SessionRecord rows.
- Invalid `kind` and `status` filter values are rejected before querying as usage errors.
- Missing optional fields are rendered as null/empty values without changing output shape.

### 2) BroodReadView (`brood_read_view`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `record` | SessionRecord | Yes | Source registry row. |
| `age` | string | Yes | Human/table age derived from timestamps. |
| `needsAttention` | boolean | Yes | Derived marker for list and inspect. |
| `disposed` | boolean | Yes | Derived teardown/disposal condition. |
| `containerLive` | boolean | No | Present when known from registry facts or reconciliation. |
| `reconciled` | boolean | Yes | Whether liveness reconciliation was requested and applied. |

Validation rules:
- BroodReadView is never persisted.
- Derived flags MUST NOT be written back to SessionRecord.
- `reconciled` is false for default list reads and true for default inspect reads unless overridden.

### 3) ReconciliationMode (`reconciliation_mode`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enabled` | boolean | Yes | Set by command defaults and explicit flags. |
| `source` | `default \| flag` | Yes | Records whether the mode came from default behavior or an explicit flag. |

Validation rules:
- `list` default: `enabled=false`, `source=default`.
- `inspect` default: `enabled=true`, `source=default`.
- Explicit `--reconcile` and `--no-reconcile` override the default and set `source=flag`.

### 4) LogReadSource (`log_read_source`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `kind` | `live-container \| archive` | Yes | Selected log source. |
| `containerId` | string | No | Required for `live-container`. |
| `archivePath` | string | No | Required for `archive`. |
| `available` | boolean | Yes | False produces a clear unavailable-log error. |

Validation rules:
- Live container logs are preferred when the tracked container exists.
- Archive fallback is used only when live logs are unavailable and archived `container.log` exists.
- Selecting or reading a LogReadSource MUST NOT mutate Docker or archive state.

## Relationships

| From | To | Cardinality | Notes |
|------|----|-------------|-------|
| SessionRecord | BroodReadView | 1:1 | A read view is derived for each row returned by list or inspect. |
| SessionRecord | LogReadSource | 1:0..1 | Logs select one read source for a tracked session. |
| ReconciliationMode | BroodReadView | 1:N | The same command-level mode applies to all list rows or one inspect row. |

## State Transitions

| Entity | Transition | Trigger | Effects |
|--------|------------|---------|---------|
| SessionRecord | none | Any F2 read command | No persisted state changes. |
| BroodReadView | not-created -> derived | list or inspect reads a SessionRecord | Derived fields are computed for output only. |
| LogReadSource | unresolved -> live-container | logs finds a live tracked container | Live logs are read only. |
| LogReadSource | unresolved -> archive | logs cannot use live container and finds archive | Archived log is read only. |
| LogReadSource | unresolved -> unavailable | logs finds neither source | Command exits non-zero. |

## Identity & Uniqueness

| Entity | Identity | Uniqueness Rule |
|--------|----------|-----------------|
| SessionRecord | `id` | One registry row per session id. |
| BroodReadView | `record.id` + command invocation | Not persisted; no durable identity. |
| LogReadSource | `record.id` + selected source | Not persisted; one source selected per `logs` invocation. |
| ReconciliationMode | command invocation | Not persisted; scoped to the CLI request. |
