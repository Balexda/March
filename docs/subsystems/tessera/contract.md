# Tessera service contract

Tessera owns bounded, repository-scoped credential issuance. Its deployment follows
[March's vision](../../vision.md) and [operating philosophy](../../operating-philosophy.md):
missing provider credentials allow liveness, and unauthorized issuance fails closed.

## CLI and configuration

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

## HTTP

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Unauthenticated `200 {"status":"ok"}`, including unconfigured startup. |
| `GET /status` | Unauthenticated service/uptime, provider states, soonest expiry and cache entry count. Never credentials or policy. |
| `POST /v1/github/token` | Default `401 unauthorized`; injected authorized callers may issue an app/read or app/write token for exactly one `owner/name`. |

Token requests accept `identity`, `repo`, `access`, optional `refresh` and
`subject`; unknown fields fail validation. Success returns `token`, `expires_at`,
GitHub-derived `identity` and `commit_identity`, `access`, and `repo`.
Errors use `{"error":{"code":"…","message":"…"}}`:
`400 invalid_request`, `401 unauthorized`, `403 policy_denied`,
`422 repo_not_installed`, `503 provider_unconfigured`, `503 credential_invalid`,
`503 provider_unavailable` (with Retry-After), or `502 mint_failed`.
Identity fallback is forbidden. User provider remains unconfigured.

## Runtime and packaging

`npm run build:tessera-image` builds `docker/tessera.Dockerfile` through
`npm run build`; the image launches `tessera serve --host 0.0.0.0`.
`docker/tessera.docker-compose.yml` joins the external `march` network, publishes
only on host loopback, and mounts only its log volume. It receives no HOME,
Docker socket or ambient GitHub credentials. Docker-socket peers and host
stewards retain their preexisting host privileges; this boundary cannot revoke them.

Providers implement `start`, `issue`, and `status` behind `CredentialProvider`.
GitHub calls time out, scoped permissions exclude workflows, and safe issuance
and discovery traces record classified outcomes without upstream bodies or secrets.
