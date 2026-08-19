# Data Model: Lifecycle Teardown
<!-- applicability: code-shaped features only -->

## Entities

### 1) SessionRecord (`brood_session`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Yes | Stable teardown target; may identify a spawn, steward, or legate row. |
| `kind` | `spawn \| steward \| legate` | Yes | Selects which cleanup steps apply. |
| `status` | SessionStatus | Yes | `created` / `running` require force for spawn teardown; `torndown` is idempotent no-op state. |
| `parentId` | string | No | Links steward rows to their owning spawn. |
| `repoPath` | absolute path | No | Required for worktree and branch cleanup. |
| `worktreePath` | absolute path | No | Exact path cleanup key; never replaced by broad pruning. |
| `branch` | git ref name | No | Exact branch cleanup key. |
| `containerId` | string | No | Source for container log capture and compute cleanup. |
| `agentDeckSessionId` | string | No | Steward removal target; may be stale and verified through Castra listing. |
| `profile` | string | No | Castra profile used for steward session lookup/removal. |
| `group` | string | No | Castra group context when available. |
| `failureReason` | string | No | May record operator-supplied teardown reason. |
| `torndownAt` | ISO timestamp | No | Set only when teardown reaches verified terminal cleanup. |

Validation rules:
- Teardown MUST NOT delete the SessionRecord.
- Worktree and branch cleanup MUST use only recorded exact values.
- Missing optional cleanup fields produce skipped steps, not guessed targets.
- A steward-row target resolves to its parent spawn group when `parentId` exists.

### 2) TeardownRequest (`teardown_request`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `force` | boolean | No | Required to tear down `created` or `running` spawn rows. |
| `kill` | boolean | No | Immediate kill semantics; valid only as an explicit stronger mode. |
| `reason` | string | No | Operator/automation reason recorded as failure context. |

Validation rules:
- Omitted booleans default to false.
- `kill=true` MUST imply permission to tear down a running spawn only when paired with accepted force semantics.
- `reason` is bounded to a human-readable diagnostic string by the service boundary.

### 3) TeardownArchive (`brood_teardown_archive`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `sessionId` | string | Yes | Archive directory key. |
| `recordSnapshot` | JSON object | Yes | Registry snapshot written as `record.json`. |
| `containerLog` | text | No | Written as `container.log` when logs are available. |
| `artifacts` | file set | No | Only known structured extraction artifact(s), not full worktree contents. |
| `warnings` | string[] | No | Archive-source failures carried into TeardownResult warnings. |

Validation rules:
- Archive creation runs before artifact deletion.
- Archive content MUST NOT include a recursive copy of the worktree.
- Missing logs or extraction artifacts do not block later cleanup.

### 4) TeardownStep (`teardown_step`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `step` | `archive \| container \| steward \| worktree \| branch` | Yes | Ordered cleanup stage. |
| `outcome` | `ok \| skipped \| failed` | Yes | Step result returned to CLI/API callers. |
| `detail` | string | No | Bounded diagnostic for skipped or failed outcomes. |

Validation rules:
- Steps are returned in execution order.
- Failed steps are visible in the response and trace.
- Deferred worktree/branch cleanup is represented as skipped with diagnostic detail after unverified steward removal.

### 5) TeardownResult (`teardown_result`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Yes | Primary session id for the teardown group. |
| `status` | SessionStatus | Yes | `torndown` only after verified terminal cleanup; `tearing-down` for deferred cleanup. |
| `steps` | TeardownStep[] | Yes | Ordered step results. |
| `warnings` | string[] | Yes | Non-fatal archive or cleanup diagnostics. |

Validation rules:
- Already `torndown` sessions return success with no cleanup work.
- Any unverified steward removal prevents terminal `torndown` status.
- A partial result MUST remain retryable.

### 6) StewardRemovalResult (`steward_removal_result`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `outcome` | `removed \| absent \| failed` | Yes | Verified Castra result. |
| `detail` | string | No | Bounded diagnostic. |
| `removedIds` | string[] | Yes | Real Castra session ids removed. |

Validation rules:
- `removed` and `absent` permit worktree/branch cleanup.
- `failed` defers worktree/branch cleanup.
- `absent` requires reachable Castra and verified non-presence.

## Relationships

| From | To | Cardinality | Notes |
|------|----|-------------|-------|
| SessionRecord | SessionRecord | 1:0..1 | Steward row may point to parent spawn via `parentId`. |
| SessionRecord | TeardownArchive | 1:0..1 | Archive created for teardown target before cleanup. |
| TeardownRequest | TeardownResult | 1:1 | One request produces one ordered result. |
| TeardownResult | TeardownStep | 1:N | Steps appear in logical teardown order. |
| SessionRecord | StewardRemovalResult | 1:0..1 | Present when a steward row is associated with the teardown group. |

## State Transitions

| Entity | Transition | Trigger | Effects |
|--------|------------|---------|---------|
| SessionRecord | `created` / `running` -> conflict | Teardown without force | No cleanup steps execute. |
| SessionRecord | any non-`torndown` -> `tearing-down` | Accepted teardown request | Group enters retryable cleanup-in-progress state. |
| SessionRecord | `tearing-down` -> `torndown` | Container/steward/worktree/branch cleanup reaches verified terminal state | `torndownAt` is recorded; registry row remains. |
| SessionRecord | `tearing-down` -> `tearing-down` | Steward removal failed or unverified | Worktree/branch deferred; retry can continue later. |
| SessionRecord | `torndown` -> `torndown` | Repeated teardown request | No-op success. |
| TeardownArchive | missing -> created | Archive step succeeds | Record/log/artifact evidence is preserved. |
| TeardownStep | pending -> ok/skipped/failed | Step execution | Result is returned and observed in telemetry. |

## Identity & Uniqueness

| Entity | Identity | Uniqueness Rule |
|--------|----------|-----------------|
| SessionRecord | `id` | One registry row per managed session. |
| TeardownArchive | `sessionId` | One archive directory per primary teardown target. |
| TeardownResult | request invocation + primary `id` | Not persisted as a durable entity. |
| TeardownStep | result order + `step` | At most one outcome per logical step in a result. |
| StewardRemovalResult | steward identity + request invocation | Not persisted; determines same-request continuation. |
