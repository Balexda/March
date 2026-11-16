# Contracts: Tessera Credential Entitlement Service
<!-- applicability: code-shaped features only -->

Field-level shapes and validation live in the
[data model](tessera-credential-entitlement-service.data-model.md).

## Interfaces
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

### Issue a GitHub Token (HTTP)

**Purpose**: The single way a March process obtains a GitHub credential.
**Consumers**: Herald, Brood, Hatchery, Legate, Statio (via the Node client); steward sessions (via the `gh` wrapper and git credential helper).
**Providers**: `march tessera serve`.

#### Signature

```
POST /v1/github/token
Authorization: Bearer <client key>
Content-Type: application/json
x-march-slice-id: <slice id>          (optional, span correlation only)

{ "identity": "app", "repo": "acme/widgets", "access": "write" }

200
{ "token": "ghs_…", "expires_at": "2026-11-15T19:04:11Z",
  "identity": "march-bot[bot]",
  "commit_identity": { "name": "march-bot[bot]",
                       "email": "123456+march-bot[bot]@users.noreply.github.com" },
  "access": "write", "repo": "acme/widgets" }
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `identity` | `"app" \| "user"` | Yes | Bot installation token or the operator PAT. |
| `repo` | `owner/name` | Yes for `app` | The one repository the token is scoped to. |
| `access` | `"read" \| "write"` | Yes | Mapped to a fixed permission set. |
| `refresh` | boolean | No | Evict the cached token first. |
| `subject` | string | No | Reserved for per-spawn tickets; audited only. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | The credential. Never logged by Tessera or its client. |
| `expires_at` | RFC 3339 \| null | `null` only for a `user` token with no discoverable expiry. |
| `identity` | string | Login the token acts as. |
| `commit_identity` | object \| null | Bot author/committer name and email; `null` for `user`. |
| `access` | string | Level granted. |
| `repo` | string \| null | Scope of the token; `null` for `user`. |

#### Error Conditions

All errors use `{ "error": { "code": "<code>", "message": "<text>" } }`.

| Condition | Response | Description |
|-----------|----------|-------------|
| Missing or unknown client key | 401 `unauthorized` | No audit `caller` beyond `unknown`. |
| Malformed body, unknown field, `app` without `repo` | 400 `invalid_request` | |
| Identity, repo, or access outside the client's policy | 403 `policy_denied` | Errored span; denial metric; audit `denied`. |
| App not installed on the repo's owner or repo | 422 `repo_not_installed` | Scope is never widened to compensate. |
| Provider has no secret or id configured | 503 `provider_unconfigured` | |
| GitHub rejected the credential, or the PAT is expired | 503 `credential_invalid` | Provider state `invalid`. |
| GitHub unreachable or 5xx and no unexpired cached token | 503 `provider_unavailable` | `Retry-After` set. An unexpired cached token is served instead when one exists. |
| Any other mint failure | 502 `mint_failed` | Errored span. |

No error path ever substitutes the `user` identity for `app`, or the reverse.

### Health and Status (HTTP)

**Purpose**: Liveness for the stack, and provider/expiry visibility for the operator.
**Consumers**: `march up`, `march status`, `march doctor`, `march tessera status`, dashboards.
**Providers**: `march tessera serve`.

#### Signature

```
GET /healthz   → 200 { "status": "ok" }

GET /status    → 200
{ "service": "march-tessera", "uptime_s": 4211,
  "providers": [
    { "provider": "github-app",  "state": "ok", "login": "march-bot[bot]",
      "credential_expires_at": null, "expiry_warning": false, "last_error": null },
    { "provider": "github-user", "state": "ok", "login": "octocat",
      "credential_expires_at": "2026-12-01T00:00:00Z", "expiry_warning": false,
      "last_error": null } ],
  "soonest_expiry": "2026-12-01T00:00:00Z",
  "cache": { "entries": 3 } }
```

#### Inputs

None. Both routes are unauthenticated, matching the other March services.

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `providers[]` | Provider Status | One per provider. No token, key, hash, client key, or policy content. |
| `soonest_expiry` | RFC 3339 \| null | Earliest `credential_expires_at` across providers. |
| `cache.entries` | integer | Count only. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Service starting, config invalid | process exits non-zero | Tessera does not serve with a broken policy, key file, or secret path. |

### Node Client

**Purpose**: The one call site through which service code obtains a GitHub credential.
**Consumers**: Herald, Brood, Hatchery, Legate, Statio, the `march tessera` CLI.
**Providers**: the Tessera client module.

#### Signature

```typescript
getGitHubToken(req: {
  identity: "app" | "user";
  repo?: string;              // required for "app"
  access: "read" | "write";
  refresh?: boolean;
  sliceId?: string;           // sent as x-march-slice-id; span correlation only
}): Promise<GitHubEntitlement>;

