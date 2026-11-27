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
| Response envelope | The readiness body below (snake_case). |
| Visible status or error behavior | Returns `200` when `state` is `ok` or `degraded`; returns `503` when `state` is `down`. |

Readiness answers "can Hatchery spawn right now", not "is the process up". It
closes the 2026-11-22 outage, where every spawn failed `tessera:unconfigured`
for five hours while `/healthz` and the old `/readyz` (docker + castra only)
stayed green.

```json
{
  "ready": true,
  "state": "ok",
  "docker": true,
  "castra": true,
  "github": { "ok": true, "source": "tessera", "reason": null },
  "spawns": {
    "recent": 20, "failed": 0, "consecutive_failures": 0,
    "last_error": null, "last_error_at": null,
    "last_success_at": "2026-11-22T12:00:00.000Z"
  },
  "reasons": []
}
```

| Field | Meaning |
|-------|---------|
| `ready` | `state != "down"`. Kept for older readers. |
| `state` | `ok` \| `degraded` \| `down`, derived from the checks below. |
| `docker` | Docker is available to run sibling spawn containers. |
| `castra` | Castra is reachable for steward session handoff. |
| `github.ok` / `github.source` | Whether a spawn can get a GitHub app/read credential. Tessera is the only supported source. `ok` is true only when Tessera is configured (`MARCH_TESSERA_URL` and a client key from `MARCH_TESSERA_CLIENT_KEY_FILE` or `MARCH_TESSERA_CLIENT_KEY`), reachable, its `github-app` provider reports `ok`, and Tessera accepts Hatchery's own key with an app grant of `read` (or `write`) access. Hatchery checks the provider with the unauthenticated `GET /status` and its own key and policy with the authenticated `GET /v1/client`, both in parallel with a 1.5 s timeout. The answer is cached for 5 s (re-checked at once if the key changes), so `/readyz` never hangs and mints nothing. `source` is `tessera` when Tessera is configured, `fallback` when only the ambient-token fallback (`MARCH_TESSERA_GH_TOKEN_FALLBACK=1` with `GH_TOKEN`/`GITHUB_TOKEN`) is set, and otherwise `none`. A `fallback` source is never `ok`. |
| `github.reason` | `null` when `ok` is true. Otherwise one of: `tessera:unconfigured`, `tessera:unreachable` (no answer, or an answer other than 200), `tessera:provider_<state>` (the `github-app` provider is `unconfigured`, `degraded` or `invalid`), `tessera:unauthorized` (Tessera rejects Hatchery's key), `tessera:policy_denied` (Hatchery's grants hold no app read access), `tessera:invalid_response` (the client check got an unrecognizable answer, for example from a Tessera without `GET /v1/client`), or `using ambient GH_TOKEN instead of Tessera (fallback is not a supported credential path)`. |
| `spawns` | In-memory rolling window over the last 20 finished jobs: `recent` and `failed` counts, `consecutive_failures` since the last success, and `last_error`, which is a low-cardinality reason code (a Hatchery GitHub code such as `tessera:unconfigured`, or one of `worker_exit`, `patch_apply_failed`, `branch_collision`, `castra_error`, `docker_error`, `timeout`, `other`). Also `last_error_at` and `last_success_at` (ISO, or `null`). A restart resets the window. |
| `reasons` | One human sentence per failing check. Empty when `state` is `ok`. |

State rules:

| State | When |
|-------|------|
| `down` | `docker` is false, or `castra` is false, or `github.ok` is false (including when Tessera is not running or cannot vend credentials), or `consecutive_failures >= 5`. |
| `degraded` | Not down, and `consecutive_failures >= 2`. |
| `ok` | Otherwise. |

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
| `backend` | string | Yes | Registered backend name resolved server-side. |
| `repoPath` | absolute path string | Yes | Repository path valid inside the Hatchery container bind mount. |
| `agentDeckProfile` | string | No | Agent-deck profile for manager session launch. |
| `managerGroup` | string | No | Manager group metadata. |
| `title` | string | No | Human-readable job title. |
| `branch` | string | No | Branch metadata. |
| `baseBranch` | string | No | Preferred GitHub PR base. If absent or missing on GitHub, resolve the repository's default branch. |
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
| `result.application` | object | Verified patch application with `spawnId`, `status: "applied"`, `touchedPaths`, and `appliedAt`. |
| `result.commit` | object | Published `IntegrationCommit` with `spawnId`, exact `branch`, `commitSha`, `patchSha256`, and `committedAt`. |
| `result.pullRequestPublication` | object | Terminal PR result. `succeeded` carries a GitHub `pullRequest` record. `failed` carries `failureReason`, the pushed `branch` and `commit`, and a bounded `diagnostic`. Base failures may also carry `existingPullRequest`. |
| `error.publication` | object | Bounded `commit_failed`, `push_failed`, or `timeout` with the spawn ID, recorded branch, patch digest, and local commit when available. |
| `error.message` | string | Present when execution fails. |
| `error.application` | object | Present when the Steward apply path fails. Includes `spawnId`, `status: "failed"`, `touchedPaths`, and a bounded `diagnostic` code. |

