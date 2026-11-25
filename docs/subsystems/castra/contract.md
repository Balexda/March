# Castra Service Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Castra exposes open process-health/status routes and a bearer-token-protected `/v1/*` JSON API for agent-deck session operations and live tmux inventory. Protected routes use `Authorization: Bearer <token>` and return the uniform error envelope documented in `## Error Modes` on non-2xx responses.

### `GET /healthz`

| Field | Contract |
|-------|----------|
| Method and path | `GET /healthz` |
| Request envelope | No headers, params, query, or body required. |
| Response envelope | `200` with `{ "status": "ok" }`. |
| Authentication behavior | Open; bearer token is not required. |
| Visible status or error behavior | Pure liveness only; this route does not report agent-deck reachability or session state. Docker's healthcheck uses it. Readiness is `GET /readyz`. |

### `GET /readyz`

| Field | Contract |
|-------|----------|
| Method and path | `GET /readyz` |
| Request envelope | No headers, params, query, or body required. |
| Response envelope | `{ "ready": boolean, "state": "ok" \| "degraded" \| "down", "reasons": string[], "event_loop_lag_ms": number, "refused_sessions": string[], "recent_send_failures": number }`. |
| Authentication behavior | Open; bearer token is not required. |
| Visible status or error behavior | `200` for `ok` and `degraded`, `503` for `down`. Built from Castra's in-memory state only, so the probe never waits on agent-deck. |

Readiness states:

| State | When |
|-------|------|
| `down` (`ready: false`) | Event-loop lag is over 2000 ms: the worst p99 of the consecutive 5-second sample windows in the last minute, including the window in progress (`event_loop_lag_ms`). A peak, not a whole-minute p99, because a frozen loop takes no samples while frozen, so a whole-minute p99 would hide repeated multi-second stalls. Requests are stalling. |
| `degraded` | At least one session is in its composer-refusal cooldown (listed in `refused_sessions`), or 3 or more sends failed in the last 5 minutes (`recent_send_failures`; a `not_found` send is not a failure). |
| `ok` | Neither of the above. |

`reasons` holds one human-readable sentence per condition found. `refused_sessions` holds session ids, sorted.

### `GET /status`

| Field | Contract |
|-------|----------|
| Method and path | `GET /status` |
| Request envelope | No headers, params, query, or body required. |
| Response envelope | `200` with `{ "service": "march-castra", "version": string, "uptimeSeconds": number, "agentDeck": { "reachable": boolean } }`. |
| Authentication behavior | Open; bearer token is not required. |
| Visible status or error behavior | Reports agent-deck reachability as data in the response body; a false `agentDeck.reachable` value does not change the HTTP status. |

### `GET /v1/interactive-sessions`

| Field | Contract |
| --- | --- |
| Request | `GET /v1/interactive-sessions` with `Authorization: Bearer <token>` when authentication is configured. |
| Response | `200` with `{ "names": string[] }`. Names are unprefixed suffixes of live `march/<name>` sessions on Castra's tmux server. |
| Empty result | A healthy tmux installation with no running server or no eligible sessions returns `200` with `{ "names": [] }`. |
| Failure | Unauthorized requests return `401`. Missing tmux, socket permission errors, timeouts, and other tmux failures return `502` with code `tmux_error`. Unexpected service failures return `500`. |

`CastraClient.listInteractiveSessions()` returns the names and rejects failed
or malformed responses. The tmux call has a 3-second deadline and the client
request has a 5-second deadline.

### `GET /v1/sessions`

| Field | Contract |
|-------|----------|
| Method and path | `GET /v1/sessions` |
| Request envelope | Header `Authorization: Bearer <token>`. Query requires `profile`; optional `group` filters sessions by group. `profile` and `group` are identifiers up to 64 characters that start with an alphanumeric character and then contain only alphanumerics, dots, underscores, or hyphens. |
| Response envelope | `200` with `{ "sessions": CastraSession[] }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid query values return `400`; agent-deck list failures return `502`; unexpected failures return `500`. |

### `POST /v1/sessions`

| Field | Contract |
|-------|----------|
| Method and path | `POST /v1/sessions` |
| Request envelope | Header `Authorization: Bearer <token>`. JSON body requires `profile`, `repoPath`, `branch`, and `title`; optional fields are `group`, `model`, `createBranch`, and `metadata`. Body fields outside this set are ignored, not rejected. |
| Response envelope | `201` with `{ "session": CastraSession }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid bodies return `400`; concurrent launch/worktree races return `409`; agent-deck launch or session-identification failures return `502`; unexpected failures return `500`. |

