# Hatchery Service Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Hatchery exposes an open HTTP API for spawn job submission and lookup. Bodies are JSON.

### `GET /healthz`

| Field | Contract |
|-------|----------|
| Method and path | `GET /healthz` |
| Request envelope | No params, query, or body. |
| Response envelope | `200` with `{ "status": "ok" }`. |
| Visible status or error behavior | Basic process health only; this route does not report dependency readiness. |

### `GET /readyz`

| Field | Contract |
|-------|----------|
| Method and path | `GET /readyz` |
| Request envelope | No params, query, or body. |
| Response envelope | `{ "ready": boolean, "docker": boolean, "castra": boolean }`. |
| Visible status or error behavior | Returns `200` when `ready` is true; returns `503` when Docker or Castra is unavailable. |

Readiness dependencies:

| Field | Meaning | Gates readiness |
|-------|---------|-----------------|
| `docker` | Docker is available to run sibling spawn containers. | Yes |
| `castra` | Castra is reachable for steward session handoff. | Yes |

### `POST /spawns`

| Field | Contract |
|-------|----------|
| Method and path | `POST /spawns` |
| Request envelope | JSON body with the spawn request fields below. |
| Response envelope | `202` with `{ "id": string, "status": "pending" }`. The `id` is the Hatchery job id. |
| Visible status or error behavior | Validation failures return `400` with `{ "error": string }`. Accepted jobs run asynchronously and are inspected through `GET /spawns/:id`. |

Spawn request body:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `prompt` | string | Yes | Prompt handed to the spawn backend. Must contain non-whitespace text. |
| `backend` | string | Yes | Registered backend name resolved server-side. Trimmed; must contain non-whitespace text. |
| `repoPath` | absolute path string | Yes | Repository path valid inside the Hatchery container bind mount. Trimmed; must contain non-whitespace text. |
| `agentDeckProfile` | string | No | Agent-deck profile for manager session launch. |
| `managerGroup` | string | No | Manager group metadata. |
| `title` | string | No | Human-readable job title. |
| `branch` | string | No | Branch metadata. |
| `profile` | string | No | Deployment profile metadata. |
| `taskType` | string | No | Smithy task type metadata. |
| `taskName` | string | No | Smithy task name metadata. |
| `sliceId` | string | No | Smithy slice correlation id. |
| `toolchain` | string | No | Toolchain selection. `auto` or absent lets Hatchery detect the stack; explicit values must be in Hatchery's allow-list. |

### `GET /spawns/:id`

| Field | Contract |
|-------|----------|
| Method and path | `GET /spawns/:id` |
| Request envelope | Path param `id` is the Hatchery job id returned by `POST /spawns`. No query or body. |
| Response envelope | `200` with the job record envelope below. |
| Visible status or error behavior | Unknown job ids return `404` with `{ "error": string }`. |

Job record response:

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Hatchery job id. |
| `status` | `pending` \| `running` \| `succeeded` \| `failed` | Current job status. |
| `createdAt` | ISO timestamp string | Time the job was accepted. |
| `startedAt` | ISO timestamp string | Present after execution starts. |
| `finishedAt` | ISO timestamp string | Present after execution reaches a terminal status. |
| `result.spawnId` | string | Inner spawn id, present on success. |
| `result.backend` | string | Backend name that produced the spawn. |
| `result.branch` | string | Spawn branch. |
| `result.managerSession` | object | Manager session id, title, group, branch, and worktree path. |
| `result.artifacts` | object | Artifact directory and spawn output, patch, manager prompt, and metadata paths. |
| `result.exitCode` | number | Spawn worker exit code. |
| `result.summary` | string | Spawn summary. |
| `error.message` | string | Present when execution fails. |

## Invariants

- The service accepts a spawn request only after `prompt`, `backend`, and `repoPath` are present and usable by the HTTP boundary.
- `POST /spawns` creates an in-memory job and returns before the spawn worker reaches a terminal state.
- Job status is one of `pending`, `running`, `succeeded`, or `failed`.
- A successful job record exposes `result`; a failed job record exposes `error.message`.
- Terminal job records may be evicted after the service's retention window, after which lookup is treated as an unknown job id.
- `/readyz` is the dependency gate for useful service work; `/healthz` is only a basic process-health route.

## Error Modes

| Condition | Route | Response | Observable behavior |
|-----------|-------|----------|---------------------|
| Missing prompt | `POST /spawns` | `400` with `{ "error": string }` | The body has no string `prompt` with non-whitespace content. |
| Missing backend | `POST /spawns` | `400` with `{ "error": string }` | The trimmed `backend` is empty (absent, non-string, or whitespace-only). |
| Unknown backend | `POST /spawns` | `400` with `{ "error": string }` | The backend name is not registered; the message includes supported backend names. |
| Missing repo path | `POST /spawns` | `400` with `{ "error": string }` | The trimmed `repoPath` is empty (absent, non-string, or whitespace-only). |
| Invalid toolchain | `POST /spawns` | `400` with `{ "error": string }` | A provided `toolchain` is not one of Hatchery's allowed selections. |
| Unknown job id | `GET /spawns/:id` | `404` with `{ "error": string }` | No retained job record exists for the requested id. |
| Readiness dependency unavailable | `GET /readyz` | `503` with `{ "ready": false, "docker": boolean, "castra": boolean }` | At least one readiness dependency is false. |
