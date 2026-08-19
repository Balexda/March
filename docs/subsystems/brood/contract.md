# Brood Service Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Brood owns the session registry and lifecycle read/write boundary for tracked
`spawn`, `steward`, and `legate` sessions. The operator CLI and service clients
consume Brood over HTTP; they do not read registry files or reconcile Docker
state directly.

### `GET /sessions/:id`

| Field | Contract |
|-------|----------|
| Method and path | `GET /sessions/:id` |
| Request envelope | Path param `id`; optional query `reconcile=true\|false`. |
| Default reconciliation | Enabled when `reconcile` is omitted. |
| Success response | `200` with a `BroodReadView`. The complete persisted `SessionRecord` is nested at `record`. |
| Not-found response | `404` with `{ "error": "No session with id \"<id>\"." }`. |

`BroodReadView` fields:

| Field | Type | Meaning |
|-------|------|---------|
| `record` | `SessionRecord` | Complete registry row, including `failureReason` when present. |
| `age` | string | Derived from `record.createdAt`. |
| `needsAttention` | boolean | True only when `record.status === "failed"`. |
| `disposed` | boolean | True when the row is torn down or its tracked worktree is absent. |
| `containerLive` | boolean | Derived from registry status unless reconciliation observes a tracked container. |
| `reconciled` | boolean | True only when liveness reconciliation was requested and completed. |

### Brood Client

| Method | Contract |
|--------|----------|
| `BroodClient.inspect(id)` | Reads `GET /sessions/:id` using the service default reconciliation mode. |
| `BroodClient.inspect(id, { reconcile: true })` | Sends `reconcile=true`. |
| `BroodClient.inspect(id, { reconcile: false })` | Sends `reconcile=false`. |
| `BroodClient.get(id)` | Preserves the bare-record lookup contract for existing callers by returning the nested `record` from the inspect response. |

## Invariants

- Inspect reads are observational: deriving `BroodReadView` never persists
  `needsAttention`, `disposed`, `containerLive`, `reconciled`, or age data.
- The session registry remains the source of truth; `record` is passed through
  from the stored `SessionRecord`, including optional and future fields.
- Reconciliation is server-owned. Callers choose the mode, but Brood performs
  container liveness observation and never asks the CLI to open Docker state.
- Missing optional branch, worktree, and container facts keep a stable read-view
  shape rather than changing the HTTP envelope.

## Error Modes

| Condition | Route or method | Response | Observable behavior |
|-----------|-----------------|----------|---------------------|
| Unknown session id | `GET /sessions/:id`, `BroodClient.inspect` | `404` body from HTTP; `BroodNotFoundError` from the client | No registry, Docker, worktree, branch, or archive mutation. |
| Brood service unreachable | `BroodClient.inspect` | `BroodUnavailableError` | The client surfaces the connection failure and does not fall back to local registry reads. |
| Non-200/non-404 service response | `BroodClient.inspect` | `BroodClientError` | The server error body is propagated when present. |
| Liveness observer failure | `GET /sessions/:id?reconcile=true` | `200` with `reconciled: false` | The record is still returned, `containerLive` falls back to registry-derived liveness, and Brood emits an errored `brood.inspect.reconcile` span via `startBroodSpan`. |
