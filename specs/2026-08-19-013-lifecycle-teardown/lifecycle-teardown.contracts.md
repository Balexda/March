# Contracts: Lifecycle Teardown
<!-- applicability: code-shaped features only -->

## Interfaces

### `march brood teardown <id>`

**Purpose**: Request service-owned lifecycle teardown for one tracked session.
**Consumers**: Operators, Legate loop, Smithy skills.
**Providers**: March CLI, Brood service.

#### Signature

```text
march brood teardown <id> [--force] [--kill] [--reason <text>] [--json]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Tracked session id. |
| `--force` | boolean | No | Permit teardown of `created` or `running` spawn rows. |
| `--kill` | boolean | No | Immediate kill mode; stronger than graceful forced teardown. **Accepted-but-ignored today** — parsed at the route boundary and never read by teardown, which always removes immediately (SD-004). The implementing slice MUST either honour it or reject it as unsupported. |
| `--reason` | string | No | Human-readable reason for *cleanup*, recorded without overwriting the session's existing `failureReason` (FR-020b). |
| `--json` | boolean | No | Emit the TeardownResult as JSON. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| human output | text | Ordered step summary plus warnings. |
| JSON | TeardownResult | Stable service result with id, status, steps, and warnings. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown id | Non-zero not-found | Brood has no matching SessionRecord. |
| Running/created spawn without force | Non-zero conflict | No cleanup steps execute. |
| Brood unreachable | Non-zero client error | CLI does not perform direct local cleanup. |
| Partial or deferred cleanup | **Non-zero**, with the TeardownResult rendered | The CLI MUST exit non-zero whenever `status != "torndown"`, so a deferred teardown is never scripted as success. Step outcomes and warnings identify the incomplete work. |

### Brood Teardown HTTP Endpoint

**Purpose**: Service boundary for lifecycle teardown.
**Consumers**: March CLI, Legate loop, internal clients.
**Providers**: Brood service.

#### Signature

```text
POST /sessions/:id/teardown
Content-Type: application/json
Traceparent: <optional W3C traceparent>