Hatchery binds publication to the Brood-recorded linked checkout. It checks the
branch tip for a commit representing the same spawn and patch, then compares
the staged tree with the result of replaying the validated patch against the
parent before creating a commit. GitHub publication uses the existing Steward
Tessera credential scoped to the origin repository. The Steward receives the
review and PR prompt only after the recorded remote branch is published or
verified equivalent. A publication failure preserves a verified local commit
and its checkout for retry. A later dispatch of the slice that collides with
that preserved branch at manager launch resumes it, but only when the prior
spawn record's `admittedWork` (slice id, prompt sha256, backend) matches the
current dispatch. Hatchery re-verifies the commit against the prior spawn's
recorded extraction and pushes it again using the existing Steward session.
A successful push records the branch as the checkout's upstream and binds PR
publication to that same GitHub origin. Hatchery reuses an open PR only when
both repositories, the exact source branch and the resolved base match. A
different base yields `base_mismatch`, while an unresolved base yields
`base_unresolved`. Closed PRs do not block a fresh PR. A fresh PR requires a
bounded review receipt from the Castra Steward. Hatchery uses validated spawn
facts and receipt status for the body, and rechecks the exact open PR identity
after an ambiguous creation response. The result reports PR failure even
when the spawn job itself completes with a pushed commit. Git and PR phases
are bounded and traced on the slice. [March vision](../../vision.md) ·
[Operating philosophy](../../operating-philosophy.md).

## Invariants

- The service accepts a spawn request only after `prompt`, `backend`, and `repoPath` are present and usable by the HTTP boundary.
- `POST /spawns` creates an in-memory job and returns before the spawn worker reaches a terminal state.
- Job status is one of `pending`, `running`, `succeeded`, or `failed`.
- A successful job record exposes `result`; a failed job record exposes `error.message`.
- Terminal job records may be evicted after the service's retention window, after which lookup is treated as an unknown job id.
- `/readyz` is the dependency gate for useful service work; `/healthz` is only a basic process-health route. The container healthcheck uses `/healthz`, so a credential outage never restart-loops Hatchery.

## Error Modes

| Condition | Route | Response | Observable behavior |
|-----------|-------|----------|---------------------|
| Missing prompt | `POST /spawns` | `400` with `{ "error": string }` | The body has no string `prompt` with non-whitespace content. |
| Missing backend | `POST /spawns` | `400` with `{ "error": string }` | The body has no non-empty string `backend`. |
| Unknown backend | `POST /spawns` | `400` with `{ "error": string }` | The backend name is not registered; the message includes supported backend names. |
| Missing repo path | `POST /spawns` | `400` with `{ "error": string }` | The body has no non-empty string `repoPath`. |
| Invalid toolchain | `POST /spawns` | `400` with `{ "error": string }` | A provided `toolchain` is not one of Hatchery's allowed selections. |
| Unknown job id | `GET /spawns/:id` | `404` with `{ "error": string }` | No retained job record exists for the requested id. |
| Readiness down | `GET /readyz` | `503` with the readiness body, `state: "down"`, `ready: false` | Docker or Castra is unavailable, Tessera cannot give Hatchery a GitHub credential, or the last 5 or more spawns failed. `reasons` names each cause. |

### GitHub base pinning and branch collisions

Hatchery resolves the steward worktree's GitHub origin locally and requests
Tessera `app/read` for that repository before fetching. GitHub SSH origins are
fetched over HTTPS with credentials scoped to the fetch child. The pin only
resets to a descendant of the steward's current HEAD. Collision checks use
scoped access for GitHub ref and PR lookups. Issuance or lookup failure leaves
the colliding branch in place and fails the job on its slice trace. Local
origins and repositories without an origin require no entitlement.

Set `MARCH_TESSERA_URL` and Hatchery's client key, either as
`MARCH_TESSERA_CLIENT_KEY_FILE` (which takes precedence) or as
`MARCH_TESSERA_CLIENT_KEY`. The Hatchery compose file points
`MARCH_TESSERA_CLIENT_KEY_FILE` at `~/.march/tessera/keys/hatchery.key`, which
`march tessera provision` writes; `MARCH_TESSERA_HATCHERY_CLIENT_KEY_FILE`
overrides the path. Compose forwards no `GH_TOKEN`/`GITHUB_TOKEN` and leaves
the token fallback off: Tessera is the only credential source.
