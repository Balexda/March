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
layout is selected here. User credentials and client/token CLI are future stories.

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
