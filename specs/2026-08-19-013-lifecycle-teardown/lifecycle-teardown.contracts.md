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
type ComputeTarget = {
  sessionId: string,
  kind: "spawn" | "legate" | string,   // any kind that launches an ephemeral container
  containerName: string                 // derived per kind from sessionId; never a shared service container
}

stopCompute(target: ComputeTarget, opts?: { stopTimeoutSeconds?: number }): StopComputeResult   // target, not yet shipped (SD-004)

removeCompute(target: ComputeTarget): void   // shipped today as spawn-only removeSpawn(spawnId)

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
| `target` | ComputeTarget | Yes | Kind-agnostic compute identity (FR-012a). `containerName` is derived from `sessionId` by a per-kind rule (`spawnContainerName` for spawns), NOT taken from the tracked `containerId`, which feeds log capture only. Brood MUST refuse to build a target that resolves to a shared compose service container. |
| `stopTimeoutSeconds` | number | No | `stopCompute` only. Bound on the graceful stop before escalation, per the enforced-deadline requirement (FR-020a). |
| `repoRoot` | absolute path | Yes | Repository root for workspace operations. |
| `worktreePath` | absolute path | No | Exact worktree path to remove. |
| `branch` | git ref name | No | Exact branch to delete. |

Graceful and immediate teardown are **two separate operations** so the archive can run between them (FR-006a):

- **`stopCompute`** (target, FR-004): stops the container gracefully and leaves it present, so its final logs and structured output stay readable for the archive. It MUST NOT remove the container. A provider that cannot stop gracefully MUST report `stopped: false` (or throw) rather than silently removing. Skipped when the request includes `kill`.
- **`removeCompute`** (shipped as spawn-only `removeSpawn`): removes the container immediately. Brood calls it only after the archive succeeds. It MUST throw on any failure other than "no such container" and MUST verify the container is gone before returning, so teardown can report a failed `container` step (FR-012b). The current host provider swallows every failure; the never-throws helper stays only on dispatch rollback. Called without a prior `stopCompute`, this is the `kill` path (FR-005). Today it is the only operation: the host provider runs `docker rm -f` unconditionally, so every teardown is immediate (SD-004).

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `stopped` | boolean | `stopCompute`: whether the container reached a stopped state within `stopTimeoutSeconds`. |
| `escalated` | boolean | `stopCompute`: whether the stop deadline was hit and the provider escalated to a kill. FR-005a forbids reporting a graceful outcome in that case. |
| `worktreeRemoved` | boolean | Whether the exact worktree path was removed. |
| `branchDeleted` | boolean | Whether the exact branch was deleted. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing artifact | No-op or false flag | Idempotent absence. |
| Substrate failure | Throw or false flag | Brood records failed step/warning. |
| Broad cleanup requested | Contract violation | Implementations must not enumerate/prune unrelated workspaces. |
| Call-out exceeds its deadline | Failed step outcome | Every substrate operation MUST be deadline-bounded; a wedged daemon or git lock MUST NOT block the service (FR-020a). |
| Non-`spawn` row tracking an ephemeral container | Reclaimed via `removeCompute` | Every ephemeral per-session container is reclaimed; never refused, never a skipped step plus `torndown` (FR-012a). |
| Target resolves to a shared compose service container | Refused, failed `container` step | Service containers are not session compute (FR-012a). |

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

appendTeardownAttempt(sessionId: string, entry: TeardownAttempt): void
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
| `recordJsonPath` | string | Path to the pre-teardown registry snapshot. Written only when absent (FR-008). |
| `containerLogPath` | string | Path to archived logs when written. |
| `artifactPaths` | string[] | `artifacts/extraction-result.json` and, for succeeded results, `artifacts/spawn.patch` (FR-010). |
| `warnings` | string[] | Missing/unreadable optional sources. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Archive directory cannot be created, or any archive write (`record.json`, `container.log`, extraction artifact) fails | Failed archive step that **aborts teardown** | The sink is unusable, so no destructive step runs and the session stays retryable (FR-007a). |
| Container logs unreadable | Warning | Optional *source*; later cleanup continues. Readable logs that fail to write are the sink failure above. |
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
| Legate loop -> Brood service | outbound HTTP | Same endpoint with trace context, **discriminating on `status`** | Deferred or failed cleanup stays observable in one slice trace and MUST keep the session in loop state until `torndown` (FR-014b). `broodTeardown` returns `ok` only on `status: torndown`. |
| Brood service -> SessionRepository | read/write registry | Resolve group, mark `tearing-down`, mark `torndown`, preserve row | Store errors surface as handler failures. |
| Brood service -> archive filesystem | write before delete | Record/log/artifact snapshot | Unwritable sink aborts teardown before deletion; missing optional source is a warning. |
| Brood service -> TeardownSubstrate | side-effecting cleanup | Remove tracked compute/workspace artifacts only | Failed or skipped step; no broad pruning. |
| Brood service -> Castra | outbound HTTP | Verify/remove steward with `pruneWorktree=false` | `failed` defers worktree/branch cleanup. |
| Brood service -> Observability | spans/metrics/logs | Teardown and step outcomes | Missing/incorrect span is a telemetry gap. |