interface GitHubEntitlement {
  token: string;
  expiresAt: string | null;
  identity: string;
  commitIdentity: { name: string; email: string } | null;
  source: "tessera" | "env-fallback";
}

class TesseraClient {
  constructor(opts?: { baseUrl?: string; clientKey?: string;
                       env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch });
  issueGitHubToken(req): Promise<GitHubEntitlement>;
  status(): Promise<TesseraStatus>;
  reachable(): Promise<boolean>;
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sliceId` | string | No | Forwarded as the `x-march-slice-id` header. |
| `MARCH_TESSERA_URL` | env | Yes | Base URL of Tessera. |
| `MARCH_TESSERA_CLIENT_KEY` | env | Yes | This process's own client key. |
| `MARCH_TESSERA_GH_TOKEN_FALLBACK` | env | No | `1` permits falling back to `GH_TOKEN`/`GITHUB_TOKEN` when Tessera cannot issue. Unset by default. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `source` | enum | `env-fallback` only when the fallback flag is on and was used; logged as a warning and counted. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Tessera error envelope | `TesseraClientError { code, status }` | Code preserved from the server. |
| Tessera unreachable or timed out | `TesseraClientError { code: "unreachable" }` | Bounded timeout; never hangs. |
| Fallback flag off | no env read | `GH_TOKEN`/`GITHUB_TOKEN` are not consulted at all. |
| Fallback flag on, identity `user` | error | The fallback never serves the `user` identity. |

The client may reuse an entitlement in memory until it is within 10 minutes of
`expiresAt`; on a GitHub 401 the caller retries once with `refresh: true`.

### CLI

**Purpose**: Run the service, and give the operator and the steward shims a credential-free control surface.
**Consumers**: Operator; the `gh` wrapper and git credential helper.
**Providers**: `march tessera …`.

#### Signature

```
march tessera serve [--port <n>] [--host <addr>]
march tessera status [--json]
march tessera token --repo <owner/name> --access <read|write> [--identity app]
march tessera secrets import <github-app-key|github-user-token>     (secret on stdin)
march tessera git-credential <get|store|erase>                     (git helper protocol)
```

#### Inputs

| Command | Parameter | Required | Description |
|---------|-----------|----------|-------------|
| `serve` | `--host` | No | Defaults to `127.0.0.1`; the container passes `0.0.0.0`. |
| `token` | `--repo`, `--access` | Yes | Prints the token only, to stdout. |
| `secrets import` | secret name | Yes | Reads the secret from stdin; never from an argument or a file under the shared HOME. |
| `git-credential` | operation | Yes | Reads git's key/value request on stdin. |

#### Outputs

| Command | Output |
|---------|--------|
| `status` | Table or JSON of `/status`. |
| `token` | The token and nothing else on stdout; diagnostics on stderr. |
| `git-credential get` | `username=x-access-token` and `password=<token>` for `github.com`; empty for any other host. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Tessera denies or is unreachable | non-zero exit, message on stderr | No fallback to host credentials. |
| `secrets import` with empty stdin | non-zero exit | Existing secret left untouched. |

### Steward Credential Shims

**Purpose**: Let a steward keep running plain `gh pr create` and `git push` while acting as the bot.
**Consumers**: Steward (agent-deck) sessions on the host.
**Providers**: A `gh` wrapper and git configuration provisioned for steward sessions.

#### Signature

```
gh <args…>
  → resolves the repo from the working directory
  → obtains an app/write token for it
  → exec <real gh> <args…>  with GH_TOKEN=<token>, GH_CONFIG_DIR=<empty dir>

git push / fetch (github.com remotes, ssh or https)
  → rewritten to https
  → credential helper: march tessera git-credential get
  → commit identity per the spec's SD-004 (bot commit_identity is available)
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| wrapper name | file | Yes | Must be named `gh` and precede the real `gh` on the session `PATH`. |
| steward client key | secret | Yes | The `steward` client's key, available to the session but not exported as `GH_TOKEN`. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| exit status | integer | The real `gh`'s exit status and output, unchanged. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Tessera unreachable or denies | non-zero exit, one-line reason on stderr | The real `gh` is not executed; host `~/.config/gh` and any exported `GH_TOKEN` are not used. |
| Repo cannot be resolved from the working directory | non-zero exit | |
| Wrapper would resolve to itself | non-zero exit | Guards against recursion. |

### Provider Interface

**Purpose**: The seam that lets non-GitHub providers be added later.
**Consumers**: The token route.
**Providers**: `github-app`, `github-user` (the only two in v1).

#### Signature

```typescript
interface CredentialProvider {
  readonly id: string;                    // "github-app" | "github-user"
  readonly identity: string;              // "app" | "user"
  start(): Promise<void>;                 // derive login; never throws on GitHub outage
  issue(req: ProviderIssueRequest): Promise<ProviderIssueResult>;
  status(): ProviderStatus;
}
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `req.repo` | string \| undefined | Per provider | Already policy-checked. |
| `req.access` | `"read" \| "write"` | Yes | Already policy-checked. |
| `req.refresh` | boolean | No | |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `token`, `expiresAt`, `identity`, `commitIdentity` | — | As the Entitlement. |
| `cache` | `"hit" \| "miss" \| "n/a"` | For the span and audit record. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| Any failure | typed provider error carrying one of the route's error codes | Providers never decide policy. |

### Service Configuration

**Purpose**: Everything about the GitHub App and operator token is configurable; nothing is hardcoded.
**Consumers**: Operator; `march up`.
**Providers**: `march tessera serve`.

#### Signature

Environment variables read by the service.

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `TESSERA_GITHUB_APP_ID` | string | For `app` | GitHub App id. |
| `TESSERA_GITHUB_INSTALLATION_ID` | integer | No | Pins one installation; when unset, resolved per repository owner. |
| `TESSERA_GITHUB_APP_KEY_FILE` | path | For `app` | Private key, inside Tessera's secret store. |
| `TESSERA_GITHUB_USER_TOKEN_FILE` | path | For `user` | Operator PAT, inside Tessera's secret store. |
| `TESSERA_POLICY_FILE` | path | Yes | Policy rules. |
| `TESSERA_CLIENT_KEYS_FILE` | path | Yes | Client registrations (hashes). |
| `MARCH_TESSERA_PORT` | integer | No | Default `9477` (derived from `march-tessera`). |
| `MARCH_TESSERA_URL` | URL | Consumers | How consumers reach Tessera. |

#### Outputs

| Field | Type | Description |
|-------|------|-------------|
| bot login, commit identity | derived | Read from GitHub at startup. |

#### Error Conditions

| Condition | Response | Description |
|-----------|----------|-------------|
| A secret path resolves under the shared host HOME | startup failure | |
| Policy or client-keys file missing, empty, or invalid | startup failure | |
| A provider's secret absent | service starts; that provider is `unconfigured` | Lets the stack run before the GitHub App exists. |

## Events / Hooks
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Name | Kind | Trigger | Payload / attributes |
|------|------|---------|----------------------|
| `tessera.issue` | span | Every `POST /v1/github/token` | `caller`, `identity`, `provider`, `access`, `cache` (`hit`/`miss`/`n/a`), `outcome`; errored on denial or mint failure. Child of the slice trace when `x-march-slice-id` is present. |
| `tessera.audit` | log event | Every `POST /v1/github/token` | The Issuance Audit Record. |
| `tessera.expiry_warning` | log event (warn) | A credential is within 14 days of expiry; at most once per day | `provider`, `credential_expires_at`. |
| `march.tessera.issuances` | counter | Token issued | `identity`, `provider`, `access`, `cache`. |
| `march.tessera.denials` | counter | Request denied or failed | `identity`, `reason`. |
| `march.tessera.mint.duration` | histogram | GitHub mint call | `provider`, `outcome`. |
| `march.tessera.credential.seconds_until_expiry` | gauge | Periodic | `provider`. |
| `march.tessera.github.rate_limit_remaining` | gauge | Updated from GitHub response headers on each GitHub call | `provider`. |
| `march.tessera.github.secondary_limits` | counter | GitHub returns a secondary-rate-limit error | `provider`. |
| `march.tessera.client.fallbacks` | counter (consumer side) | `env-fallback` used | `service`. |

No metric or span attribute carries a repository name, token, or client key.

## Integration Boundaries
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Boundary | Direction | Contract | Failure mode |
|----------|-----------|----------|--------------|
| GitHub App API | Tessera → GitHub | App JWT; resolve installation for a repo; `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions`; read the app and bot user at startup. | `provider_unavailable`, `credential_invalid`, `repo_not_installed`, `mint_failed`. |
| GitHub user API | Tessera → GitHub | One authenticated probe with the PAT to read its login and expiry header. | Expiry `null` when not discoverable; `credential_invalid` on 401. |
| March services | service → Tessera | Node client with the service's own client key. | Typed error; fail closed unless the migration fallback flag is on. |
| Steward sessions | host process → Tessera on `127.0.0.1` | `gh` wrapper and git credential helper via `march tessera token` / `git-credential`. | Non-zero exit; never falls through to host credentials. |
| Statio | Statio → Tessera | App/read token for its `gh` calls; closes Statio's forge-auth provisioning debt (SD-002). | As any service. |
| Legate → GitHub (Copilot review) | Legate → GitHub with a `user` token | Request Copilot as a reviewer on a newly opened PR. | Errored span; does not block the merge gate. |
| `march up` / `march doctor` | CLI → Tessera | Starts Tessera before its consumers; injects each client key into its own service only; checks wiring and ambient-credential exposure. | Reported by `march doctor`. |
| Docker | compose | Port published on `127.0.0.1` only; joins the `march` network; secret store mounted into Tessera alone; no HOME mount. | Startup failure on a misplaced secret. |
