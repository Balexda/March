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
**Providers**: March CLI, Brood service, Docker log read path, Castra session output, teardown archive.

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
| stdout | text | Live container logs, Castra session output, or archived `container.log` content. |
| source | LogReadSource | Observable in JSON-capable internals/tests; not required in human output. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown id | Non-zero not-found | Deterministic message; no mutation. |
| No live source and no archive | Non-zero unavailable-log error | Clearly explains that logs are unavailable. A `steward` row's missing `containerId` is not itself a missing source — Castra is its live source. |
| Live source read fails and archive exists | Success from archive | Archive fallback is used. |
| Live source read fails and archive missing | Non-zero unavailable-log error | Includes the Docker or Castra read failure context. |
| Brood unreachable | Non-zero error | Surface client error; no raw-registry fallback. |

## Brood service HTTP endpoints

The CLI verbs above are thin clients. Reconciliation and log reading are
**server-owned** (FR-020) — the CLI never opens a Docker socket, talks to
Castra, or reads the teardown archive itself. Two of these routes exist today
and gain a query parameter; the logs route is new.

| Route | Status | Query | Success response | Errors |
|-------|--------|-------|------------------|--------|
| `GET /sessions` | exists | `kind`, `status`, `parentId` (all existing); `reconcile=true\|false` (**new**, default `false`) | `200` `{ "sessions": SessionRecord[], "views": BroodReadView[] }` | `400` invalid or repeated `kind`, `status`, `parentId`, or `reconcile` value; `503` reconciliation source unreachable when `reconcile=true` |
| `GET /sessions/:id` | exists | `reconcile=true\|false` (**new**, default `true`) | `200` `BroodReadView` — the full `SessionRecord` nested at `record` | `404` `{ "error": "No session with id \"<id>\"." }` (existing shape) |
| `GET /sessions/:id/logs` | **new** | — | `200` `text/plain` log content, plus `X-March-Log-Source: live-container\|castra-session\|archive` | `404` unknown id; `409` no log source available; `502` upstream Docker/Castra read failure with an archive miss |

Story 1 `GET /sessions` read-view fields:

| Field | Type | Description |
|-------|------|-------------|
| `views[].record` | SessionRecord | The matching service-owned registry row; raw `sessions[]` remains alongside it for existing consumers. |
| `views[].age` | string | Human age derived from `createdAt`; never persisted. |
| `views[].needsAttention` | boolean | True for failed rows in the Story 1 implementation. |
| `views[].disposed` | boolean | True when the row is torndown or has `torndownAt`. |
| `views[].containerLive` | boolean \| null | Observed liveness when `reconcile=true`; the registry fact otherwise. `null` for rows without a tracked container such as normal steward rows. |
| `views[].reconciled` | boolean | `true` only when a liveness observation was actually performed and applied to the row — i.e. `reconcile=true` and the observation succeeded. `false` by default and when `reconcile=false`. |

`GET /sessions` is read-only and service-owned: it validates list filters before
querying the registry, derives `views[]` from `SessionRecord` rows in memory, and
does not mutate registry, Docker, Castra, archive, worktree, or branch state.
Reconciliation is observational — the service reads container liveness (one
`docker ps --all` per reconciled read, never per row) and reports it; it never
repairs, updates, or tears anything down. An unreachable liveness source is an
explicit `503` rather than registry data mislabelled as observed, so a caller
never receives `reconciled: true` for a read that was not observed. This slice
implements only the list route; inspect, logs, teardown, and archive behavior
stay at their pre-slice scope.

Contract notes:

- The existing routes' current response shapes are `{ sessions: [...] }` and a
  bare record. Adding `views` alongside `sessions`, and nesting the record under
  `record` on the single-session route, are **additive** changes chosen so
  existing consumers keep working; confirm no current caller depends on the bare
  top-level record before slicing.
- `reconcile` defaults differ per route to match the CLI defaults (list off,
  inspect on) so the client does not have to send the parameter for default
  behavior.
- Reconciliation failure degrades rather than fails on the single-session route:
  the record is still returned with `reconciled: false`.
- See SD-004 — whether reconciliation belongs on these routes as a parameter or
  on a separate observation endpoint is a service-design decision for the slice.

## Events / Hooks

| Event / Hook | Trigger | Payload | Notes |
|--------------|---------|---------|-------|
| None | F2 read commands | N/A | This feature introduces no event publication or subscription. |

## Integration Boundaries

| Boundary | Direction | Contract | Failure Mode |
|----------|-----------|----------|--------------|
| March CLI -> Brood service | outbound HTTP | `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/logs` per the endpoint table above | Non-zero client error; no local fallback. |
| Brood service -> Docker logs | read-only system call | Read logs for a `spawn` / `legate` row's tracked container id | Fall back to archive if available; otherwise `409` unavailable-log. |
| Brood service -> Castra | read-only HTTP | Read session output for a live `steward` row by `agentDeckSessionId` | Fall back to archive if available; otherwise `409` unavailable-log. Unverified read path — see SD-005. |
| Brood service -> teardown archive | read-only filesystem | Read archived `container.log` for session id | `409` unavailable-log when absent. |
| Brood service -> session registry | read-only query | Return SessionRecord rows | Query errors surface as non-zero CLI errors. |