Launch request body:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `profile` | identifier string | Yes | Agent-deck profile used for launch. |
| `repoPath` | non-empty string | Yes | Repository or worktree path passed to agent-deck. |
| `branch` | non-empty string | Yes | Branch/worktree name passed as the agent-deck `--worktree` value. |
| `title` | non-empty string | Yes | Session title. |
| `group` | identifier string | No | Agent-deck group. Defaults to Castra's default manager group when absent. |
| `model` | non-empty string | No | Agent model. Adapter defaults apply when absent. |
| `createBranch` | boolean | No | When false, attach to an existing worktree/branch; absent or true creates a branch. |
| `metadata` | string-to-string map | No | Queryable Castra-owned metadata returned on later session records. At most 16 entries, with keys up to 64 characters and values up to 256 characters. |

Castra runs `agent-deck launch --json` and takes the session from the
reported `session_id`. With an agent-deck that reports no id, Castra
serializes launches per profile and group, takes the new session from a
before/after list, and checks that its worktree belongs to the requested
repository (same `git rev-parse --git-common-dir`). A worktree from another
repository, or one that cannot be confirmed, is `409` `conflict`. If an
agent-deck that has reported ids launches without one (a downgrade), that
launch ran unserialized with no before-list, so Castra fails it closed with
`502` `agent_deck_error` rather than guess; later launches take the serialized
path. A serialized launch excludes unserialized launches in its profile and
group for its whole window, from before its before-list until its after-list
is read: it first waits for those already running, and any that arrive meanwhile
wait for it to finish. After a launch, Castra enables session `auto-mode` only when that
command's full timeout still fits in the launch budget; otherwise it skips it
and logs a warning, and the launch still succeeds.

Castra provisions the host steward's credential shims at serve startup.
Each launch, including attachment to an existing worktree, passes an
agent-deck wrapper that selects those shims for that session. It uses the
host loopback Tessera port selected by `MARCH_TESSERA_PORT` (default `9477`).
`march up` scrubs GitHub token variables and their import patterns from the
host tmux global and session environments before starting Castra. A scrub
failure appears in the startup diagnostic and the errored
`stack.tmux.scrub_github_tokens` span.

### `GET /v1/sessions/:id`

| Field | Contract |
|-------|----------|
| Method and path | `GET /v1/sessions/:id` |
| Request envelope | Header `Authorization: Bearer <token>`. Path param `id` is the agent-deck session id. Query requires `profile`. |
| Response envelope | `200` with `{ "session": CastraSession }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid ids or query values return `400`; unknown sessions return `404`; agent-deck show failures return `502`; unexpected failures return `500`. |

### `POST /v1/sessions/:id/send`

| Field | Contract |
|-------|----------|
| Method and path | `POST /v1/sessions/:id/send` |
| Request envelope | Header `Authorization: Bearer <token>`. Path param `id` is the session id. JSON body requires `profile` and non-empty `prompt`. Optional header `x-march-slice-id` correlates tracing only and is not echoed. |
| Response envelope | `202` with `{ "ok": true }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid ids or bodies return `400`; unknown sessions return `404`; a composer refusal returns `502` with `composer_refused`; other agent-deck send failures return `502` with `agent_deck_error`; unexpected failures return `500`. |

Send behavior:

- Sends to one session run one at a time, in arrival order. Sends to different sessions run concurrently.
- When agent-deck refuses a send because the session's Claude composer is occupied or unreadable, the send fails with `composer_refused`. The message carries the last lines of the session's pane only when Castra captured nonempty pane text; if `session show` or `capture-pane` fails, the refusal is still returned, without the pane tail.
- If that pane shows Claude Code's "Adding a new directory … Yes, add it" trust dialog for Castra's own steward directory (the steward root, `~/.march/steward` by default, or its `plugin` directory), Castra selects "Yes, add it", confirms it, and sends the prompt once more, but only when a whole send (45s) still fits in the send budget. A success then returns `202`. When less than 45s is left, Castra answers the dialog but does not resend: it returns `502` `composer_refused` with a message saying the dialog was answered and the prompt was not delivered, and starts no cooldown, so the caller's next send goes through. Castra never answers a trust dialog for any other directory; the message says the dialog was left for the operator. If the pane cannot be read after a key, or a tmux key fails, the outcome is `failed` with that detail, never `resolved`.
- After a refusal, further sends to that session fail at once with `composer_refused`, without running agent-deck, for 5 minutes or until the session's pane changes. The message names the cooldown and repeats the last refusal. A refusal recorded during a recovery sweep keeps its cooldown even when the sweep answers the dialog.

### `GET /v1/sessions/:id/output`

| Field | Contract |
|-------|----------|
| Method and path | `GET /v1/sessions/:id/output` |
| Request envelope | Header `Authorization: Bearer <token>`. Path param `id` is the session id. Query requires `profile`; optional `lines` is an integer from 1 through 100000. |
| Response envelope | `200` with `{ "output": string, "truncated": boolean }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid ids or query values return `400`; unknown sessions return `404`; agent-deck output failures return `502`; unexpected failures return `500`. |

### `POST /v1/sessions/:id/set`

| Field | Contract |
|-------|----------|
| Method and path | `POST /v1/sessions/:id/set` |
| Request envelope | Header `Authorization: Bearer <token>`. Path param `id` is the session id. JSON body requires `profile`, `key`, and `value`; `key` must be one of `auto-mode`, `title`, or `model`, and `value` is a string. |
| Response envelope | `200` with `{ "ok": true }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid ids, unsupported keys, or malformed bodies return `400`; unknown sessions return `404`; agent-deck set failures return `502`; unexpected failures return `500`. |

### `DELETE /v1/sessions/:id`

| Field | Contract |
|-------|----------|
| Method and path | `DELETE /v1/sessions/:id` |
| Request envelope | Header `Authorization: Bearer <token>`. Path param `id` is the session id. Query requires `profile`; optional `pruneWorktree` is a boolean and defaults to false. |
| Response envelope | `200` with `{ "ok": true, "removed": boolean }`. |
| Authentication behavior | Bearer-token protected. Missing or invalid bearer tokens return `401` with `unauthorized`. |
| Visible status or error behavior | Invalid ids or query values return `400`; missing sessions are treated as the desired cleanup state and return `removed: false` only when agent-deck finished and reported the session missing; agent-deck remove failures return `502`; unexpected failures return `500`. Castra gives the remove command 10 seconds and kills its process group on timeout; a remove killed at its timeout is `502` `agent_deck_error`, whatever it printed first, and marks the `castra.remove` span errored. |

`CastraSession` response shape:

| Field | Type | Meaning |
|-------|------|---------|
| `sessionId` | string | Agent-deck session id. |
| `title` | string | Session title. |
| `group` | string | Agent-deck group. |
| `branch` | string | Current or launch-time branch; empty string when unknown. |
| `worktreePath` | string | Session worktree path; empty string when unknown. |
| `createdAt` | string | Creation timestamp reported by agent-deck; empty string when unknown. |
| `status` | string | Agent-deck lifecycle status; empty string when unknown. |
| `metadata` | string-to-string map | Optional Castra-owned launch metadata re-attached on list and show responses. |

## Invariants

