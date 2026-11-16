# Tessera Service Contract

Tessera is the service a March process asks for a GitHub credential. A caller
sends one HTTP request naming the identity it wants (`app` for the GitHub App
bot, `user` for the operator's personal token), the repository, and an access
level. Tessera hands the request to the provider registered for that identity
and returns either a credential or a typed error.

Current state: no provider is registered. `march tessera serve` always builds
an empty provider registry, so every `POST /v1/github/token` request that
passes validation fails with `provider_unconfigured`. This holds even when the
GitHub App settings are present. The `github-app` provider is planned but not
part of this contract yet.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Tessera exposes `GET /healthz`, `GET /status` and one JSON API route,
`POST /v1/github/token`. None of these routes requires authentication (see
`## Invariants`). Every non-2xx response uses the error envelope described in
`## Error Modes`.

### `POST /v1/github/token`

| Field | Contract |
|-------|----------|
| Method and path | `POST /v1/github/token` |
| Request envelope | JSON object body (`content-type: application/json`) with the fields listed below. A field outside this set is rejected. |
| Response envelope | `200` with an Entitlement body (below). No request can currently get this response, because no provider is registered. |
| Authentication behavior | None. Any caller that can reach the port is accepted. |
| Visible status or error behavior | A validation failure returns `400 invalid_request`. A valid request for an identity with no registered provider returns `503 provider_unconfigured`. Typed errors raised by a provider map to the statuses in `## Error Modes`. |

Request body:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `identity` | `"app"` or `"user"` | Yes | Which credential to issue: the GitHub App bot token or the operator token. |
| `access` | `"read"` or `"write"` | Yes | Access level. It selects a fixed permission set; callers cannot name individual permissions. |
| `repo` | string, `owner/name` | Required for `app`; optional for `user` | Target repository. Both parts may contain only letters, digits, `_`, `.` and `-`. A part made only of dots is rejected, as is an owner over 39 characters or a name over 100. |
| `refresh` | boolean | No | Ask the provider to discard a cached credential before issuing. Passed to the provider. |
| `subject` | string | No | Reserved for future per-spawn tickets. Accepted and validated, but not passed to the provider and not used for any decision. |

Validation runs in this order: body is a JSON object, no unknown fields,
`identity`, `access`, `repo` format, `repo` present for `app`, `refresh` type,
`subject` type. The first failure is returned. Validation messages name the
field, never the submitted value.

Success body (Entitlement):

| Field | Type | Meaning |
|-------|------|---------|
| `token` | string | The credential. |
| `expires_at` | RFC 3339 string or `null` | Credential expiry; `null` only when the provider cannot determine one. |
| `identity` | string | The GitHub login the token acts as. |
| `commit_identity` | `{ "name": string, "email": string }` or `null` | Author and committer identity for commits made with an `app` token; `null` for `user`. |
| `access` | `"read"` or `"write"` | The requested access level, echoed. |
| `repo` | string or `null` | The requested repository; always `null` for `user`. |

Access levels map to these GitHub App permissions. The map is a constant in
`src/tessera/types.ts` (`ACCESS_PROFILES`):

| Access | Permissions |
|--------|-------------|
| `read` | `metadata`, `contents`, `pull_requests`, `issues`, `checks`, `statuses`: all `read` |
| `write` | Everything in `read`, with `contents`, `pull_requests` and `issues` raised to `write` |

`write` never includes `workflows`, `administration` or `members`.

### `GET /healthz`

| Field | Contract |
|-------|----------|
| Method and path | `GET /healthz` |
| Request envelope | Nothing required. |
| Response envelope | `200` with `{ "status": "ok" }`. |
| Authentication behavior | None. |
| Visible status or error behavior | Reports process health only. It stays `200` when no provider is configured. The container healthcheck calls this route. |

### `GET /status`

| Field | Contract |
|-------|----------|
| Method and path | `GET /status` |
| Request envelope | Nothing required. |
| Response envelope | `200` with `{ "service": "march-tessera", "uptime_s": number, "providers": ProviderStatus[], "soonest_expiry": string \| null, "cache": { "entries": number } }`. |
| Authentication behavior | None. |
| Visible status or error behavior | Always `200`. With no provider registered, `providers` is `[]`, `soonest_expiry` is `null` and `cache.entries` is `0`. |

`uptime_s` is whole seconds since the server was built. `soonest_expiry` is the
earliest parseable `credential_expires_at` across providers. `cache.entries` is
the sum of each provider's cached-credential count.

Each `ProviderStatus` entry has these fields. None of them carries a token or
key material.

| Field | Type | Meaning |
|-------|------|---------|
| `provider` | `"github-app"` or `"github-user"` | Provider id. |
| `state` | `"ok"`, `"unconfigured"`, `"degraded"` or `"invalid"` | Provider lifecycle state. |
| `login` | string or `null` | Login the provider issues as, if known. |
| `credential_expires_at` | RFC 3339 string or `null` | Expiry of the provider's long-lived credential, if known. |
| `expiry_warning` | boolean | Whether that expiry is close. |
| `last_error` | string or `null` | Error class of the last failure, never its message. |

### Provider seam

The route dispatches through a `ProviderRegistry` (`src/tessera/server.ts`).
A registry holds at most one `CredentialProvider` per identity;
`createProviderRegistry` throws `TesseraValidationError` if two providers claim
the same identity. A provider implements `start()`, `issue(request)`,
`status()` and, optionally, `cacheEntries()`. `issue` receives only `repo`,
`access` and `refresh`, and reports failure by throwing a `TesseraError`
subclass from `src/tessera/types.ts`. The route itself contains no GitHub logic.

### CLI: `march tessera serve`

| Option | Default | Meaning |
|--------|---------|---------|
| `--port <port>` | `MARCH_TESSERA_PORT`, else `9477` | Port to bind. Must be an integer in 1..65535. |
| `--host <host>` | `127.0.0.1` | Bind address. The container passes `0.0.0.0`. |

The command runs until `SIGTERM` or `SIGINT`, then closes the server, flushes
telemetry and exits `0`. An invalid port prints the reason to stderr and exits
with the usage status (`2`) before anything listens. Bare `march tessera`
prints the group help and exits with the usage status.

### Configuration

| Setting | Side | Meaning |
|---------|------|---------|
| `MARCH_TESSERA_PORT` | consumer and server | Port. Default `9477`, derived from the service name `march-tessera` in the 8800-9799 band. |
| `MARCH_TESSERA_URL` | consumer | Base URL March processes use to reach Tessera. Defined as a name only; nothing reads it yet. |
| `MARCH_TESSERA_LOG_DIR` | server | Directory for the log file `tessera.jsonl`. Default `~/.march/logs`; the container uses `/march/logs` on the `march-tessera-logs` volume. |
| `TESSERA_GITHUB_APP_ID` | server | GitHub App id. Optional. |
| `TESSERA_GITHUB_APP_KEY_FILE` | server | Path to the App private key file. Optional; counts as missing when the file does not exist. |
| `TESSERA_GITHUB_INSTALLATION_ID` | server | Pinned installation id. Optional; must be a positive integer when set. |
| `MARCH_OTEL` | server | Enables telemetry export; a no-op when off. The compose file defaults it to `1`. |

When the app id or key file is missing, the service still starts and logs a
warning that names the missing settings (names only, never values). When both
are present, it logs that the settings are present but that no app provider is
available in this build. In both cases `app` requests return
`provider_unconfigured`.

### Container

`docker/tessera.Dockerfile` builds `march-tessera:latest`
(`npm run build:tessera-image`). `docker/tessera.docker-compose.yml` runs it as
`march-tessera` on the external `march` network and publishes the port on
`127.0.0.1` only. The image installs neither `gh` nor `git`. The compose file
mounts no host home directory and no Docker socket, and passes no `GH_TOKEN`
or `GITHUB_TOKEN`.

## Invariants

- `/v1/*` is unauthenticated: Tessera accepts any caller that can reach the
  port. Per-client keys are planned (spec User Story 2) and are not
  implemented. Until they are, the service must be reachable only from the
  loopback interface: `march tessera serve` binds `127.0.0.1` by default, and
  the compose file publishes the port on `127.0.0.1` only.
- No identity is ever substituted for another. A request for `app` is only
  served by the provider registered for `app`, and a request for `user` only by
  the provider for `user`. If that provider is missing, the response is
  `provider_unconfigured`; no fallback to the other identity exists on any path,
  including error paths.
- A registry holds at most one provider per identity.
- Callers cannot widen permissions. The only permissions a provider may request
  are the fixed set for the requested `access` level, and `write` never
  includes `workflows`, `administration` or `members`.
- No token or key material appears in logs or in `/status`. `/status` carries
  counts, states, logins, expiry times and error classes only.
- Request and response bodies are never logged. Each request logs one line with
  the method, matched route, status class and duration. Unexpected errors log
  the error class only, not the message.
- Validation error messages name fields and never echo submitted values.
- `/healthz` reports process health only and returns `200` whether or not any
  provider is configured.
- With the current build, every `POST /v1/github/token` request that passes
  validation returns `503 provider_unconfigured`.

## Error Modes

Every non-2xx response has the body
`{ "error": { "code": string, "message": string } }`.

| Code | HTTP status | When |
|------|-------------|------|
| `invalid_request` | `400` | Body is not a JSON object, has an unknown field, has an `identity` other than `app`/`user`, has an `access` other than `read`/`write`, has a `repo` not in `owner/name` form, omits `repo` for `app`, or has a non-boolean `refresh` or non-string `subject`. |
| `invalid_request` | `400` | Fastify rejects the request before the route runs (for example invalid JSON, an unsupported content type, or an oversized body). The message is always `Malformed request body.` and never echoes the body. |
| `invalid_request` | `404` | No route matches the method and path. The message is fixed and does not echo the request URL. |
| `provider_unconfigured` | `503` | No provider is registered for the requested identity. In the current build this is every valid token request. |
| `repo_not_installed` | `422` | A provider raises `RepoNotInstalledError`: the App is not installed for the repository. No provider raises it yet. |
| `credential_invalid` | `503` | A provider raises `CredentialInvalidError`: GitHub rejected the credential, or it expired. No provider raises it yet. |
| `provider_unavailable` | `503` | A provider raises `ProviderUnavailableError`: GitHub is unreachable and no usable cached token exists. The response carries a `Retry-After` header in seconds (default `30`). No provider raises it yet. |
| `mint_failed` | `502` | A provider raises `MintFailedError` for any other issuance failure. No provider raises it yet. |
| `internal` | `500` | Any other unexpected error. The message is `Internal server error.`; the log records the error class only. |

Startup failures of `march tessera serve`:

| Condition | Outcome |
|-----------|---------|
| `--port` or `MARCH_TESSERA_PORT` is not an integer in 1..65535 | Reason printed to stderr, exit status `2`, nothing listens. |
| `TESSERA_GITHUB_INSTALLATION_ID` is set but not a positive integer | Reason printed to stderr, exit status `2`, nothing listens. |
| App id or key file missing | Not a failure: the service starts, logs a warning naming the missing settings, and answers `app` requests with `provider_unconfigured`. |