{
  "force": boolean,
  "kill": boolean,
  "reason": string
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session id from the route path. |
| `force` | boolean | No | Permit teardown of running/created spawn rows. |
| `kill` | boolean | No | Immediate kill mode. Currently parsed and not read (SD-004). |
| `reason` | string | No | Cleanup reason; distinct from `failureReason` (FR-020b). |
| `traceparent` | string | No | Parent trace context. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Primary session id for the teardown group. |
| `status` | SessionStatus | `torndown` on verified completion or `tearing-down` on deferred cleanup. **This field — not the HTTP status code — is the single authority on whether cleanup finished** (FR-014a). |
| `steps` | TeardownStep[] | Ordered archive/container/steward/worktree/branch outcomes. |
| `warnings` | string[] | Non-fatal diagnostics. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown id | `404` `{ "error": string }` | No tracked session. |
| Running/created spawn without force | `409` `{ "error": string }` | No cleanup started. |
| Unexpected teardown failure | `500` `{ "error": string }` | Handler-level failure outside normal step outcomes. |
| Archive sink unwritable | `2xx` with failed `archive` step and non-terminal `status` | No destructive step ran; the session stays retryable (FR-007a). |
| Deferred cleanup (steward unverified) | `2xx` with `status: "tearing-down"` | **Consumers MUST inspect `status`.** A 2xx alone MUST NOT be read as confirmed teardown; `src/legate/loop/clients/brood.ts` currently returns `ok: true` for any 200 and drops the session from loop state, which this contract makes non-conformant (SD-006). |

### TeardownSubstrate

**Purpose**: Reclaim substrate-specific compute and workspace artifacts.
**Consumers**: Brood teardown service.
**Providers**: Host substrate, future orchestrator substrates.

#### Signature

```text
removeSpawn(spawnId: string, opts?: { mode: "graceful" | "immediate", stopTimeoutSeconds?: number }): void

removeWorkspace(
  repoRoot: string,
  target: {
    worktreePath?: string,
    branch?: string
  }
): RemoveWorktreeResult
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spawnId` | string | Yes | Spawn compute identity. Compute is keyed off the session id (the container *name* is derived from it), NOT off the tracked `containerId` — that field feeds log capture only. |
| `mode` | `graceful \| immediate` | No | Stop semantics the caller requires: `graceful` stops before removal (FR-004), `immediate` removes at once (FR-005). **Not yet in the shipped interface** — the host provider calls `docker rm -f` unconditionally, so every teardown is `immediate` today (SD-004). A provider that cannot honour `graceful` MUST signal that rather than silently downgrading. |
| `stopTimeoutSeconds` | number | No | Bound on the graceful stop before escalation, per the enforced-deadline requirement (FR-020a). |
| `repoRoot` | absolute path | Yes | Repository root for workspace operations. |
| `worktreePath` | absolute path | No | Exact worktree path to remove. |
| `branch` | git ref name | No | Exact branch to delete. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `worktreeRemoved` | boolean | Whether the exact worktree path was removed. |
| `branchDeleted` | boolean | Whether the exact branch was deleted. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing artifact | No-op or false flag | Idempotent absence. |
| Substrate failure | Throw or false flag | Brood records failed step/warning. |
| Broad cleanup requested | Contract violation | Implementations must not enumerate/prune unrelated workspaces. |
| Call-out exceeds its deadline | Failed step outcome | Every substrate operation MUST be deadline-bounded; a wedged daemon or git lock MUST NOT block the service (FR-020a). |
| Non-`spawn` row tracking compute | Must be defined, not skipped | A `legate` row with a tracked container MUST have it reclaimed or the teardown refused — never a skipped step plus `torndown` (FR-012a, SD-005). |

### Castra Steward Removal

**Purpose**: Verify and remove the interactive steward session before Brood removes the shared worktree.
**Consumers**: Brood teardown service.
**Providers**: Castra client/gateway.

#### Signature

```text
removeSteward({
  sessionId: string,
  profile?: string,
  worktreePath?: string,
  branch?: string
}): Promise<StewardRemovalResult>
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | string | Yes | Tracked or resolved steward session id. |
| `profile` | string | No | Castra profile. |
| `worktreePath` | absolute path | No | Exact worktree match key. |
| `branch` | git ref name | No | Fallback match key when no worktree is known. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `outcome` | `removed \| absent \| failed` | Verified steward removal state. |
| `detail` | string | Bounded diagnostic. |
| `removedIds` | string[] | Real Castra ids removed. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Castra unreachable | `failed` | Brood defers worktree and branch removal. |
| No matching session and Castra reachable | `absent` | Verified gone; Brood may proceed. |
| Remove call fails | `failed` | Brood defers worktree and branch removal. |

### Teardown Archive Writer

**Purpose**: Preserve teardown evidence before runtime artifact deletion.
**Consumers**: Brood teardown service, Brood logs/read surfaces.
**Providers**: Brood archive filesystem.

#### Signature

```text
writeTeardownArchive(
  session: SessionRecord,
  group: {
    spawn?: SessionRecord,
    steward?: SessionRecord
  }
): {
  recordJsonPath: string,
  containerLogPath?: string,
  artifactPaths: string[],
  warnings: string[]
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session` | SessionRecord | Yes | Primary teardown target. |
| `spawn` | SessionRecord | No | Owning spawn row, when applicable. |
| `steward` | SessionRecord | No | Associated steward row, when applicable. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `recordJsonPath` | string | Path to the archived registry snapshot. |
| `containerLogPath` | string | Path to archived logs when written. |
| `artifactPaths` | string[] | Known structured extraction artifacts copied. |
| `warnings` | string[] | Missing/unreadable optional sources. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Archive directory cannot be created, or `record.json` cannot be written | Failed archive step that **aborts teardown** | The sink is unusable, so no destructive step runs and the session stays retryable (FR-007a). |
| Container logs unavailable | Warning | Optional *source*; later cleanup continues. |
| Extraction artifact unavailable | Warning | Optional *source*; later cleanup continues. |

## Events / Hooks

| Event / Hook | Trigger | Payload | Notes |
|--------------|---------|---------|-------|
| `brood.teardown` span | Accepted teardown request | Session id, kind, spawn id, steward id, bounded artifact identity attributes | Child of inbound trace context when provided. |
| `brood.teardown.<step>` span/event | Each cleanup step | Step name, normalized outcome, bounded detail | Failed steps mark the child span errored. |
| `march_brood_teardowns_total` / duration metric | Teardown completion | Kind, outcome, profile, duration | Low cardinality only; no session ids, paths, branches, or concrete request paths. |

## Integration Boundaries

| Boundary | Direction | Contract | Failure Mode |
|----------|-----------|----------|--------------|
| March CLI -> Brood service | outbound HTTP | `POST /sessions/:id/teardown` | Non-zero client error; no local cleanup fallback. Exits non-zero for any `status != "torndown"`. |
| Legate loop -> Brood service | outbound HTTP | Same endpoint with trace context, **discriminating on `status`** | Deferred or failed cleanup stays observable in one slice trace and MUST keep the session in loop state until `torndown` (SD-006). |
| Brood service -> SessionRepository | read/write registry | Resolve group, mark `tearing-down`, mark `torndown`, preserve row | Store errors surface as handler failures. |
| Brood service -> archive filesystem | write before delete | Record/log/artifact snapshot | Unwritable sink aborts teardown before deletion; missing optional source is a warning. |
| Brood service -> TeardownSubstrate | side-effecting cleanup | Remove tracked compute/workspace artifacts only | Failed or skipped step; no broad pruning. |
| Brood service -> Castra | outbound HTTP | Verify/remove steward with `pruneWorktree=false` | `failed` defers worktree/branch cleanup. |
| Brood service -> Observability | spans/metrics/logs | Teardown and step outcomes | Missing/incorrect span is a telemetry gap. |
