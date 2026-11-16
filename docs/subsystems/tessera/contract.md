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

Service code reaches Tessera through the Node client's `getGitHubToken` (see
"Node client"). It fails closed: the environment token is used only behind an
explicit migration flag, and only for `app`. No existing service calls it yet.
From a shell, `march tessera token` prints an `app` token and never falls back
to host credentials (see "CLI: `march tessera token`").

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

### Node client

Service code gets a GitHub credential by calling one function. It speaks only
HTTP to `POST /v1/github/token` and imports nothing from the server module.

```ts
// src/tessera/client.ts exports getGitHubToken, TesseraClient and TesseraClientError.
const { token } = await getGitHubToken({ identity: "app", repo: "owner/name", access: "write" });
```

**Request** (`GitHubTokenRequest`):

| Field | Meaning |
|-------|---------|
| `identity` | `"app"` (the GitHub App bot) or `"user"` (the operator's token). |
| `repo` | `owner/name`. Required for `app`. |
| `access` | `"read"` or `"write"`. |
| `refresh` | Optional. `true` skips the in-memory cache and asks Tessera for a fresh credential. Use it once after GitHub answers `401` with a token you were given. |
| `sliceId` | Optional. Sent as the `x-march-slice-id` header so the request joins that slice's trace. Never sent in the body and never part of the cache key. |

**Result** (`GitHubEntitlement`, frozen):

| Field | Meaning |
|-------|---------|
| `token` | The credential. Never log it. |
| `expiresAt` | RFC 3339 time, or `null` when no expiry is known. |
| `identity` | The login the token acts as. |
| `commitIdentity` | `{ name, email }` to commit as, or `null` (always `null` for `user`). |
| `source` | `"tessera"`, or `"env-fallback"` when the migration fallback served the call (see below). |

**Settings** read by the calling process:

| Setting | Meaning |
|---------|---------|
| `MARCH_TESSERA_URL` | Where Tessera is. Default `http://localhost:<MARCH_TESSERA_PORT>`, which is `http://localhost:9477` when the port is not set. |
| `MARCH_TESSERA_CLIENT_KEY` | This service's own client key, sent as `Authorization: Bearer <key>`. |
| `MARCH_TESSERA_GH_TOKEN_FALLBACK` | Migration fallback. Only the exact value `1` turns it on; unset, `0`, `true` or anything else leaves it off. Off by default. |

**Errors.** Every failure is a `TesseraClientError` with a `code`, plus the
HTTP `status` when Tessera answered and `retryAfterSeconds` when Tessera sent a
numeric `Retry-After`. The codes are the server's codes from `## Error Modes`,
passed through unchanged, plus two that the client raises itself:

| Code | When |
|------|------|
| `unreachable` | Tessera could not be reached, did not answer within the timeout, or sent a response that is neither an entitlement nor an error envelope. |
| `client_key_missing` | `MARCH_TESSERA_CLIENT_KEY` is unset or blank. Raised before any request. |

A request that is invalid locally (for example `app` without `repo`) fails with
`invalid_request` before any request is sent. So does a `MARCH_TESSERA_PORT`
that is not an integer in 1..65535 when `MARCH_TESSERA_URL` is unset: building
the client never throws, and the call fails with `invalid_request` and a fixed
message naming `MARCH_TESSERA_PORT` (not its value), checked after the request
itself and before the client key. Each request is bounded by a 10-second
timeout (`DEFAULT_TESSERA_TIMEOUT_MS`) that covers both the response headers and
the body, so the call never hangs.

**Reuse.** The client keeps entitlements in memory, never on disk, keyed by
identity, repository (ignoring case) and access level. A cached entitlement is
returned without asking Tessera while more than ten minutes remain before its
`expiresAt`; inside the last ten minutes the next call fetches a new one. An
entitlement with no expiry is never cached, and neither is a failure.
`refresh: true` always fetches and replaces the entry. Without an explicit
`client`, `getGitHubToken` reads `MARCH_TESSERA_URL`, `MARCH_TESSERA_PORT` and
`MARCH_TESSERA_CLIENT_KEY` from the env of each call (`options.env`, else
`process.env`) and uses a shared client for that base URL and key: calls with
the same configuration share one client and its cache, and a call with a
different configuration gets its own. A call whose key is not set gets a fresh
client that is not kept, so a key set later is used by the next call. At most
eight shared clients are kept; the oldest is dropped first. `TesseraClient` can
also be constructed directly; each instance has its own cache.

**Fail closed.** By default every failure surfaces as the typed error, and
`GH_TOKEN` and `GITHUB_TOKEN` are not read at all.

**Migration fallback.** While services move onto Tessera, setting
`MARCH_TESSERA_GH_TOKEN_FALLBACK=1` lets `getGitHubToken` hand back the
environment token instead of failing. All of these must hold:

- the request is for the `app` identity (the fallback never serves `user`, and
  the environment token is not read for a `user` request);
- the failure is one of `unreachable`, `client_key_missing`,
  `provider_unavailable`, `provider_unconfigured`, `credential_invalid`,
  `mint_failed` or `internal`;
- `GH_TOKEN`, or else `GITHUB_TOKEN`, is set and not blank. If neither is, the
  original error is raised.

`unauthorized`, `policy_denied`, `invalid_request` and `repo_not_installed`
never fall back, and neither does any error that is not a
`TesseraClientError`. A fallback result is
`{ token, expiresAt: null, identity: "", commitIdentity: null, source: "env-fallback" }`
and is never cached, so the next call asks Tessera again. Each fallback logs
one warning, with the failure code as `reason`, the identity and the calling
service, and adds one to the counter `march.tessera.client.fallbacks`, whose
only label is `service`: the caller's `service` option, else
`MARCH_OTEL_SERVICE_NAME`, else `unknown`. A value that does not match
`^[a-z][a-z0-9-]{0,63}$` is recorded as `unknown`, in both the counter and the
warning. The counter is a no-op when telemetry is off. When the caller passes
no logger, the warning goes to `tessera-client.jsonl` in the call's
`MARCH_TESSERA_LOG_DIR` (default `~/.march/logs`; one logger per file) and, with telemetry on, to the OTel logs pipeline; it never
goes to stdout. No warning, log line or error message contains a token or a
client key.

Open questions: which failures should allow the fallback is a working
assumption (spec debt SD-017), not a settled decision. The empty `identity` on
a fallback result is also a working assumption (SD-019), because the token's
login is not known without asking GitHub.

Not in this client yet: `status()` and `reachable()` on `TesseraClient`, the
`march tessera status` command, and the git credential helper
(`march tessera git-credential`) come in later changes. The shell seam
`march tessera token` is described below. No existing service uses `getGitHubToken` yet; moving each one off
`GH_TOKEN` is a later change too.

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

### CLI: `march tessera token`

```
march tessera token --repo <owner/name> --access <read|write> [--identity app]
```

Prints a GitHub App token for one repository. The command only speaks HTTP to
Tessera's token route, so it works from a plain npm install.

| Option | Default | Meaning |
|--------|---------|---------|
| `--repo <owner/name>` | none; required | Repository the token is scoped to. Must pass the same `owner/name` rules as the token route. |
| `--access <read\|write>` | none; required | Access level to request. |
| `--identity <identity>` | `app` | Only `app` is offered. The `user` identity is not available from this command. |

It reads `MARCH_TESSERA_URL` (else `http://localhost:<MARCH_TESSERA_PORT or
9477>`) and `MARCH_TESSERA_CLIENT_KEY`, exactly as the Node client does.

**Output.** On success, stdout gets the token and a newline, and nothing else.
Nothing else in the command writes to stdout, so `$(…)` captures the bare token.
This holds with telemetry on (`MARCH_OTEL=1`) too. Before printing, the command
checks that the token is printable ASCII with no whitespace or control
characters (`^[\x21-\x7e]+$`). A token that fails the check is treated as an
invalid answer from Tessera: the `unreachable` failure line below, exit `1`,
and the token is never echoed.

**Failures.** stdout stays empty. stderr gets one line of the form
`march tessera token: <fixed text> (<code>)`, where `<code>` is the client error
code (see "Node client"); `provider_unavailable` adds `, retry after <n>s` when
Tessera sent a `Retry-After`. The text is fixed per code, with one exception:
an `invalid_request` the client detects locally (no HTTP status, e.g. a bad
setting) says the request or a client setting such as `MARCH_TESSERA_PORT` is
invalid. It never echoes the server's message, a token or the client key. A
missing client key names `MARCH_TESSERA_CLIENT_KEY`. An unexpected error prints
a generic line.

**Bad flags.** An unknown option (e.g. a misspelt `--acess`), an option with no
value, or an extra positional word is rejected while parsing, before any
request. stdout stays empty (no help text), stderr gets the parser's error
message and a pointer to `march tessera token --help`, and the exit status is
`2` (usage). `march tessera token --help` is an explicit request for help: it
prints help to stdout and exits `0`.

| Condition | Exit status |
|-----------|-------------|
| Token printed | `0` |
| `--repo` missing or not `owner/name`, `--access` missing or not `read`/`write`, `--identity` other than `app`, an unknown option, an option with no value, or an extra positional | `2` (usage). Checked before any request. |
| Tessera answered with a token that is not printable ASCII | `1` (`unreachable`) |
| Any Tessera failure: `unauthorized`, `policy_denied`, `provider_unconfigured`, `repo_not_installed`, `credential_invalid`, `provider_unavailable`, `mint_failed`, `internal`, `invalid_request`, `unreachable` or `client_key_missing` | `1` |

**No fallback to host credentials.** The command calls
`TesseraClient.issueGitHubToken` directly, not `getGitHubToken`. It ignores
`MARCH_TESSERA_GH_TOKEN_FALLBACK` and never reads `GH_TOKEN`, `GITHUB_TOKEN` or
any other host credential. If Tessera cannot issue a token, the command fails.

Example:

```sh
GH_TOKEN="$(march tessera token --repo acme/widgets --access write)" gh pr create --fill
```

The token then sits in the environment of that `gh` process for as long as it
runs.

Not built yet: `march tessera git-credential` (the git credential helper) and
`march tessera status` come in later changes.

### Audit and telemetry

Every `POST /v1/github/token` request leaves the same three records, whatever
its result: one `tessera.audit` log event, one `tessera.issue` span and one
counter increment. That covers issued tokens and requests rejected for a
missing key, a bad body, the policy or a provider failure. No other route
produces any of them. All three are written from Fastify's response hook
(`src/tessera/server.ts`), which runs for rejected requests too, and all three
are built from the same audit record (`buildAuditRecord` in
`src/tessera/audit.ts`), so they always agree.

#### The `tessera.audit` log event

One `info` line per token request, with the message `tessera.audit` and the
record under the `audit` key, written to the Tessera service log
(`tessera.jsonl`, stdout and, when telemetry is on, the OTel logs pipeline).
The record holds exactly these fields. The builder copies them one by one from
a per-request context, so a value added to that context never reaches the log
unless the builder names it.

| Field | Type | Meaning |
|-------|------|---------|
| `caller` | string | The authenticated client's name. `"unknown"` when the request never authenticated (a missing, malformed or unknown key). |
| `identity` | `"app"`, `"user"` or `null` | The identity requested. `null` when the request was rejected before its body was validated. |
| `provider` | `"github-app"`, `"github-user"` or `null` | The provider the request was handed to. `null` when no provider was reached: rejected before dispatch, denied by the policy, or no provider registered for the identity. |
| `repo` | string or `null` | The repository the caller asked for, as validated. `null` when absent (a `user` request) or not yet validated. It is the request's repository, not proof that a token was minted for it. |
| `access` | `"read"`, `"write"` or `null` | The access level requested; `null` when not yet validated. |
| `outcome` | `"issued"`, `"denied"` or `"failed"` | See the outcome rule below. |
| `reason` | error code or `null` | The error code the request was answered with (see `## Error Modes`); `null` only when issued. |
| `cache` | `"hit"`, `"miss"` or `"n/a"` | Whether the issued token came from the cache. `"n/a"` unless a token was issued. |
| `expires_at` | RFC 3339 string or `null` | Expiry of the issued token; `null` unless a token was issued (or when the provider reports none). |
| `subject` | string or `null` | The request's `subject`, echoed when sent, cut to at most 256 characters; `null` when not sent or not yet validated. |

Outcome rule: a `2xx` response that issued a token is `issued`; every `4xx` is
`denied`, including `unauthorized` (401), `invalid_request` (400) and
`repo_not_installed` (422) as well as `policy_denied` (403); every `5xx` is
`failed`. `reason` is the error code in both cases. This is a working
assumption: the specification only fixes `policy_denied` as `denied`, and
whether malformed or uninstallable requests should count as `failed` instead is
an open question (SD-021 in the User Story 8 tasks).

Fields not resolved before the request was rejected are `null`. A `401` record
therefore has `caller: "unknown"` and every other field `null` (with `cache:
"n/a"`), and a `400` for a malformed body has the caller's name and nothing else.

When telemetry is on, the line also carries `trace_id` and `span_id`, the ids of
that request's `tessera.issue` span, beside the `audit` record rather than in
it, so Grafana can link the log line and the span. They are absent when
telemetry is off.

#### The `tessera.issue` span

One span per token request, with the request's own start and end times.

| Attribute | Value |
|-----------|-------|
| `tessera.caller` | As `caller` in the audit record (`"unknown"` when unauthenticated). |
| `tessera.identity` | `app`, `user`, or `none` when unresolved. |
| `tessera.provider` | `github-app`, `github-user`, or `none` when no provider was reached. |
| `tessera.access` | `read`, `write`, or `none` when unresolved. |
| `tessera.cache` | `hit`, `miss` or `n/a`. |
| `tessera.outcome` | `issued`, `denied` or `failed`. |
| `tessera.reason` | The error code; present only when not issued. |

The span's status is error unless the outcome is `issued`. When the request
carries a valid `x-march-slice-id` header, the span is a child in that slice's
trace: it is parented on the slice's deterministic root span id and takes a
fresh span id of its own, so it never becomes the trace's root. Without the
header, or with a value that is not a valid slice id, the span starts a trace
of its own. When telemetry is off nothing is emitted and nothing fails.

#### Counters

Exactly one of these is incremented per token request.

| Counter | When | Labels |
|---------|------|--------|
| `march.tessera.issuances` | The outcome is `issued`. | `identity` (`app`, `user`), `provider` (`github-app`, `github-user`), `access` (`read`, `write`), `cache` (`hit`, `miss`) |
| `march.tessera.denials` | The outcome is `denied` or `failed`. | `identity` (`app`, `user`), `reason` (an error code from `## Error Modes`) |

Every label value comes from the closed set listed. An unresolved identity (a
`401` or `400`), and any value outside its set, is recorded as the one
placeholder `none`, so no caller-supplied string can become a label. No label
carries a repository, a client name, a client key or a token. The consumer-side
`march.tessera.client.fallbacks` counter (see "Node client") is separate.

#### Logger redaction

The Tessera service logger and the Node client's logger replace the value of
any field named `token`, `authorization`, `clientKey`, `key_sha256` or
`password`, at the top level or one level down, plus `headers.authorization`
and `req.headers.authorization`, with `[redacted]`. This is a second layer: no
Tessera log call names such a field in the first place. Other services'
loggers are not redacted this way.

No token, client key, key hash or `Authorization` header is ever written to a
log line, a span or a metric. A test drives issued, cached, refreshed, denied
and failed requests, including an error whose message contains a token and a
key, at the most verbose log level, and checks every log line, span attribute,
metric label, `/status` body and error body for them.

### Configuration

| Setting | Side | Meaning |
|---------|------|---------|
| `MARCH_TESSERA_PORT` | consumer and server | Port. Default `9477`, derived from the service name `march-tessera` in the 8800-9799 band. |
| `MARCH_TESSERA_URL` | consumer | Base URL March processes use to reach Tessera; read by the Node client (`src/tessera/client.ts`). Default `http://localhost:<MARCH_TESSERA_PORT>`. |
| `MARCH_TESSERA_CLIENT_KEY` | consumer | This process's own client key, sent by the Node client as the bearer credential. Unset or blank fails with `client_key_missing` before any request. |
| `MARCH_TESSERA_GH_TOKEN_FALLBACK` | consumer | `1` turns on the Node client's migration fallback to `GH_TOKEN`/`GITHUB_TOKEN` (see "Node client"). Any other value, or unset, leaves it off. |
| `MARCH_TESSERA_LOG_DIR` | consumer and server | Directory for the server log file `tessera.jsonl` and the Node client's `tessera-client.jsonl`. Default `~/.march/logs`; the container uses `/march/logs` on the `march-tessera-logs` volume. |
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
replace it, by passing a GitHub client to `runTesseraServer`. Tests likewise
pass the numeric `port: 0` with an `onListening` callback to `runTesseraServer`
to bind an OS-assigned port; the CLI and `MARCH_TESSERA_PORT` still reject `0`.

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
- The Node client fails closed. Unless `MARCH_TESSERA_GH_TOKEN_FALLBACK` is
  exactly `1`, it never reads `GH_TOKEN` or `GITHUB_TOKEN`. The fallback
  serves only `app` requests, only for the failures listed in "Node client",
  is never cached, and is always logged as a warning and counted.
- The Node client raises only `TesseraClientError`, never the server's error
  classes (a malformed `MARCH_TESSERA_PORT` included), and its errors and logs
  never contain a token or a client key.
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
  the method, matched route, status class and duration; a token request also
  logs its `tessera.audit` line (see "Audit and telemetry"). Unexpected errors log
  the error class only, not the message.
- Every token request yields exactly one `tessera.audit` event, one
  `tessera.issue` span and one increment of either `march.tessera.issuances`
  or `march.tessera.denials`; no other route yields any of them.
- No token, client key, key hash or `Authorization` header is ever written to
  a log, a span or a metric. The audit record is an allow-list, and the
  Tessera loggers redact credential-bearing fields as a second layer.
- No metric label or span attribute carries a repository, a token or a client
  key, and metric labels never carry a client name.
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
