# Tessera Service Contract

Tessera is the service a March process asks for a GitHub credential. A caller
sends one HTTP request naming the identity it wants (`app` for the GitHub App
bot, `user` for the operator's personal token), the repository, and an access
level. Tessera hands the request to the provider registered for that identity
and returns either a credential or a typed error.

Current state: one provider exists, `github-app`, which serves the `app`
identity. `march tessera serve` registers it when the GitHub App settings are
configured (app id plus an existing key file) and then mints a downscoped
installation token for each `app` request. When the settings are not
configured, the registry is empty and `app` requests fail with
`provider_unconfigured`. No provider serves the `user` identity yet, so `user`
requests always fail with `provider_unconfigured`. Minted tokens are cached in
memory and reused until fewer than ten minutes of life remain.

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
| Response envelope | `200` with an Entitlement body (below). Returned for an `app` request when the `github-app` provider is registered and GitHub mints the token. |
| Authentication behavior | None. Any caller that can reach the port is accepted. |
| Visible status or error behavior | A validation failure returns `400 invalid_request`. A valid request for an identity with no registered provider returns `503 provider_unconfigured`. Typed errors raised by a provider map to the statuses in `## Error Modes`. |

Request body:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `identity` | `"app"` or `"user"` | Yes | Which credential to issue: the GitHub App bot token or the operator token. |
| `access` | `"read"` or `"write"` | Yes | Access level. It selects a fixed permission set; callers cannot name individual permissions. |
| `repo` | string, `owner/name` | Required for `app`; optional for `user` | Target repository. Both parts may contain only letters, digits, `_`, `.` and `-`. A part made only of dots is rejected, as is an owner over 39 characters or a name over 100. |
| `refresh` | boolean | No | Ask the provider to discard a cached credential before issuing. Passed to the provider; the `github-app` provider evicts the matching cache entry and mints a new token. |
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

For an `app` token, `token` is a GitHub App installation token, `expires_at` is
the expiry GitHub reports (about one hour after minting), `identity` is the bot
login `<app-slug>[bot]`, and `commit_identity` is
`{ "name": "<app-slug>[bot]", "email": "<bot-user-id>+<app-slug>[bot]@users.noreply.github.com" }`.

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
| Visible status or error behavior | Always `200`. With no provider registered, `providers` is `[]`, `soonest_expiry` is `null` and `cache.entries` is `0`. If a provider's `status()` or `cacheEntries()` throws, that provider is reported as `degraded`, with `last_error` set to the error class name and `0` cache entries; the response is still `200`. |

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

### The `github-app` provider

`src/tessera/providers/github-app/` serves the `app` identity. It holds the
GitHub App id and private key. For each request it signs a short-lived RS256
app assertion with `node:crypto` and mints an installation token through the
GitHub REST API.

- **Downscoping.** Every mint request names exactly one repository, the one in
  the request, and exactly the permission set for the requested `access`
  level (`ACCESS_PROFILES`). Callers cannot name permissions. If GitHub refuses
  the mint, the provider does not retry with a broader scope, more
  repositories, or another identity.
- **Installation.** When `TESSERA_GITHUB_INSTALLATION_ID` is set, every mint
  uses that installation. Otherwise the provider looks up the App's
  installation on the repository owner (`GET /orgs/{owner}/installation`, then
  `GET /users/{owner}/installation`) and remembers the id per owner. Only a
  successful lookup is remembered. A remembered id is forgotten when a mint
  against it reports not-found.
- **Bot identity.** The bot login and commit identity come from GitHub
  (`GET /app` for the slug, `GET /users/<slug>[bot]` for the user id). No
  setting can change them. Until the identity is known, the provider issues no
  token and returns `provider_unavailable`. It retries the lookup on the next
  request.
- **Bounded calls.** Every GitHub call has a 5-second timeout
  (`GITHUB_REQUEST_TIMEOUT_MS`), which also covers reading the response body.
  One classifier (`classifyGitHubFailure`) maps every failure to a typed error
  (see `## Error Modes`).
- **Startup.** `march tessera serve` awaits the provider's `start()` before it
  listens. `start()` derives the bot identity and never throws, so a GitHub
  outage at startup leaves the provider `degraded` and the service still
  serves. The startup log reports the provider state.
- **Token cache.** Minted tokens are held in memory only (never on disk,
  never logged), keyed by (installation id, sorted repository list, access
  level), so different repositories or access levels never share an entry.
  A request whose entry has strictly more than ten minutes of life left
  (`REMINT_THRESHOLD_MS`) is served from the cache with no GitHub call
  (`cache: "hit"`). Otherwise the provider mints a new token, stores it and
  returns it (`cache: "miss"`). `refresh: true` evicts the entry first. A
  failed mint is never cached. Expired entries are dropped and not counted.
  The provider's `cacheEntries()` reports the live count, which `/status`
  shows as `cache.entries`; `clearCache()` drops every entry (for a key
  reload). When the provider goes `invalid`, its cache is cleared and no
  cached token is served.

Provider state transitions, as reported by `/status`:

| From | Event | To |
|------|-------|----|
| `unconfigured` | `start()` derives the bot identity | `ok` |
| any but `invalid` | A GitHub call times out, cannot connect, or returns `5xx`, or the identity lookup fails | `degraded` |
| `degraded` | A later GitHub call succeeds and the bot identity is known | `ok` |
| any | GitHub returns `401` to the app assertion, or the key file cannot be read or parsed | `invalid` |

`invalid` lasts until the service restarts. `last_error` holds the error code
of the last failure (for example `provider_unavailable`), never its message.
Once the provider is `invalid`, no later failure or success changes `state` or
`last_error`, including one from a request already in flight.
`login` is `null` until the bot identity is known.

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
| `TESSERA_GITHUB_APP_ID` | server | GitHub App id. Optional; with the key file, it enables the `github-app` provider. |
| `TESSERA_GITHUB_APP_KEY_FILE` | server | Path to the App private key file (PEM). Optional; counts as missing when the file does not exist. |
| `TESSERA_GITHUB_INSTALLATION_ID` | server | Pinned installation id. Optional; must be a positive integer when set. When unset, the installation is looked up per repository owner. |
| `MARCH_OTEL` | server | Enables telemetry export; a no-op when off. The compose file defaults it to `1`. |

When the app id or key file is missing, the service still starts, logs a
warning that names the missing settings, and answers `app` requests with
`provider_unconfigured`. When both are present, it registers the `github-app`
provider, logs the names of the settings in use, starts the provider, and logs
the provider state. Log lines name settings only; they never contain the app
id, the key path, key contents, an assertion or a token. The GitHub API base
URL is not a setting: it is always `https://api.github.com`, and only tests
replace it, by passing a GitHub client to `runTesseraServer`.

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
  the compose file publishes the port on `127.0.0.1` only. Inside the
  compose stack the service is also reachable by every container on the
  `march` network. With the GitHub App configured, any of those callers can
  mint a read or write bot token for any repository the App is installed on,
  so leave the App settings unset outside of testing until client keys land.
- No identity is ever substituted for another. A request for `app` is only
  served by the provider registered for `app`, and a request for `user` only by
  the provider for `user`. If that provider is missing, the response is
  `provider_unconfigured`; no fallback to the other identity exists on any path,
  including error paths.
- A registry holds at most one provider per identity.
- Callers cannot widen permissions. The only permissions a provider may request
  are the fixed set for the requested `access` level, and `write` never
  includes `workflows`, `administration` or `members`.
- An `app` token is scoped to exactly one repository, the requested one, with
  exactly the access level's permissions. Scope is never widened: a refused
  mint is not retried with more repositories or more permissions.
- A mint is refused locally, before any GitHub call, unless it names exactly
  one repository and a non-empty permission set (GitHub reads an empty or
  missing list as everything the installation has).
- The bot login and commit identity come from GitHub, never from
  configuration. No `app` token is issued while they are unknown.
- Every GitHub call is bounded by a 5-second timeout, and every failure is a
  typed error from `## Error Modes`.
- No token or key material appears in logs or in `/status`. `/status` carries
  counts, states, logins, expiry times and error classes only.
- Request and response bodies are never logged. Each request logs one line with
  the method, matched route, status class and duration. Unexpected errors log
  the error class only, not the message.
- Validation error messages name fields and never echo submitted values.
- `/healthz` reports process health only and returns `200` whether or not any
  provider is configured.
- An `app` token is reused from the in-memory cache only while more than ten
  minutes of its life remain, and only for the same installation, repository
  set and access level; no cached token is served once the provider is
  `invalid`.
- Only Fastify framework rejections (an `FST_*` error code with a `4xx` status)
  become `400 invalid_request`. Any other unexpected error becomes
  `500 internal`, even if it carries a `4xx` status.

## Error Modes

Every non-2xx response has the body
`{ "error": { "code": string, "message": string } }`.

| Code | HTTP status | When |
|------|-------------|------|
| `invalid_request` | `400` | Body is not a JSON object, has an unknown field, has an `identity` other than `app`/`user`, has an `access` other than `read`/`write`, has a `repo` not in `owner/name` form, omits `repo` for `app`, or has a non-boolean `refresh` or non-string `subject`. |
| `invalid_request` | `400` | Fastify rejects the request before the route runs (an `FST_*` error with a `4xx` status: for example invalid JSON, an empty JSON body, an unsupported content type, or an oversized body). The message is always `Malformed request body.` and never echoes the body. |
| `invalid_request` | `404` | No route matches the method and path. The message is fixed and does not echo the request URL. |
| `provider_unconfigured` | `503` | No provider is registered for the requested identity: an `app` request when the GitHub App settings are not configured, and every `user` request. |
| `repo_not_installed` | `422` | The App is not installed on the repository owner (both installation lookups return `404`; no mint is attempted), or GitHub refuses the mint with `404` or `422` because the installation does not cover the repository. |
| `credential_invalid` | `503` | GitHub returns `401` to the app assertion, or the key file cannot be read or parsed. The provider becomes `invalid` until restart. No `Retry-After` header. |
| `provider_unavailable` | `503` | A GitHub call times out (5 seconds), cannot connect, or returns `5xx`; or the bot identity is not yet known. The provider becomes `degraded`. The response carries a `Retry-After` header in seconds: GitHub's numeric `Retry-After` on a `5xx` when present, else `30`. |
| `mint_failed` | `502` | Any other GitHub failure: another `4xx` (for example `403`, including rate limits), or a response that cannot be parsed. |
| `internal` | `500` | Any other unexpected error, including a non-Fastify error that carries a `4xx` status. The message is `Internal server error.`; the log records the error class only. |

Startup failures of `march tessera serve`:

| Condition | Outcome |
|-----------|---------|
| `--port` or `MARCH_TESSERA_PORT` is not an integer in 1..65535 | Reason printed to stderr, exit status `2`, nothing listens. |
| `TESSERA_GITHUB_INSTALLATION_ID` is set but not a positive integer | Reason printed to stderr, exit status `2`, nothing listens. |
| App id or key file missing | Not a failure: the service starts, logs a warning naming the missing settings, and answers `app` requests with `provider_unconfigured`. |
| GitHub unreachable or failing when the provider starts | Not a failure: the service starts, the provider is `degraded` (or `invalid` if the credential is rejected), and the bot identity lookup is retried on the next `app` request. |