- `/healthz`, `/readyz`, and `/status` are open routes; `/v1/*` session routes are the protected service boundary.
- Castra never runs a child process (agent-deck, tmux, git) synchronously. Each has a timeout and is killed with SIGKILL when it expires, so one slow session cannot stall other requests.
- Every protected session route is scoped by `profile`; list and launch may additionally be scoped by `group`.
- The documented required fields and optional `group`, `model`, `createBranch`, and bounded string metadata fields are launch's public contract; any additional body fields are ignored rather than rejected.
- Castra returns `CastraSession` records with stable field names for list, launch, and show; unknown string values are represented as empty strings rather than omitted fields.
- Session output line limiting is bounded to integer values from 1 through 100000.
- Session mutation is limited to the allowed set keys `auto-mode`, `title`, and `model`.
- Session removal is idempotent for missing sessions: absence is reported as `removed: false` rather than a not-found error.
- The Castra HTTP contract covers only the server-side session API listed here; adjacent recovery behavior and Steward role behavior are outside this contract scope.

## Operation Budgets

Mutating operations have end-to-end budgets that include queueing,
inspections and the one trust-dialog retry: launch 240s, send 100s, remove
10s (`src/castra/budgets.ts`). `CastraClient` waits each budget plus 15s. A
mutating step (agent-deck launch, send, remove) starts only when its full
timeout (180s / 45s / 10s) still fits in what is left; otherwise Castra
answers `502` `agent_deck_error` ("… budget ran out before …, so it was not
started") without starting it. A caller that stops waiting cancels nothing: a
step already started runs to completion or its own timeout. A client timeout
means the outcome is unknown. For a launch or a remove, the caller can
re-read `GET /v1/sessions` to see whether the session exists before retrying,
but only once the operation's budget (240s for launch, 10s for remove) has
passed since it sent the request: before that the step may still be running,
and a list without the session does not show it is absent. `CastraClient`
already waits past each budget.
A timed-out send stays unknown: the session list looks the same whether or not
the prompt was typed, so it cannot decide whether to resend; only a separate
sign of delivery (such as the steward acting on the prompt) can.

## Error Modes

All non-2xx responses use this JSON envelope, except `GET /readyz`: its `503` (state `down`) carries the readiness body documented under `GET /readyz`, not an error envelope.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Human-readable message."
  }
}
```

| Condition | Routes | Response | Observable behavior |
|-----------|--------|----------|---------------------|
| Validation failure | Any route with params, query, or body validation | `400` with `{ "error": { "code": "invalid_request", "message": string } }` | Missing `profile`, malformed identifiers, missing launch fields, empty prompt/title/branch/repo path, unsupported set keys, invalid `lines`, invalid `pruneWorktree`, and invalid metadata bounds are rejected before adapter work. |
| Authorization failure | `/v1/*` protected routes | `401` with `{ "error": { "code": "unauthorized", "message": string } }` | The `Authorization` header is absent, does not use the bearer scheme, or does not match the configured token. |
| Missing route | Any unknown route | `404` with `{ "error": { "code": "not_found", "message": string } }` | No Fastify route matches the requested method and path. |
| Missing session | Show, send, output, and set routes | `404` with `{ "error": { "code": "not_found", "message": string } }` | agent-deck reports that the requested session id is absent. Remove treats this condition as success with `removed: false`. |
| Conflict | Launch route | `409` with `{ "error": { "code": "conflict", "message": string } }` | Castra detects a concurrent launch/worktree mismatch and refuses to attach the caller to the wrong session. |
| Composer refused | Send route | `502` with `{ "error": { "code": "composer_refused", "message": string } }` | agent-deck refused the send because the session's composer was occupied or unreadable, or the session is still in its refusal cooldown. The message carries the pane tail when Castra could capture nonempty pane text; a failed pane capture still returns `composer_refused`, without it. |
| Agent-deck failure | Protected routes that invoke agent-deck | `502` with `{ "error": { "code": "agent_deck_error", "message": string } }` | agent-deck exits non-zero, returns unparseable output, cannot identify a launched session, or otherwise fails outside the typed validation/not-found/conflict cases. |
| tmux inventory failure | `GET /v1/interactive-sessions` | `502` with `{ "error": { "code": "tmux_error", "message": string } }` | The live tmux read failed. |
| Internal failure | Any route | `500` with `{ "error": { "code": "internal", "message": "Internal server error." } }` | Unexpected server errors are logged server-side; the public body stays generic and does not expose dependency internals. |
