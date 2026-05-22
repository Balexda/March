# Contracts: Containerized-Service Contracts (Hatchery, Brood, Herald, Castra)

## Overview

This feature creates documentation contracts for four existing Fastify services. The integration boundaries are the Markdown contract artifacts and the HTTP route surfaces those artifacts must document. No runtime API is introduced or changed by this feature.

## Interfaces

### Hatchery Service Contract

**Purpose**: Documents Hatchery's spawn-job submission and inspection API.
**Consumers**: Legate loop, CLI client, L2 tests, contract freshness checks.
**Providers**: `docs/subsystems/hatchery/contract.md`.

#### Signature

```text
GET  /healthz
GET  /readyz
POST /spawns
GET  /spawns/:id
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `POST /spawns.body.prompt` | string | Yes | Prompt handed to the spawn backend. |
| `POST /spawns.body.backend` | string | Yes | Backend name resolved server-side. |
| `POST /spawns.body.repoPath` | absolute path string | Yes | Repository path valid inside the Hatchery container bind mount. |
| `POST /spawns.body.agentDeckProfile` | string | No | Agent-deck profile for steward launch. |
| `POST /spawns.body.managerGroup` | string | No | Manager group metadata. |
| `POST /spawns.body.title` | string | No | Human-readable job title. |
| `POST /spawns.body.branch` | string | No | Branch metadata. |
| `POST /spawns.body.profile` | string | No | Spawn profile metadata. |
| `POST /spawns.body.taskType` | string | No | Smithy task type metadata. |
| `POST /spawns.body.taskName` | string | No | Smithy task name metadata. |
| `POST /spawns.body.sliceId` | string | No | Smithy slice correlation id. |
| `GET /spawns/:id.params.id` | string | Yes | Hatchery job id. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `/healthz.status` | string | Returns `ok` on basic service health. |
| `/readyz.ready` | boolean | True when Hatchery can use Docker and reach Castra. |
| `/readyz.docker` | boolean | Docker dependency availability. |
| `/readyz.castra` | boolean | Castra reachability. |
| `POST /spawns.id` | string | Server-generated job id. |
| `POST /spawns.status` | job status | Initial job status returned with HTTP 202. |
| `GET /spawns/:id` | job record | Full job record including status, timestamps, result, or error when known. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing prompt | 400 `{ error }` | Prompt is required. |
| Missing backend | 400 `{ error }` | Backend is required. |
| Unknown backend | 400 `{ error }` | Backend name is not registered. |
| Missing repo path | 400 `{ error }` | Repo path is required. |
| Unknown job id | 404 `{ error }` | No spawn job exists for the requested id. |
| Readiness dependency unavailable | 503 readiness body | `/readyz` reports false dependency fields. |

### Brood Service Contract

**Purpose**: Documents Brood's managed-session registry and teardown API.
**Consumers**: Hatchery, Legate loop, cleanup tools, L2 tests, contract freshness checks.
**Providers**: `docs/subsystems/brood/contract.md`.

#### Signature

```text
GET   /healthz
GET   /readyz
POST  /sessions
GET   /sessions
GET   /sessions/:id
PATCH /sessions/:id
POST  /sessions/:id/teardown
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `POST /sessions.body.id` | string | Yes | Spawn id, steward session id, or legate conductor name. |
| `POST /sessions.body.kind` | `spawn` \| `steward` \| `legate` | Yes | Managed session kind. |
| `POST /sessions.body.status` | lifecycle status | No | One of `created`, `running`, `stopped`, `failed`, `tearing-down`, `torndown`. |
| `POST /sessions.body.repoPath` | absolute path string | No | Source repository root. |
| `POST /sessions.body.worktreePath` | absolute path string | No | Exact tracked worktree path. |
| `POST /sessions.body.branch` | safe branch string | No | Exact tracked branch name. |
| `POST /sessions.body.*` | known session fields | No | Optional parent, container, agent-deck, profile, group, backend, image, exit, and failure fields. |
| `GET /sessions.query.kind` | session kind | No | List filter. |
| `GET /sessions.query.status` | lifecycle status | No | List filter. |
| `GET /sessions.query.parentId` | string | No | List filter. |
| `PATCH /sessions/:id.body.*` | mutable session fields | No | Status, artifact ids, paths, branch, profile, group, timestamps, and failure fields. |
| `POST /sessions/:id/teardown.body.force` | boolean | No | Allows teardown of a running or created spawn. |
| `POST /sessions/:id/teardown.body.kill` | boolean | No | Requests immediate container kill. |
| `POST /sessions/:id/teardown.body.reason` | string | No | Human-readable teardown reason. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `/healthz.status` | string | Returns `ok` on basic service health. |
| `/readyz.ready` | boolean | True when Docker and Git are available. |
| `/readyz.castra` | boolean | Best-effort Castra reachability probe. |
| `POST /sessions` | session record | Registered or updated session record. |
| `GET /sessions.sessions` | session record array | Filtered managed sessions. |
| `GET /sessions/:id` | session record | One managed session. |
| `PATCH /sessions/:id` | session record | Updated managed session. |
| `POST /sessions/:id/teardown` | teardown result | Final status, ordered step results, and warnings. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing id or invalid kind/status/path/branch | 400 `{ error }` | Register or update validation failed. |
| Unknown session id | 404 `{ error }` | Lookup, update, or teardown target is absent. |
| Running or created spawn without force | 409 `{ error }` | Destructive teardown is refused without explicit force. |
| Teardown step failure | 200 teardown result with failed step and warnings, or 500 `{ error }` for unexpected route failure | Cleanup attempts are reported step-by-step. |
| Steward removal failure | Teardown result remains `tearing-down`; worktree and branch steps are skipped | Cleanup defers exact worktree and branch removal until the steward is gone. |

