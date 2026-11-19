# Tessera service contract

Tessera owns bounded, repository-scoped credential issuance. Its deployment follows
[March's vision](../../vision.md) and [operating philosophy](../../operating-philosophy.md):
missing provider credentials allow liveness, and unauthorized issuance fails closed.

## Public Interface

### CLI and configuration

`march tessera serve [--port <n>] [--host <addr>]` runs until SIGTERM or SIGINT,
then closes HTTP and telemetry. Host defaults to `127.0.0.1`. Port precedence is
`--port`, `MARCH_TESSERA_PORT`, then `9477`; invalid ports fail before listening.

| Environment variable | Current behavior |
| --- | --- |
| `TESSERA_GITHUB_APP_ID` | App id; absent id leaves app provider unconfigured. |
| `TESSERA_GITHUB_APP_KEY_FILE` | PEM private key file; absent/empty key or missing file leaves provider unconfigured. Other read failures exit safely. |
| `TESSERA_GITHUB_INSTALLATION_ID` | Optional positive integer installation override. |
| `MARCH_TESSERA_PORT` | Listen port, 1–65535. |
| `MARCH_TESSERA_LOG_DIR` | Durable JSONL directory; default `~/.march/logs`. |
| `MARCH_OTEL` | Set `1` for telemetry; logs remain available when off. |

US2 must supply production authentication and policy enforcement. This slice's
production server denies every issuance request; no environment flag bypasses
that boundary. Tests may inject an authorization boundary. Policy/client-key file
loading belongs to US2. US3 owns secret-store provisioning, shared-HOME path
validation, client-key distribution and stack startup ordering. No secret-store
layout is selected here. The token CLI is still future work; the Node client is documented under [Node Client](#node-client), and user credentials belong to US7.

### HTTP

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Unauthenticated `200 {"status":"ok"}`, including unconfigured startup. |
| `GET /status` | Unauthenticated service/uptime, provider states, soonest expiry and cache entry count. Never credentials or policy. |
| `POST /v1/github/token` | Default `401 unauthorized`; injected authorized callers may issue an app/read or app/write token for exactly one `owner/name`. |

Token requests accept `identity`, `repo`, `access`, optional `refresh` and
`subject`; unknown fields fail validation. Success returns `token`, `expires_at`,
GitHub-derived `identity` and `commit_identity`, `access`, and `repo`.
An optional `x-march-slice-id` header nests the issuance span under that slice's trace.

### Providers

Providers implement `start`, `issue`, and `status` behind `CredentialProvider`.
The registry always exposes `github-app` and `github-user`; a slot without an
implementation reports `unconfigured`. The user provider is reserved for US7.

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

### Runtime and packaging

`npm run build:tessera-image` builds `docker/tessera.Dockerfile` through
`npm run build`; the image launches `tessera serve --host 0.0.0.0`.
`docker/tessera.docker-compose.yml` joins the external `march` network, publishes
only on host loopback, and mounts only its log volume. It receives no HOME,
Docker socket or ambient GitHub credentials. Docker-socket peers and host
stewards retain their preexisting host privileges; this boundary cannot revoke them.

## Invariants

- `/healthz` and `/status` answer without provider credentials; the service listens while every provider is unconfigured.
- Production issuance denies every caller with `401 unauthorized` until US2 supplies authorization; unauthenticated requests never reach a provider or GitHub.
- An app token is scoped to exactly one repository, and GitHub's mint response must name that repository; a pinned installation never broadens scope.
- Permissions come only from the fixed `read` and `write` access profiles; neither profile includes `workflows`.
- `identity` and `commit_identity` are derived from GitHub (`<slug>[bot]` and its numeric user id); configuration cannot override them, and Tessera never substitutes another identity.
- Every GitHub call is bounded by a finite timeout, and the app assertion lives at most 10 minutes.
- Accepted tokens expire in the future and no more than one hour (plus a 60-second clock-skew allowance) after issuance.
- Error messages are fixed per code. A token appears only in the body of a successful, authorized `POST /v1/github/token` response; it never appears in error responses, `/status`, logs or spans. Assertions, private keys, bearer keys and upstream response bodies never appear in any response, `/status`, logs or spans.
- Each token request emits one `tessera.issue` span, marked errored on any non-2xx response; a failed startup identity discovery emits an errored `tessera.discovery` span.

## Error Modes

All token-route failures use the envelope `{"error":{"code":"…","message":"…"}}`.

| Condition | Response | Observable behavior |
| --- | --- | --- |
| Malformed request | `400 invalid_request` | Unknown fields, invalid identity/access/repo, wrong optional-field types, missing `repo` for app identity, or an oversized/unsupported body. |
| Caller not authenticated | `401 unauthorized` | The authorization boundary rejects the caller; in production this is every request. |
| Caller not permitted | `403 policy_denied` | The authorization boundary rejects this caller for the request. |
| App not installed on repo | `422 repo_not_installed` | The installation lookup returns 404/422, or GitHub's mint response does not name exactly the requested repository. |
| Provider unconfigured | `503 provider_unconfigured` | No app id or key is configured, or the requested identity has no provider. |
| Credential invalid | `503 credential_invalid` | GitHub returns 401 or the private key cannot sign; status reports `invalid`. |
| Provider unavailable | `503 provider_unavailable` + `Retry-After` | GitHub returns 5xx/429, the call times out, or the network fails; status reports `degraded`. |
| Mint failed | `502 mint_failed` | Any other GitHub failure, or a malformed, expired, over-long or permission-broadened mint response. |

## Node Client

Tessera's consumer API lives in `src/tessera/client.ts`; types live in
`src/tessera/types.ts` and configuration resolution in `src/tessera/config.ts`.
The token CLI is a separate implementation step.

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
  a client until endpoint, key or fallback configuration changes.
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
