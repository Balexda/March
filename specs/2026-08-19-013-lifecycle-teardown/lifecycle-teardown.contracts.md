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
| `--kill` | boolean | No | Immediate kill mode; stronger than graceful forced teardown. |
| `--reason` | string | No | Human-readable reason recorded as failure context. |
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
| Partial cleanup | Success or non-zero per existing CLI convention with TeardownResult | Step outcomes and warnings identify incomplete work. |

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
| `kill` | boolean | No | Immediate kill mode. |
| `reason` | string | No | Failure-context note. |
| `traceparent` | string | No | Parent trace context. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Primary session id for the teardown group. |
| `status` | SessionStatus | `torndown` on verified completion or `tearing-down` on deferred cleanup. |
| `steps` | TeardownStep[] | Ordered archive/container/steward/worktree/branch outcomes. |
| `warnings` | string[] | Non-fatal diagnostics. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Unknown id | `404` `{ "error": string }` | No tracked session. |
| Running/created spawn without force | `409` `{ "error": string }` | No cleanup started. |
| Unexpected teardown failure | `500` `{ "error": string }` | Handler-level failure outside normal step outcomes. |

### TeardownSubstrate

**Purpose**: Reclaim substrate-specific compute and workspace artifacts.
**Consumers**: Brood teardown service.
**Providers**: Host substrate, future orchestrator substrates.

#### Signature

```text
removeSpawn(spawnId: string): void

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
| `spawnId` | string | Yes | Spawn compute identity. |
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
| Archive directory cannot be created | Failed archive step | Teardown records failure and warning. |
| Container logs unavailable | Warning | Later cleanup continues. |
| Extraction artifact unavailable | Warning | Later cleanup continues. |

## Events / Hooks

| Event / Hook | Trigger | Payload | Notes |
|--------------|---------|---------|-------|
| `brood.teardown` span | Accepted teardown request | Session id, kind, spawn id, steward id, bounded artifact identity attributes | Child of inbound trace context when provided. |
| `brood.teardown.<step>` span/event | Each cleanup step | Step name, normalized outcome, bounded detail | Failed steps mark the child span errored. |
| `march_brood_teardowns_total` / duration metric | Teardown completion | Kind, outcome, profile, duration | Low cardinality only; no session ids, paths, branches, or concrete request paths. |

## Integration Boundaries

| Boundary | Direction | Contract | Failure Mode |
|----------|-----------|----------|--------------|
| March CLI -> Brood service | outbound HTTP | `POST /sessions/:id/teardown` | Non-zero client error; no local cleanup fallback. |
| Legate loop -> Brood service | outbound HTTP | Same endpoint with trace context | Deferred or failed cleanup stays observable in one slice trace. |
| Brood service -> SessionRepository | read/write registry | Resolve group, mark `tearing-down`, mark `torndown`, preserve row | Store errors surface as handler failures. |
| Brood service -> archive filesystem | write before delete | Record/log/artifact snapshot | Warning or failed archive step. |
| Brood service -> TeardownSubstrate | side-effecting cleanup | Remove tracked compute/workspace artifacts only | Failed or skipped step; no broad pruning. |
| Brood service -> Castra | outbound HTTP | Verify/remove steward with `pruneWorktree=false` | `failed` defers worktree/branch cleanup. |
| Brood service -> Observability | spans/metrics/logs | Teardown and step outcomes | Missing/incorrect span is a telemetry gap. |