### Herald Service Contract

**Purpose**: Documents Herald's event log, state projection, and observation status API.
**Consumers**: Legate loop, operator diagnostics, L2/L3 tests, contract freshness checks.
**Providers**: `docs/subsystems/herald/contract.md`.

#### Signature

```text
GET  /healthz
GET  /readyz
GET  /events
POST /events
GET  /state
GET  /state/delta
GET  /status
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `GET /events.query.after` | non-negative integer | No | Cursor; defaults to 0. |
| `GET /events.query.limit` | positive integer | No | Defaults to 100 and is capped at 1000. |
| `POST /events.body.type` | event type | Yes | Known event taxonomy discriminator. |
| `POST /events.body.sliceId` | string | Conditional | Required for slice-keyed event types. |
| `POST /events.body.sessionId` | string | Conditional | Required for `slice.steward.attached`; validated when present on session-aware transition events. |
| `POST /events.body.session.id` | string | Conditional | Required for `session.changed`. |
| `GET /state.query.at` | non-negative integer | No | Optional projection sequence. |
| `GET /state/delta.query.from` | non-negative integer | No | Start sequence; defaults to 0. |
| `GET /state/delta.query.to` | non-negative integer | No | End sequence; defaults to latest. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `/healthz.status` | string | Returns `ok` on basic service health. |
| `/readyz.ready` | boolean | True when Git, GitHub CLI, and Smithy are available. |
| `/readyz.castra` | boolean | Best-effort Castra reachability probe. |
| `GET /events.events` | event array | Events strictly after the cursor, up to the limit. |
| `GET /events.lastSeq` | number | Last returned sequence, or the input cursor when no events are returned. |
| `POST /events` | event envelope | Stored event with server-assigned sequence/id/timestamp when absent. |
| `GET /state` | system state | Current or as-of projection. |
| `GET /state/delta.events` | event array | Events in the requested inclusive range. |
| `GET /status` | status summary | Observation age/duration, event count, last sequence, workers, smithy, slice count, and state flags. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Invalid event type or required event key | 400 `{ error }` | Event taxonomy validation failed. |
| Invalid `after`, `limit`, `at`, `from`, or `to` | 400 `{ error }` | Query parameter is missing required numeric semantics. |
| `limit` is zero | 400 `{ error }` | Event reads require a positive limit. |
| `from` greater than `to` | 400 `{ error }` | Delta range is invalid. |
| Readiness dependency unavailable | 503 readiness body | `/readyz` reports false gating dependencies. |

### Castra Service Contract

**Purpose**: Documents Castra's HTTP API over agent-deck interactive sessions.
**Consumers**: Hatchery steward handoff, Herald observer, Legate babysit logic, L2 tests, contract freshness checks.
**Providers**: `docs/subsystems/castra/contract.md`.

#### Signature

```text
GET    /healthz
GET    /status
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:id
POST   /v1/sessions/:id/send
GET    /v1/sessions/:id/output
POST   /v1/sessions/:id/set
DELETE /v1/sessions/:id
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `Authorization` | bearer token | Required for `/v1/*` routes | API token for protected session routes. |
| `profile` | string | Yes on session routes | Agent-deck profile passed in query or body depending on route. |
| `group` | string | No | Session group filter or launch group. |
| `POST /v1/sessions.body.repoPath` | string | Yes | Worktree/repo path for launch. |
| `POST /v1/sessions.body.branch` | string | Yes | Branch name for launch. |
| `POST /v1/sessions.body.title` | string | Yes | Session title. |
| `POST /v1/sessions.body.model` | string | No | Optional model. |
| `POST /v1/sessions.body.createBranch` | boolean | No | Whether Castra should create a branch. |
| `POST /v1/sessions.body.metadata` | string map | No | Up to 16 entries, 64-character keys, 256-character values. |
| `POST /v1/sessions/:id/send.body.prompt` | string | Yes | Prompt sent to the interactive session. |
| `GET /v1/sessions/:id/output.query.lines` | integer | No | Number of output lines, 1 through 100000. |
| `POST /v1/sessions/:id/set.body.key` | settable key | Yes | Session field allowed by Castra. |
| `POST /v1/sessions/:id/set.body.value` | string | Yes | Value for the settable key. |
| `DELETE /v1/sessions/:id.query.pruneWorktree` | boolean | No | Whether Castra should prune the worktree; defaults false. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `/healthz.status` | string | Returns `ok` on basic service health. |
| `/status` | service status | Service name, CLI version, uptime, and agent-deck reachability. |
| `GET /v1/sessions.sessions` | session array | Matching interactive sessions. |
| `POST /v1/sessions.session` | Castra session | Created session with HTTP 201. |
| `GET /v1/sessions/:id.session` | Castra session | One interactive session. |
| `POST /v1/sessions/:id/send.ok` | boolean | Send acknowledgement with HTTP 202. |
| `GET /v1/sessions/:id/output` | output result | Adapter output shape for the requested session. |
| `POST /v1/sessions/:id/set.ok` | boolean | Set acknowledgement. |
| `DELETE /v1/sessions/:id.ok` | boolean | Removal acknowledgement. |
| `DELETE /v1/sessions/:id.removed` | boolean | Whether a session was removed. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing or invalid bearer token | 401 `{ error: { code: "unauthorized", message } }` | Protected route lacks valid authorization. |
| Malformed request field | 400 `{ error: { code: "invalid_request", message } }` | JSON schema or adapter validation failed. |
| Unknown route or session | 404 `{ error: { code: "not_found", message } }` | Route or requested session is absent. |
| Concurrent launch/worktree conflict | 409 `{ error: { code: "conflict", message } }` | Caller can retry rather than treating it as a permanent failure. |
| Agent-deck command failure | 502 `{ error: { code: "agent_deck_error", message } }` | Agent-deck exited non-zero or returned unparseable output. |
| Unexpected server error | 500 `{ error: { code: "internal", message } }` | Public body stays generic; detailed diagnostics remain server-side. |

## Events / Hooks

No new runtime events or hooks are introduced by this feature. Herald's existing event taxonomy is documented as part of the Herald service contract, but this feature does not add event types.

## Integration Boundaries

- **Hatchery -> Castra**: Hatchery readiness and steward launch depend on Castra reachability and session routes; this feature documents both sides' wire expectations without changing either service.
- **Brood -> Castra**: Brood teardown asks Castra to remove steward sessions without pruning worktrees, then owns exact worktree cleanup itself.
- **Legate -> Hatchery/Brood/Herald**: The loop submits work, observes job/session/event state, and later asserts those boundaries through documented route contracts.
- **Herald -> Castra**: Herald readiness/status may probe Castra and observe session state, but Castra remains the owner of the session API contract.
- **Future F5/F6/F7 tooling**: Presence/freshness checks and AUTOGEN extraction consume these contract artifacts but are outside this feature.
