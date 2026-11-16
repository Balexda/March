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
memory and reused until fewer than ten minutes of life remain; during a GitHub
outage an unexpired cached token is served instead of an error.

Every request under `/v1` must carry the bearer key of a registered client
(`Authorization: Bearer <client key>`). Tessera stores only the SHA-256 hash of
each key, read at startup from the client-keys file named by
`TESSERA_CLIENT_KEYS_FILE`, and refuses to start without a valid one. A missing
or unknown key gets `401 unauthorized`. `/healthz` and `/status` need no key.

Each token request from an authenticated client is then checked against that
client's rule in the policy file named by `TESSERA_POLICY_FILE`. Tessera
refuses to start without a valid policy file too. The policy is default deny: a
request is allowed only when the client's rule grants the identity, the
repository (for `app` requests) and the access level. Anything else, including every request from a
registered client that has no rule, gets `403 policy_denied`.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Tessera exposes `GET /healthz`, `GET /status` and one JSON API route,
`POST /v1/github/token`. Every path under `/v1` requires a client key (see
"Client authentication" below); `/healthz` and `/status` do not. Every non-2xx
response uses the error envelope described in `## Error Modes`.

### Client authentication

| Field | Contract |
|-------|----------|
| Scheme | `Authorization: Bearer <client key>`. The word `Bearer` is matched without regard to case; the key is everything after it and must contain no whitespace. Any other form (no header, another scheme, an empty key) counts as a missing key. |
| Scope | `/v1` itself and every path below it, for every method, including paths that match no route. `/healthz` and `/status` are open. |
| Order | Authentication runs before the body is parsed or validated. A request without a valid key gets `401 unauthorized` whatever its body; a malformed body is only reported to an authenticated caller. An unmatched `/v1` path returns `401` to an unauthenticated caller and `404` to an authenticated one. |
| Rejection | `401` with `{ "error": { "code": "unauthorized", "message": "A valid Tessera client key is required." } }`. The response is the same for a missing key, a malformed header and an unknown key; it never says which. |
| Matching | Tessera hashes the presented key with SHA-256 and compares the digest in constant time against every registered hash, with no early exit on a match. |
| Caller identity | On success the route knows the authenticated client's name (`request.tesseraClient`), and the request log line records it as `tessera.client`. |
| Authorization | Applied to token requests after authentication and body validation, against the authenticated client's policy rule. See "Policy" below. |

Tessera never stores a plaintext key. The client-keys file holds only hashes,
and keys, hashes and the `Authorization` header are never logged.

#### The client-keys file

`TESSERA_CLIENT_KEYS_FILE` names a JSON file holding an array of client
registrations, one per client:

```json
[
  { "client": "legate", "key_sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  { "client": "steward", "key_sha256": "1111111111111111111111111111111111111111111111111111111111111111" }
]
```

(The hashes above are placeholders, not real key hashes.)

The file is rejected, and Tessera does not start, unless:

- it is valid JSON whose top level is an array with at least one entry;
- each entry is an object with exactly the fields `client` and `key_sha256`;
- `client` matches `^[a-z][a-z0-9-]{0,31}$` (a lowercase letter, then up to
  31 lowercase letters, digits or `-`);
- `key_sha256` is exactly 64 lowercase hexadecimal characters;
- no two entries share a `client`, and no two share a `key_sha256`.

Error messages name the setting and the entry position (for example
`entry 2`), never the file path, a hash or any other file content.

The file is read once, at startup. Adding, removing or changing a client takes
a restart.

To create a key and its registration:

```sh
KEY="$(openssl rand -hex 32)"     # the client key; give it to the client only
printf %s "$KEY" | sha256sum      # the first 64 characters are key_sha256
```

The hash is computed over the exact key string, with no trailing newline. Use
`printf %s`, not `echo`, which appends a newline and produces a hash that never
matches. Put the hash, never the key, in the client-keys file.

### Policy

`TESSERA_POLICY_FILE` names a JSON file holding an array of rules, at most one
per registered client. A rule says which identities the client may request,
which repositories it may request `app` tokens for, and the highest access
level it may request:

```json
[
  { "client": "steward", "identities": ["app"], "repos": ["acme/*"], "max_access": "write" },
  { "client": "herald", "identities": ["app"], "repos": ["acme/widgets", "acme/gadgets"], "max_access": "read" },
  { "client": "legate", "identities": ["app", "user"], "repos": ["acme/*"], "max_access": "write" }
]
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `client` | string | Yes | A client registered in the client-keys file. |
| `identities` | array of `"app"` and/or `"user"` | Yes | The identities the client may request. Only the `legate` client may be granted `user`. |
| `repos` | array of strings | Yes, and non-empty, when `identities` contains `app`; optional otherwise | Repository allowlist for `app` requests. Each entry is `owner/name` (one repository) or `owner/*` (every repository of that owner). |
| `max_access` | `"read"` or `"write"` | Yes | The access ceiling. `write` also allows `read`. |

The file is rejected, and Tessera does not start (exit status `2`), unless:

- it is not blank, is valid JSON, and its top level is an array with at least
  one rule;
- each rule is an object with no fields other than `client`, `identities`,
  `repos` and `max_access`;
- each `client` is a string naming a client registered in the client-keys
  file;
- no client has a second rule;
- each `identities` is a non-empty array of `"app"` and `"user"` with no
  duplicates;
- `user` is granted only to the `legate` client;
- each `max_access` is `"read"` or `"write"`;
- a rule that grants `app` has a non-empty `repos`;
- `repos`, when present, is an array, and each entry is exactly `owner/name`
  or `owner/*`, where both parts follow the same character rules as the request
  `repo` field. A bare `*`, a wildcard owner and any other pattern are
  rejected. No two entries may be the same, ignoring case.

Error messages name the setting and the rule position (for example `rule 2`),
and for a repository entry its position in `repos`. They never contain the file
path, a client name or repository taken from the file, or any other file
content.

A registered client with no rule is valid at startup; every request it makes
is denied. The file is read once, at startup. Changing the policy takes a
restart.

#### Decision rules

The token route checks a request against the caller's rule in this order. The
first check that fails ends the request with `403 policy_denied`, with the
message for that check (see `## Error Modes`).

1. **Identity.** Denied when the client has no rule, when its rule does not
   list the requested identity, or when the identity is `user` and the client
   is not `legate`. The loader already refuses a `user` grant to any other
   client; the request-time check is repeated as a second line of defence.
2. **Repository** (`app` requests only). The requested `repo` must match an
   allowlist entry: either the exact `owner/name`, or `owner/*` for the same
   owner. `owner/*` never matches another owner's repository. Matching ignores
   case, so `Acme/Widgets` matches `acme/widgets` and `acme/*`.
3. **Access.** The requested `access` must not exceed `max_access`, where
   `read` is below `write`. This applies to every identity.

For a `user` request the repository allowlist is not applied, even when the
request carries a `repo`. `subject` takes no part in any check.

Two of these rules are working assumptions, recorded as open questions in the
spec's task plan:

- *Working assumption: the access ceiling applies to `user` requests.* A
  `legate` rule with `max_access: "read"` denies a `user` request for `write`.
- *Working assumption: the allowlist does not apply to `user` requests.* The
  operator token cannot be limited to a repository, so its `repo` is not
  checked.

#### Evaluation order

Every token request goes through these steps in order, and stops at the first
one that fails:

1. **Authenticate** the client key: `401 unauthorized`.
2. **Validate** the body: `400 invalid_request`.
3. **Authorize** against the client's policy rule: `403 policy_denied`.
4. **Dispatch** to the provider for the requested identity:
   `503 provider_unconfigured` when there is none, otherwise the provider's
   result.

A denied request never reaches a provider or GitHub, and never gets
`provider_unconfigured`.

### `POST /v1/github/token`

| Field | Contract |
|-------|----------|
| Method and path | `POST /v1/github/token` |
| Request envelope | JSON object body (`content-type: application/json`) with the fields listed below. A field outside this set is rejected. |
| Response envelope | `200` with an Entitlement body (below). Returned for an `app` request when the `github-app` provider is registered and either GitHub mints the token or a cached token is served (see "Token cache" under the `github-app` provider). |
| Authentication behavior | Requires `Authorization: Bearer <client key>` for a registered client, checked before the body is validated. A missing or unknown key returns `401 unauthorized`. A valid body is then authorized against the client's policy rule before any provider is looked up (see "Policy"). |
| Visible status or error behavior | A request without a valid client key returns `401 unauthorized`. A validation failure returns `400 invalid_request`. A request outside the client's policy rule returns `403 policy_denied`. An allowed request for an identity with no registered provider returns `503 provider_unconfigured`. Typed errors raised by a provider map to the statuses in `## Error Modes`. |

Request body:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `identity` | `"app"` or `"user"` | Yes | Which credential to issue: the GitHub App bot token or the operator token. |
| `access` | `"read"` or `"write"` | Yes | Access level. It selects a fixed permission set; callers cannot name individual permissions. |
| `repo` | string, `owner/name` | Required for `app`; optional for `user` | Target repository. Both parts may contain only letters, digits, `_`, `.` and `-`. A part made only of dots is rejected, as is an owner over 39 characters or a name over 100. |
| `refresh` | boolean | No | Ask the provider to discard a cached credential before issuing. Passed to the provider; the `github-app` provider evicts the matching cache entry and mints a new token. A refresh never receives a cached token, so during a GitHub outage it fails with `provider_unavailable`. |
| `subject` | string | No | Reserved for future per-spawn tickets. Accepted and validated, but not passed to the provider and not used for any decision, including the policy decision. |

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
| Authentication behavior | None. Open without a client key. |
| Visible status or error behavior | Reports process health only. It stays `200` when no provider is configured. The container healthcheck calls this route. |

### `GET /status`

| Field | Contract |
|-------|----------|
| Method and path | `GET /status` |
| Request envelope | Nothing required. |
| Response envelope | `200` with `{ "service": "march-tessera", "uptime_s": number, "providers": ProviderStatus[], "soonest_expiry": string \| null, "cache": { "entries": number } }`. |
| Authentication behavior | None. Open without a client key. |
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
  uses that installation, and only for repositories of the account it belongs
  to. The provider reads that account's login once
  (`GET /app/installations/{id}`) and refuses any request whose owner is a
  different account with `repo_not_installed`, before any mint. Only a
  successful lookup is remembered; concurrent first lookups share one call. A
  failed lookup is returned as its error (an outage is `provider_unavailable`).
  When the setting is unset, the provider looks up the App's installation on
  the repository owner (`GET /orgs/{owner}/installation`, then
  `GET /users/{owner}/installation`) and remembers the id per owner. Only a
  successful lookup is remembered. A remembered id is forgotten when a mint
  against it reports not-found. Owners are compared without regard to case,
  as GitHub logins are case-insensitive.
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
  never logged), keyed by (installation id, repository as `owner/name`
  lower-cased, access level), so different owners, repositories or access
  levels never share an entry, and `Acme/Widgets` and `acme/widgets` do. The
  mint request to GitHub still names just the repository.
  A request whose entry has strictly more than ten minutes of life left
  (`REMINT_THRESHOLD_MS`) is served from the cache with no GitHub call
  (`cache: "hit"`). Otherwise the provider mints a new token, stores it and
  returns it (`cache: "miss"`). `refresh: true` evicts the entry first. A
  failed mint is never cached. Expired entries are dropped and not counted.
  The provider's `cacheEntries()` reports the live count, which `/status`
  shows as `cache.entries`; `clearCache()` drops every entry (for a key
  reload). When the provider goes `invalid`, its cache is cleared and no
  cached token is served. The cache does not survive a restart.
- **Outages.** When a re-mint fails with `provider_unavailable` and the
  cached token for that key has not yet expired, the provider serves the
  cached token (`cache: "hit"`, `200`) and becomes `degraded` with
  `last_error` `provider_unavailable`. Every request sharing that failed mint
  receives the cached token. No other failure is masked: `repo_not_installed`,
  `credential_invalid` and `mint_failed` are returned even when a cached token
  exists. A re-mint that fails with `repo_not_installed` also evicts that
  key's entry, so a later outage cannot serve it. With no entry, or an expired
  one, `provider_unavailable` is returned. A `refresh: true` request never
  receives a cached token. The key must be known without GitHub: from
  `TESSERA_GITHUB_INSTALLATION_ID` once its account has been verified against
  the owner, or from a remembered installation id. If the installation or the
  override's account has to be looked up and the lookup fails, the error is
  returned. The bot identity, once known, is kept
  until restart, so an identity lookup never blocks a cached token.
- **Mint coalescing.** At most one mint is in flight per cache key:
  concurrent requests for the same key share it and receive the same token
  or the same error, each reporting `cache: "miss"`. Requests for different
  keys never wait on each other. The shared mint is forgotten once it
  settles, so after a failure the next request mints again. A
  `refresh: true` request joins a mint already in flight for its key
  instead of starting another; with none in flight it evicts and mints.
  Concurrent first installation lookups for the same owner are shared the
  same way.

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
telemetry and exits `0`. An invalid port, or a missing or invalid client-keys or
policy file, prints the reason to stderr and exits with the usage status (`2`)
before anything listens. Bare `march tessera`
prints the group help and exits with the usage status.

### Configuration

| Setting | Side | Meaning |
|---------|------|---------|
| `MARCH_TESSERA_PORT` | consumer and server | Port. Default `9477`, derived from the service name `march-tessera` in the 8800-9799 band. |
| `MARCH_TESSERA_URL` | consumer | Base URL March processes use to reach Tessera. Defined as a name only; nothing reads it yet. |
| `MARCH_TESSERA_LOG_DIR` | server | Directory for the log file `tessera.jsonl`. Default `~/.march/logs`; the container uses `/march/logs` on the `march-tessera-logs` volume. |
| `TESSERA_GITHUB_APP_ID` | server | GitHub App id. Optional; with the key file, it enables the `github-app` provider. |
| `TESSERA_GITHUB_APP_KEY_FILE` | server | Path to the App private key file (PEM). Optional; counts as missing when the file does not exist. |
| `TESSERA_GITHUB_INSTALLATION_ID` | server | Pinned installation id. Optional; must be a positive integer when set. When set, only repositories of the account that installation belongs to are served. When unset, the installation is looked up per repository owner. |
| `TESSERA_CLIENT_KEYS_FILE` | server | Required. Path to the client-keys file (see "The client-keys file"). Tessera does not start when it is unset, blank, unreadable or invalid. Read once at startup. |
| `TESSERA_POLICY_FILE` | server | Required. Path to the policy file (see "Policy"). Tessera does not start when it is unset, blank, unreadable or invalid. Read once at startup; restart to change the policy. |
| `MARCH_OTEL` | server | Enables telemetry export; a no-op when off. The compose file defaults it to `1`. |

At startup the service loads the client-keys file and logs the number of
registered clients, naming the setting but never the path or any hash. It then
loads the policy file and logs the number of rules, naming the setting but
never the path, a rule, a client's grants or a repository.

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

- Every request to `/v1` or a path below it, matched or not, must carry the
  bearer key of a registered client. A missing, malformed or unknown key gets
  the same `401 unauthorized` response, before the body is parsed or
  validated. `/healthz` and `/status` stay open.
- Tessera does not start without a valid client-keys file. There is no mode
  that accepts callers without a key.
- Tessera holds only SHA-256 hashes of client keys, never a plaintext key. A
  presented key is hashed and compared in constant time against every
  registered hash.
- Default deny. A token request is allowed only when the caller's policy rule
  grants the identity, matches the repository (for `app`) and covers the
  access level. A registered client with no rule is denied every request.
  There is no allow-all mode: Tessera does not start without a valid policy
  file.
- Only the `legate` client may hold the `user` identity. A rule granting `user`
  to any other client is a startup failure, and a `user` request from any other
  client is denied.
- `subject` affects no decision. Changing or omitting it never changes whether
  a request is allowed.
- A client has at most one policy rule. A second rule for the same client is a
  startup failure.
- Authorization runs after authentication and body validation and before any
  provider is looked up. A denied request never reaches a provider or GitHub.
- A `policy_denied` message names only the check that failed. It never reveals
  the allowlist, the ceiling or the submitted repository.
- Keep the service reachable only from the loopback interface:
  `march tessera serve` binds `127.0.0.1` by default, and the compose file
  publishes the port on `127.0.0.1` only. Inside the compose stack the
  service is also reachable by every container on the `march` network, but
  only a caller holding a registered key gets past `/v1`, and then only within
  its policy rule.
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
- Cached `app` tokens live in memory only: never on disk, never logged, and
  gone on restart. The cache key is (installation id, repository as
  `owner/name` lower-cased, access level); a cached token is only ever served
  for its own key, so different owners, repositories, access levels or
  installations never share a token.
- With `TESSERA_GITHUB_INSTALLATION_ID` set, a token is only minted for a
  repository whose owner is the account that installation belongs to; any
  other owner gets `repo_not_installed` with no mint.
- A cached token is served without a GitHub call only while strictly more
  than ten minutes (`REMINT_THRESHOLD_MS`) of its life remain; otherwise it is
  re-minted. `refresh: true` evicts the entry before issuing, unless a mint
  for that key is already in flight, which it joins.
- At most one mint is in flight per cache key; concurrent requests for that
  key share its result. A failed mint is never cached or retained.
- During a GitHub outage (`provider_unavailable` on the re-mint) an unexpired
  cached token for the same key is served and the provider is `degraded`.
  Only `provider_unavailable` is masked this way. An expired token is never
  served, a `refresh: true` request never receives a cached token, and no
  cached token is served once the provider is `invalid`.
- The cache is cleared as a whole when the provider goes `invalid` and by
  `clearCache()` (the key-reload trigger). Otherwise entries leave only by
  expiry, `refresh` eviction, eviction on a `repo_not_installed` re-mint, or
  replacement by a newer mint.
- Only Fastify framework rejections (an `FST_*` error code with a `4xx` status)
  become `400 invalid_request`. Any other unexpected error becomes
  `500 internal`, even if it carries a `4xx` status.

## Error Modes

Every non-2xx response has the body
`{ "error": { "code": string, "message": string } }`.

| Code | HTTP status | When |
|------|-------------|------|
| `unauthorized` | `401` | A request to `/v1` or below has no `Authorization: Bearer <key>` header, a malformed one, or a key that matches no registered client. Checked before the body is parsed. The message is always `A valid Tessera client key is required.` and does not say which case applied. |
| `invalid_request` | `400` | Body is not a JSON object, has an unknown field, has an `identity` other than `app`/`user`, has an `access` other than `read`/`write`, has a `repo` not in `owner/name` form, omits `repo` for `app`, or has a non-boolean `refresh` or non-string `subject`. |
| `invalid_request` | `400` | Fastify rejects the request before the route runs (an `FST_*` error with a `4xx` status: for example invalid JSON, an empty JSON body, an unsupported content type, or an oversized body). The message is always `Malformed request body.` and never echoes the body. |
| `invalid_request` | `404` | No route matches the method and path. Under `/v1` this is only returned to an authenticated caller; an unauthenticated one gets `401 unauthorized`. The message is fixed and does not echo the request URL. |
| `policy_denied` | `403` | The request is outside the authenticated client's policy rule (see "Policy"). Checked after validation and before any provider is looked up. The message is fixed per failed check: `The requested identity is not granted to this client.` (no rule, identity not granted, or `user` from a client other than `legate`), `The requested repository is not allowed for this client.` (an `app` repository outside the allowlist), or `The requested access exceeds this client's ceiling.` (access above `max_access`). No message reveals the allowlist or echoes the submitted repository. |
| `provider_unconfigured` | `503` | A request allowed by the policy names an identity with no registered provider: an `app` request when the GitHub App settings are not configured, and every allowed `user` request. |
| `repo_not_installed` | `422` | The App is not installed on the repository owner (both installation lookups return `404`; no mint is attempted); with `TESSERA_GITHUB_INSTALLATION_ID` set, the owner is not the account that installation belongs to, or the installation returns `404` (no mint is attempted); or GitHub refuses the mint with `404` or `422` because the installation does not cover the repository (the cached entry for that key is evicted). |
| `credential_invalid` | `503` | GitHub returns `401` to the app assertion, or the key file cannot be read or parsed. The provider becomes `invalid` until restart. No `Retry-After` header. |
| `provider_unavailable` | `503` | A GitHub call times out (5 seconds), cannot connect, or returns `5xx`; or the bot identity is not yet known. The provider becomes `degraded`. The response carries a `Retry-After` header in seconds: GitHub's numeric `Retry-After` on a `5xx` when present, else `30`. When an unexpired cached token exists for the request's key (and the request is not a `refresh`), that token is served with `200` instead and no error is returned. |
| `mint_failed` | `502` | Any other GitHub failure: another `4xx` (for example `403`, including rate limits), or a response that cannot be parsed. |
| `internal` | `500` | Any other unexpected error, including a non-Fastify error that carries a `4xx` status. The message is `Internal server error.`; the log records the error class only. |

Startup failures of `march tessera serve`:

| Condition | Outcome |
|-----------|---------|
| `--port` or `MARCH_TESSERA_PORT` is not an integer in 1..65535 | Reason printed to stderr, exit status `2`, nothing listens. |
| `TESSERA_CLIENT_KEYS_FILE` is unset or blank | Reason printed to stderr, exit status `2`, nothing listens. Checked after the port and before any other setting, telemetry or GitHub call. |
| The client-keys file cannot be read, or fails any rule in "The client-keys file" | Reason printed to stderr (the setting and entry position only, never the path or file contents), exit status `2`, nothing listens. |
| `TESSERA_POLICY_FILE` is unset or blank | Reason printed to stderr, exit status `2`, nothing listens. Checked after the client-keys file and before the GitHub App settings, telemetry or any GitHub call. |
| The policy file cannot be read, or fails any rule in "Policy" | Reason printed to stderr (the setting and rule position only, never the path or file contents), exit status `2`, nothing listens. |
| A registered client has no policy rule | Not a failure, provided the file has at least one rule: the service starts and denies every request from that client. |
| `TESSERA_GITHUB_INSTALLATION_ID` is set but not a positive integer | Reason printed to stderr, exit status `2`, nothing listens. |
| App id or key file missing | Not a failure: the service starts, logs a warning naming the missing settings, and answers `app` requests with `provider_unconfigured`. |
| GitHub unreachable or failing when the provider starts | Not a failure: the service starts, the provider is `degraded` (or `invalid` if the credential is rejected), and the bot identity lookup is retried on the next `app` request. |
