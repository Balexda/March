# Castra Service Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Castra exposes open process-health/status routes and a bearer-token-protected `/v1/*` JSON API over agent-deck interactive sessions. Protected routes use `Authorization: Bearer <token>` and return the uniform error envelope documented in `## Error Modes` on non-2xx responses.

### `GET /healthz`

| Field | Contract |
|-------|----------|
| Method and path | `GET /healthz` |
| Request envelope | No headers, params, query, or body required. |
| Response envelope | `200` with `{ "status": "ok" }`. |
| Authentication behavior | Open; bearer token is not required. |
| Visible status or error behavior | Basic process health only; this route does not report agent-deck reachability. |

### `GET /status`

| Field | Contract |
|-------|----------|
| Method and path | `GET /status` |
| Request envelope | No headers, params, query, or body required. |
| Response envelope | `200` with `{ "service": "march-castra", "version": string, "uptimeSeconds": number, "agentDeck": { "reachable": boolean } }`. |
| Authentication behavior | Open; bearer token is not required. |
| Visible status or error behavior | Reports agent-deck reachability as data in the response body; a false `agentDeck.reachable` value does not change the HTTP status. |

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
| Visible status or error behavior | Invalid ids or bodies return `400`; unknown sessions return `404`; agent-deck send failures return `502`; unexpected failures return `500`. |

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
| Visible status or error behavior | Invalid ids or query values return `400`; missing sessions are treated as the desired cleanup state and return `removed: false`; agent-deck remove failures return `502`; unexpected failures return `500`. |

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

- `/healthz` and `/status` are open routes; `/v1/*` session routes are the protected service boundary.
- Every protected session route is scoped by `profile`; list and launch may additionally be scoped by `group`.
- The documented required fields and optional `group`, `model`, `createBranch`, and bounded string metadata fields are launch's public contract; any additional body fields are ignored rather than rejected.
- Castra returns `CastraSession` records with stable field names for list, launch, and show; unknown string values are represented as empty strings rather than omitted fields.
- Session output line limiting is bounded to integer values from 1 through 100000.
- Session mutation is limited to the allowed set keys `auto-mode`, `title`, and `model`.
- Session removal is idempotent for missing sessions: absence is reported as `removed: false` rather than a not-found error.
- The Castra HTTP contract covers only the server-side session API listed here; adjacent recovery behavior and Steward role behavior are outside this contract scope.

## Error Modes

All non-2xx responses use this JSON envelope:

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
| Agent-deck failure | Protected routes that invoke agent-deck | `502` with `{ "error": { "code": "agent_deck_error", "message": string } }` | agent-deck exits non-zero, returns unparseable output, cannot identify a launched session, or otherwise fails outside the typed validation/not-found/conflict cases. |
| Internal failure | Any route | `500` with `{ "error": { "code": "internal", "message": "Internal server error." } }` | Unexpected server errors are logged server-side; the public body stays generic and does not expose dependency internals. |
