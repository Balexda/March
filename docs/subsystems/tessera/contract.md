# Tessera service contract

Tessera owns bounded, repository-scoped credential issuance. Its deployment follows
[March's vision](../../vision.md) and [operating philosophy](../../operating-philosophy.md):
missing provider credentials allow liveness, and unauthorized issuance fails closed.

## Public Interface

### CLI and configuration

`march tessera serve [--port <n>] [--host <addr>]` runs until SIGTERM or SIGINT,
then closes HTTP and telemetry. Host defaults to `127.0.0.1`. Port precedence is
`--port`, `MARCH_TESSERA_PORT`, then `9477`; invalid ports fail before listening.

`march tessera token --repo <owner/name> --access <read|write> [--identity app] [--refresh] [--allow-migration-fallback]`
issues a repository-scoped GitHub App token using `MARCH_TESSERA_URL` and
`MARCH_TESSERA_CLIENT_KEY`. The token command and Git credential helper
also accept `MARCH_TESSERA_CLIENT_KEY_FILE`, which takes precedence over
the environment key. The file must be a user-owned regular file with
mode `0600`. Identity defaults to `app`. On success stdout
contains only the token and a terminating newline. Invalid arguments,
configuration errors, denial, malformed responses and transport failures exit
non-zero with a sanitized diagnostic on stderr. The command uses the Node
client's 10-second request deadline. After a confirmed GitHub 401, a caller
can use `--refresh` to request a fresh entitlement. Migration fallback requires
both `--allow-migration-fallback` and `MARCH_TESSERA_GH_TOKEN_FALLBACK=1` and uses
the client's warning and counter. `MARCH_TESSERA_SLICE_ID` correlates the
issuance request and client span with the caller's slice.

`march tessera provision [--repos owner/a,owner/b] [--from-gh]` writes
everything Tessera and its consumers need under `~/.march/tessera/`. It reads
and writes nothing outside `~/.march`, so it works from a plain npm install.

| File | Contents |
| --- | --- |
| `clients.json` | One registration per consumer: `hatchery`, `legate`, `herald`, `brood`, `statio` and `steward`. Each holds only the SHA-256 digest of the key. |
| `policy.json` | One grant per consumer over the provisioned repositories. `hatchery`, `herald`, `brood` and `statio` get app/read. `steward` gets app/write. `legate` gets app/write plus the `user` grant used for Copilot review requests. |
| `keys/<client>.key` | Each consumer's raw bearer key, mode `0600`. Keys are generated once and kept on rerun, so running services keep authenticating. The steward key is also written to `~/.march/steward/tessera-client-key`, where `steward-launch` points `MARCH_TESSERA_CLIENT_KEY_FILE`. |
| `github-token` | The operator token Tessera vends, mode `0600`. `--from-gh` writes it from `gh auth token`. Without the flag an existing file is kept. |

The directory and `keys/` are mode `0700`. Repositories come from `--repos`
(`owner/name` or `owner/*`, lowercased and deduplicated). Without `--repos`,
the command lists the profiles registered with Herald (`MARCH_HERALD_URL`) and
uses each profile's GitHub origin. It exits 2 when Herald is unreachable and
`--repos` is absent. Rerunning replaces the repository list in every grant.

`march tessera git-credential <get|store|erase>` reads Git's credential
protocol on stdin. Configure the helper as `!march tessera git-credential`
so Git appends the operation, and enable `credential.useHttpPath` for GitHub.
An HTTPS `github.com` request must supply the target `owner/name[.git]` path.
Successful `get` returns `username=x-access-token` and the repository-scoped
app/write token as `password`. Other hosts receive no credentials. `store` and
`erase` consume the request and exit without persisting credentials. Ambiguous
GitHub requests and issuance failures return `quit=true`, exit nonzero, and
write one sanitized diagnostic to stderr. Git honors the quit instruction
before trying a later helper or prompting.

| Environment variable | Current behavior |
| --- | --- |
| `TESSERA_CLIENT_KEYS_FILE` | Required path to client registrations. |
| `TESSERA_POLICY_FILE` | Required path to entitlement grants. |
| `TESSERA_GITHUB_APP_ID` | App id; absent id leaves app provider unconfigured. |
| `TESSERA_GITHUB_APP_KEY_FILE` | PEM private key file; absent/empty key or missing file leaves provider unconfigured. Other read failures exit safely. |
| `TESSERA_GITHUB_INSTALLATION_ID` | Optional positive integer installation override. |
| `TESSERA_GITHUB_TOKEN_FILE` | Operator-token file (see [Operator-token provider](#operator-token-provider)). It serves the `app` slot when no GitHub App id and key are configured, and always serves the `user` slot. |
| `MARCH_TESSERA_PORT` | Listen port, 1–65535. |
| `MARCH_TESSERA_LOG_DIR` | Durable JSONL directory; default `~/.march/logs`. |
| `MARCH_OTEL` | Set `1` for telemetry; logs remain available when off. |

Both authorization files must be readable regular files containing non-empty
JSON arrays. An unset path, unreadable or empty file, or invalid entry causes
`tessera serve` to exit nonzero before listening. Diagnostics identify the
configuration variable and, for invalid entries, the row number.

- Each registration has `client` and `key_sha256`. Names match
  `^[a-z][a-z0-9-]{0,31}$` and digests contain 64 lowercase hexadecimal
  characters. Names and digests are each unique. Tessera stores only key digests.
- Each grant has a registered `client`, a non-empty `identities` array containing
  `app` or `user`, and `max_access` of `read` or `write`. A grant that includes
  `app` requires a `repos` array of `owner/name` or `owner/*` entries. Repository
  matching is case-insensitive. Only `legate` can have a `user` grant.
- Each request must match an explicit grant. An App request must satisfy the
  identity, repository and access constraints of the same grant. A user request
  requires the `legate` user grant. Repository and access limits apply to App
  credentials.

### HTTP

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Unauthenticated `200 {"status":"ok"}`, including unconfigured and degraded providers. |
| `GET /status` | Unauthenticated service/uptime, provider states, soonest expiry and cache entry count. Never credentials or policy. |
| `POST /v1/github/token` | Authenticated callers with an explicit matching grant can request a token. An App token is scoped to one `owner/name`. |
| `GET /v1/client` | Authenticated. Returns the caller's own `{ "client": "<id>", "grants": [{ "identity", "access", "repos" }] }`: one entry per granted identity, `access` the grant's maximum, `repos` the lowercased `owner/name` or `owner/*` entries (empty for `user`). Never another client's grants, keys or digests, and it mints nothing. A consumer's readiness uses it to prove its key is accepted and its policy covers what it needs. |

Every `/v1/*` request authenticates its bearer key before body validation.
Tessera hashes the supplied key with SHA-256 and compares fixed-length digests in
constant time. Missing or invalid credentials receive `401 unauthorized`,
invalid token requests receive `400 invalid_request`, and requests without a
matching grant receive `403 policy_denied`. Errors use
`{ "error": { "code": "<code>", "message": "<text>" } }`. Denials occur before
provider selection, cache access, refresh or upstream calls.

Token requests accept `identity`, `repo`, `access`, optional `refresh` and the
optional `subject` string. Unknown fields fail validation. Success returns
`token`, `expires_at`, GitHub-derived `identity` and `commit_identity`, `access`,
and `repo`. Supply a non-secret correlation value as `subject`. After validation
it is recorded in the issuance audit and has no effect on authorization or
cache scope.

Denials produce an audit outcome of `denied` and an errored issuance span.
An optional `x-march-slice-id` header with a valid slice ID nests the issuance
span under that slice's deterministic dispatch trace.
Diagnostics omit authorization headers, keys, key digests and tokens.

### Issuance telemetry

Every completed token request writes one `tessera.audit` JSON log event with
`caller`, `identity`, `provider`, `repo`, `access`, `outcome`, `reason`,
`cache`, `expires_at` and `subject`. Unauthenticated callers are `unknown`.
Unavailable request fields and expiry are null, as is the reason for an issued
token. A supplied subject is echoed, or recorded as `[REDACTED]` if it contains
the caller's bearer key or the issued token; the same rule nulls such a `repo`.
Denials and failures carry the typed response code.

With `MARCH_OTEL=1`, each request also emits one `tessera.issue` span. Denials,
failures and successful cache fallback after a failed refresh mark the span
errored. Spans omit repository, expiry and subject.

| Metric | Measurement | Labels |
| --- | --- | --- |
| `march.tessera.issuances` | One count per successful request, including cache fallback | `identity`, `provider`, `access`, `cache` |
| `march.tessera.denials` | One count per denied or failed request | `identity` (or `unknown`), `reason` |
| `march.tessera.mint.duration` | Milliseconds per upstream mint attempt, including failures | `provider`, `outcome` |
| `march.tessera.github.rate_limit_remaining` | Latest valid GitHub remaining-budget header | `provider` |
| `march.tessera.github.secondary_limits` | Count of GitHub responses indicating a secondary limit | `provider` |
| `march.tessera.credential.expiry_remaining` | Whole seconds until known credential expiry, floored at zero | `provider` |
| `march.tessera.credential.expiry_warning` | 1 at 14 days or less, otherwise 0 for known expiry | `provider` |

Cache hits and callers sharing a mint add no mint samples. Rate-limit
measurements use responses from discovery, installation lookup and minting.
Metrics use the same OTel gate as spans. Audit logs remain enabled independently.

### Providers

Providers implement `start`, `issue`, and `status` behind `CredentialProvider`.
The registry always exposes `github-app` and `github-user`; a slot without an
implementation reports `unconfigured`. With `TESSERA_GITHUB_TOKEN_FILE` set, the operator token serves the user slot.
Without it the user slot is unconfigured.
Tessera checks both provider records at startup, every minute, and on
`GET /status`. The response reports the earliest known provider expiry as
`soonest_expiry`, or null when expiry is unknown for both providers. App key
expiry is unknown. Cached App installation tokens count toward `cache.entries`
and their expiry is tracked separately.

A known expiry at 14 days or less sets `expiry_warning` and emits a
`tessera.expiry_warning` log at most once per 24 hours per credential in
the running service. Providers can supply an internal revision marker to
identify replacement credentials that share an expiry. Status exposes only
typed error codes. Unknown expiry produces no expiry metric sample, so the
March — Tessera dashboard can distinguish it from zero seconds remaining.

The App provider caches successful installation bindings by owner and keeps
tokens in memory by installation, repository and fixed permission set. Requests
reuse a token with at least ten minutes remaining and share an in-flight mint
for the same scope. Below ten minutes the provider attempts a new mint. If GitHub
is unavailable, the provider can still serve the matching token until its GitHub
expiry. Status reports the provider as degraded, and the successful HTTP response
still records an errored issuance span with `cache: hit` and reason
`provider_unavailable`. With no live matching token, the request returns the
bounded 503 error. `cache.entries` counts live tokens across providers.
A repository exclusion returned during minting forces a new installation lookup
on the next request for that repository when there is no configured override.

`refresh: true` evicts the matching token and supersedes any pending ordinary
mint for that scope. An explicit refresh fails with the mint error if GitHub
cannot issue a replacement. `GithubAppProvider.reload(credentials)` clears cached
tokens and installation bindings, invalidates older in-flight work and derives
the bot identity again. US3 supplies secret-store change detection.

### Operator-token provider

The GitHub App remains the goal. Until it is configured, Tessera vends the
operator's own token so the stack can run. The token is read from
`TESSERA_GITHUB_TOKEN_FILE`, which must be a regular file of at most 4 KiB with
no group or other permission bits; `march tessera provision --from-gh` writes it.
The provider serves the `app` slot only when the App id or key is absent. It
always serves the `user` slot when the file is set.

- **Start and validation.** Tessera calls `GET https://api.github.com/user` with
  the token and a 5-second timeout. A 200 with a valid `login` and `id` sets
  the state to `ok` and records the login. A 401 sets `invalid` with
  `last_error: credential_invalid`. A network failure, timeout or other non-2xx
  answer sets `degraded` with `last_error: provider_unavailable`, and the next
  request validates again. A missing or empty file is `unconfigured`. A file
  with loose permissions or bad contents is `invalid`.
- **Rotation.** Every request checks the file's inode, size and mtime. A changed
  file is re-read and validated again, so a rotated token takes effect without
  a restart. `refresh: true` forces a re-read and validation, even when it
  arrives while an ordinary re-read is in flight. A replaced token gets a new
  credential revision.
- **Freshness.** An unchanged token is revalidated against `/user` once it is
  older than 5 minutes, so an upstream revocation cannot hide behind an
  unchanged file. The provider-health poll (every 60 s) re-reads the file and
  applies that bound before `/status` is recomputed: a removed file shows as
  `unconfigured` within about a minute, a revoked token as `invalid` within
  about six, at no more than about 12 `/user` calls an hour.
- **Failure reporting.** Each transition into a failure state emits one errored
  `tessera.discovery` span (`provider: operator-token`, `outcome` one of
  `credential_invalid`, `provider_unavailable`, `mint_failed`,
  `provider_unconfigured`) and one warning log, never on every poll and never
  with credential content. Startup and `/healthz` stay up.
- **Issuance.** Client authentication and per-client policy still gate every
  request before the provider is called. An app request returns the token
  with the requested `repo` echoed and `identity` set to the login. `expires_at`
  is now plus one hour: a nominal re-check horizon, not the token's real expiry.
  `commit_identity` comes from the `/user` name and email, falling back to
  `<login>` and `<id>+<login>@users.noreply.github.com`. A user request returns
  the same token with null `expires_at`, `repo` and `commit_identity`. Cache is
  `n/a`.
- **Scope.** The token is the operator's own credential. It is not scoped to
  one repository, and its permissions are whatever the operator's login has.
  Policy repository and access grants are the only bound, which is why the GitHub
  App remains the goal. The token never appears in `/status`, logs, spans or
  error bodies.
- **Status.** `/status` reports the provider honestly in both slots: `state`,
  `login`, `last_error`, and null `credential_expires_at`.

### Runtime and packaging

`npm run build:tessera-image` builds `docker/tessera.Dockerfile` through
`npm run build`; the image launches `tessera serve --host 0.0.0.0`.
`docker/tessera.docker-compose.yml` joins the external `march` network, publishes
only on host loopback, and mounts its log volume plus `~/.march/tessera`
read-only at `/march/tessera`. It sets `TESSERA_CLIENT_KEYS_FILE`,
`TESSERA_POLICY_FILE` and `TESSERA_GITHUB_TOKEN_FILE` to the provisioned files.
`TESSERA_GITHUB_APP_ID` (optional) and `/march/tessera/github-app.pem` configure
the GitHub App. The provisioned files are `0600` and owned by the host user, and
the image's `node` user is uid 1000, so the host uid must be 1000. The service
receives no HOME, Docker socket or ambient GitHub credentials. Docker-socket peers
and host stewards retain their preexisting host privileges; this boundary cannot
revoke them. Startup requires the two authorization files, so run
`march tessera provision` before starting it.

Tessera is in the `march up` / `status` / `down` / `upgrade` service list,
after Castra and before its consumers. Consumers (Hatchery, Legate, Herald,
Brood, Statio) read their key through `MARCH_TESSERA_CLIENT_KEY_FILE`, which
compose points at `~/.march/tessera/keys/<client>.key`. No consumer compose file
forwards `GH_TOKEN`/`GITHUB_TOKEN` or enables the token fallback.

`march doctor` checks the published loopback `/healthz` with a timeout and
checks `GET /v1/client` from each consumer container using its configured key
and URL. It compares the returned client identity to the expected service and
reports accepted, rejected, missing or unverifiable wiring. Only the verdict
returns to Doctor. Stack container inspection reports the names of ambient
`GH_TOKEN` and `GITHUB_TOKEN` variables that are present. Diagnostic output
contains no credential values, fingerprints or raw environment output. See
[March vision](../../vision.md) and [operating philosophy](../../operating-philosophy.md).

## Invariants

- `/healthz` and `/status` answer without provider credentials; the service listens while every provider is unconfigured.
- Production issuance requires an authenticated caller and an explicit policy grant before provider or GitHub access.
- A GitHub App token is scoped to exactly one repository, and GitHub's mint response must name that repository; a pinned installation never broadens scope. The interim operator token is not repository-scoped: policy grants are its only bound.
- Permissions come only from the fixed `read` and `write` access profiles; neither profile includes `workflows`.
- `identity` and `commit_identity` are derived from GitHub (`<slug>[bot]` and its numeric user id for the App; the token's `/user` login, name and email for the operator token); configuration cannot override them, and Tessera never substitutes another identity.
- Every GitHub call is bounded by a finite timeout, and the app assertion lives at most 10 minutes.
- Accepted App tokens expire in the future and no more than one hour (plus a 60-second clock-skew allowance) after issuance. Operator-token entitlements report a nominal one-hour `expires_at`.
- Error messages are fixed per code. A token appears only in the body of a successful, authorized `POST /v1/github/token` response; it never appears in error responses, `/status`, logs or spans. Assertions, private keys, bearer keys and upstream response bodies never appear in any response, `/status`, logs or spans.
- With telemetry enabled, failed startup identity discovery emits an errored `tessera.discovery` span.

## Error Modes

All token-route failures use the envelope `{"error":{"code":"…","message":"…"}}`.

| Condition | Response | Observable behavior |
| --- | --- | --- |
| Malformed request | `400 invalid_request` | Unknown fields, invalid identity/access/repo, wrong optional-field types, missing `repo` for app identity, or an oversized/unsupported body. |
| Caller not authenticated | `401 unauthorized` | The bearer header is absent, malformed or unknown. The audit uses caller `unknown`. |
| Caller not permitted | `403 policy_denied` | The authorization boundary rejects this caller for the request. |
| App not installed on repo | `422 repo_not_installed` | The installation lookup returns 404/422, or GitHub's mint response does not name exactly the requested repository. |
| Provider unconfigured | `503 provider_unconfigured` | No app id or key is configured, or the requested identity has no provider. |
| Credential invalid | `503 credential_invalid` | GitHub returns 401 or the private key cannot sign; status reports `invalid`. |
| Provider unavailable | `503 provider_unavailable` + `Retry-After` | GitHub returns 5xx/429, the call times out, or the network fails; status reports `degraded`. |
| Mint failed | `502 mint_failed` | Any other GitHub failure, or a malformed, expired, over-long or permission-broadened mint response. |

## Node Client

Consumers can name the key with `MARCH_TESSERA_CLIENT_KEY_FILE`, which takes
precedence over `MARCH_TESSERA_CLIENT_KEY`. The file must be a regular file
owned by the process user, with mode `0600`, of at most 4 KiB. A named file that
violates these rules leaves the client unconfigured. The client fails closed and
never falls back to the environment key.

Tessera's consumer API lives in `src/tessera/client.ts`; types live in
`src/tessera/types.ts` and configuration resolution in `src/tessera/config.ts`.

`TesseraClient` accepts optional `baseUrl`, `clientKey`, `env` and `fetchImpl`.
Explicit settings override `MARCH_TESSERA_URL` and
`MARCH_TESSERA_CLIENT_KEY`; both are trimmed before validation and use, and
there is no implicit endpoint or credential.
Missing or invalid configuration produces `TesseraClientError` with code
`unconfigured`. URL credentials, query strings and fragments are rejected. Because the client key
is a bearer credential, plain `http:` is accepted only for loopback hosts,
single-label compose service names (for example `march-tessera`) and private IPv4
literals (10/8, 172.16/12, 192.168/16); any other host must use `https:`.

- `issueGitHubToken({ identity, repo?, access, refresh?, sliceId? })` returns
  `{ token, expiresAt, identity, commitIdentity, source }`. App requests require
  an `owner/name` repository. Identity is `app` or `user`, access `read` or
  `write`. The client authenticates `POST /v1/github/token` with its bearer key
  and forwards `sliceId` as `x-march-slice-id`.
- `getGitHubToken(req)` is the process-environment convenience call. It retains
  a client (and its token cache) until the endpoint, the resolved key or the
  fallback configuration changes. The key compared is the one actually read,
  so a key file provisioned after the first call, or replaced at the same path,
  takes effect on the next call.
- `client({ timeoutMs? })` calls the authenticated `GET /v1/client` and returns
  `{ client, grants }`. A bad or revoked key rejects with code `unauthorized`.
- `status()` returns the wire `TesseraStatus` shape from `GET /status`:
  `service`, `uptime_s`, `providers`, `soonest_expiry`, and `cache.entries`.
- `reachable()` probes only `GET /healthz` and returns false on failure. It
  never issues a token. Health and status requests omit authorization.

Requests finish within 10 seconds, including body consumption; health probes
finish within 3 seconds. Transport failures and timeouts use `unreachable`.
Known server error codes and HTTP status survive in `TesseraClientError.code`
and `.status`. Malformed JSON, invalid shapes and scope mismatches use
`invalid_response`. Error messages are fixed text; raw bodies, transport error
messages, URLs, headers and secrets never enter diagnostics. Redirects fail
closed. Returned entitlements are validated before reuse.

Each client owns an in-memory cache keyed by requested identity, repository
and access. Entries are reusable only while more than ten minutes remain.
`refresh: true` evicts the matching entry before issuance, even when issuance
fails; callers can use this for one retry after a GitHub 401. Unknown-expiry
user tokens and ambient fallbacks are never cached. Returned values are copies.

Fallback is a temporary, explicit migration mechanism: only after issuance
fails, only for `app`, and only when `MARCH_TESSERA_GH_TOKEN_FALLBACK=1`, the
client reads `GH_TOKEN`, then `GITHUB_TOKEN`. Each is trimmed and checked on its
own, and a value containing CR/LF is treated as absent, so an invalid `GH_TOKEN`
does not block a valid `GITHUB_TOKEN`. Without an available token the
original typed error survives. A fallback has `source: env-fallback`, null
expiry and commit identity, and `identity: unknown` because ambient tokens
have no verified login. It never substitutes a Tessera user identity.

Every fallback warns through the pino service logger (stderr and
`$HOME/.march/logs/tessera-client.jsonl`) (if the durable log cannot be opened, the
warning is written to stderr only and the fallback still succeeds) and increments
`march.tessera.client.fallbacks` when OTel is enabled. The bounded `service`
label is derived from `MARCH_OTEL_SERVICE_NAME`, accepting March's six consumers
(`herald`, `brood`, `hatchery`, `legate`, `statio`, `steward`, with optional
`march-` prefix); all other values become `unknown`. Logs contain only the
fixed event and bounded service. The Tessera client dashboard shows fallback
rates by service. OTel follows the existing `MARCH_OTEL=1` bootstrap convention;
warning logs remain enabled independently.

These bounded, unattended failures and explicit credential access follow
[March's vision](../../vision.md) and
[operating philosophy](../../operating-philosophy.md).
