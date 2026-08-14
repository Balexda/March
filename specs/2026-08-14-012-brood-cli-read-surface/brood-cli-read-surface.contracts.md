# Contracts: Brood CLI Read Surface
<!-- applicability: code-shaped features only -->

## Interfaces

### `march brood list`

**Purpose**: List Brood-tracked sessions.
**Consumers**: Operators, scripts, Smithy skills.
**Providers**: March CLI, Brood service.

#### Signature

```text
march brood list [--kind <spawn|steward|legate>] [--status <status>] [--json] [--reconcile|--no-reconcile]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--kind` | SessionKind | No | Filter rows by session kind. |
| `--status` | SessionStatus | No | Filter rows by lifecycle status. |
| `--json` | boolean | No | Emit JSON instead of table output. |
| `--reconcile` | boolean | No | Enable observational liveness reconciliation. |
| `--no-reconcile` | boolean | No | Disable observational liveness reconciliation. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| table rows | text | Columns: id, status, age, branch, container, attention marker. |
| JSON | BroodReadView[] | Stable array of matching read views. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Invalid kind or status | Usage error | Reject before querying. |
| Brood unreachable | Non-zero error | Surface client error; no raw-registry fallback. |
| No matching rows | Success | Empty JSON array or empty-result table message. |

### `march brood inspect <id>`

**Purpose**: Inspect one Brood-tracked session.
**Consumers**: Operators, scripts, Smithy skills.
**Providers**: March CLI, Brood service.

#### Signature

```text
march brood inspect <id> [--json] [--reconcile|--no-reconcile]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session id to inspect. |
| `--json` | boolean | No | Emit JSON instead of human output. |
| `--reconcile` | boolean | No | Enable observational liveness reconciliation. |
| `--no-reconcile` | boolean | No | Disable observational liveness reconciliation. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| human output | text | Rendered record fields plus derived read fields, including `failureReason` when present. |
| JSON | BroodReadView | A single read view. The complete tracked `SessionRecord` is its `record` field — `failureReason` is read from there, not emitted as a peer key. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown id | Non-zero not-found | Deterministic message; no mutation. |
| Brood unreachable | Non-zero error | Surface client error; no raw-registry fallback. |
| Reconciliation source unavailable | Success with unreconciled/unknown liveness | Inspect still returns the registry record. |

### `march brood logs <id>`

**Purpose**: Read logs for one Brood-tracked session.
**Consumers**: Operators, Smithy skills.
**Providers**: March CLI, Brood service, Docker log read path, teardown archive.

#### Signature

```text
march brood logs <id>
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session id whose logs should be read. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| stdout | text | Live container logs or archived `container.log` content. |
| source | LogReadSource | Observable in JSON-capable internals/tests; not required in human output. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown id | Non-zero not-found | Deterministic message; no mutation. |
| No tracked container and no archive | Non-zero unavailable-log error | Clearly explains that logs are unavailable. |
| Docker log read fails and archive exists | Success from archive | Archive fallback is used. |
| Docker log read fails and archive missing | Non-zero unavailable-log error | Includes Docker read failure context. |
| Brood unreachable | Non-zero error | Surface client error; no raw-registry fallback. |

## Events / Hooks

| Event / Hook | Trigger | Payload | Notes |
|--------------|---------|---------|-------|
| None | F2 read commands | N/A | This feature introduces no event publication or subscription. |

## Integration Boundaries

| Boundary | Direction | Contract | Failure Mode |
|----------|-----------|----------|--------------|
| March CLI -> Brood service | outbound HTTP | list/get session read requests with optional filters/reconciliation mode | Non-zero client error; no local fallback. |
| March CLI/Brood read path -> Docker logs | read-only local/system call | Read logs for tracked container id | Fall back to archive if available; otherwise non-zero unavailable-log error. |
| March CLI/Brood read path -> teardown archive | read-only filesystem | Read archived `container.log` for session id | Non-zero unavailable-log error when absent. |
| Brood service -> session registry | read-only query | Return SessionRecord rows | Query errors surface as non-zero CLI errors. |
