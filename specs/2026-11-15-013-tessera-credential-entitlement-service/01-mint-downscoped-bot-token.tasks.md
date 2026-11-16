# Tasks: Mint a Downscoped Bot Token

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 1
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 01

---

## Slice 1: Serve Tessera with an Unconfigured Provider
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: `march tessera serve` runs as a containerized Fastify service that answers `/healthz` and a minimal `/status`, validates `POST /v1/github/token`, dispatches through a provider interface, and fails `app` requests with `provider_unconfigured` because no GitHub App is configured.

**Justification**: This is a working service on its own: it starts, reports its state, and returns the typed errors of the contract. It fixes the route, the error envelope and the provider seam that Slice 2 plugs into without changing the route.

**Addresses**: FR-001, FR-002, FR-007, FR-009, FR-010, FR-042, FR-043; Acceptance Scenario 1.7

### Tasks

- [x] **Define Tessera types, typed errors and configuration**

  Create `src/tessera/types.ts` and `src/tessera/config.ts`, following the shape of `src/statio/types.ts` and `src/statio/config.ts`. Types cover the credential provider interface, the Entitlement and Provider Status shapes, the fixed Access Profile permission map (data model "Access Profile") and one typed error per code in the contracts "Error Conditions" table that US1 owns. Config resolves the port and the GitHub App settings listed under contracts "Service Configuration".

  _Acceptance criteria:_
  - Default port is the value derived from the service name `march-tessera`, and `MARCH_TESSERA_PORT` overrides it
  - An invalid port value is rejected with a typed validation error
  - A missing app id or key file yields an unconfigured provider config, not a throw
  - The access-profile map is a constant in code; `write` is a superset of `read` and excludes `workflows`
  - Server-side settings use `TESSERA_*` names; consumer-side `MARCH_TESSERA_*` names stay separate
  - No client-key or policy-file setting is read (US2)

- [x] **Serve the token route, health and minimal status**

  Add `src/tessera/server.ts` with a build function that takes an injected provider registry, as the Statio server builder takes its adapter. `POST /v1/github/token` validates the Entitlement Request (data model), dispatches on `identity` to the registered provider, and maps typed errors to the contracts error envelope. `/healthz` and `/status` follow contracts "Health and Status", limited to service, uptime, provider states and cache entry count. Add the HTTP contract test `src/tessera/server.test.ts`, which drives the route, `/healthz` and `/status` through an injected provider registry. Satisfies AS 1.7.

  _Acceptance criteria:_
  - Malformed body, unknown field, bad `access`, or `app` without `repo` returns `invalid_request`
  - An identity with no configured provider returns `provider_unconfigured`; `/healthz` stays ok
  - A `user` request is never served by the app provider (FR-009)
  - Each typed error maps to the status and body in the contracts table; `provider_unavailable` carries `Retry-After`
  - The route contains no GitHub-specific logic and applies no caller authentication (US2)
  - `/status` and captured log output contain no token or key material
  - Request and response bodies are never logged
  - The HTTP contract test covers `invalid_request` and `provider_unconfigured` over HTTP, plus the `/healthz` and `/status` shapes

- [x] **Register `march tessera serve` and the service logger**

  Add `src/tessera/serve.ts` and a Tessera logger factory in `src/observability/logger.ts`, mirroring the Statio entrypoint and logger. Register a `tessera` command group with a `serve` subcommand in `src/cli/program.ts`, beside the Statio group. The entrypoint builds the provider registry from config, so an unconfigured GitHub App still serves.

  _Acceptance criteria:_
  - `march tessera serve` accepts port and host options and starts the server
  - The bare `march tessera` command prints group help and exits with a usage status
  - An invalid port exits with a usage error before the server starts
  - The service shuts down cleanly on a termination signal
  - Logs go to a Tessera log file under a `MARCH_TESSERA_LOG_DIR` override
  - No token, secrets, or credential-helper subcommands are added (US3, US4)
  - No Tessera metrics module is introduced (US8)

- [x] **Add the Tessera image and compose file**

  Add `docker/tessera.Dockerfile` and `docker/tessera.docker-compose.yml`, modeled on the Statio pair, plus a `build:tessera-image` npm script chained into `build:images`. Add `src/tessera/container-artifacts.test.ts` on the pattern of the Statio artifact test. The compose header documents setup and the optional GitHub App settings, and states that the secret store and client keys arrive with US3.

  _Acceptance criteria:_
  - The compose file joins the external `march` network and publishes the port on `127.0.0.1` only
  - The container healthcheck targets `/healthz`
  - No host HOME mount, Docker socket, `GH_TOKEN` or `GITHUB_TOKEN` appears in the compose file
  - GitHub App settings are optional pass-throughs; the service starts without them
  - The image installs neither `gh` nor `git`
  - The artifact test fails on a non-loopback port publication

- [x] **Create the Tessera subsystem contract and registry entries**

  Create `docs/subsystems/tessera/contract.md` from `docs/subsystems/contract-scaffold.md`, and add Tessera to `docs/subsystems/subsystems.json` and `docs/subsystems/contract-freshness.config.json` in the same change, since the contract check requires both entries to agree. Document the token route, health and status, and the error codes this slice can return.

  _Acceptance criteria:_
  - The contract has `## Public Interface`, `## Invariants` and `## Error Modes`
  - The freshness entry's contract path and public source paths point at the Tessera contract and `src/tessera`
  - Invariants state that `/v1/*` is unauthenticated until US2 and that the service is loopback-only
  - Invariants state that no identity is ever substituted for another
  - The advisory contract check reports no error for the new subsystem

**PR Outcome**: A runnable, containerized `march tessera serve` that reports health and status, validates token requests, and fails `app` requests with `provider_unconfigured`. It mints nothing yet.

---

## Slice 2: Mint Downscoped Installation Tokens
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: With a configured GitHub App, `POST /v1/github/token` returns an installation token restricted to one repository and one access profile, together with its expiry, the bot login and the bot commit identity. Every GitHub call is bounded and every failure is a typed error.

**Justification**: This is the capability the story exists for. It plugs into the Slice 1 provider interface with no route change and is verified end to end against a fake GitHub API.

**Addresses**: FR-002, FR-003, FR-005, FR-006, FR-009, FR-010, FR-042, FR-043; Acceptance Scenarios 1.1, 1.5, 1.6 (bounded failure)

### Tasks

- [x] **Sign the GitHub App assertion with node:crypto**

  Add a signer module under `src/tessera/providers/github-app/` that produces the short-lived RS256 app assertion from the app id and the private key file. The repository has no JWT dependency and none is added. An unreadable or unparseable key is a `credential_invalid` condition.

  _Acceptance criteria:_
  - The assertion verifies against the matching public key
  - The issuer is the app id; issued-at is backdated to tolerate clock skew; lifetime stays under GitHub's ten-minute cap
  - An unparseable key yields `credential_invalid`
  - No key material appears in any error message or log line

- [x] **Add a bounded GitHub client and a fake GitHub fixture**

  Add a thin client in the same directory, with an injectable API base URL, covering app lookup, installation lookup per owner, installation token creation and bot user lookup. Add a reusable in-process fake GitHub API under `src/tessera/testing/` that records calls and injects failures; later tasks and the contract test use it (FR-042). Failure classification lives in one place.

  _Acceptance criteria:_
  - Every call has a timeout; a hanging fake produces `provider_unavailable` within the bound
  - Network errors and 5xx map to `provider_unavailable`; a rejected app credential maps to `credential_invalid`
  - A missing installation, or a mint refused because the installation excludes the repository, maps to `repo_not_installed`
  - Any other failure maps to `mint_failed`
  - The fake can report mint call counts, set token expiry, and simulate an uninstalled owner
  - Authorization headers are never logged; no test reaches the real network

- [x] **Implement the github-app provider**

  Add the provider implementing the Slice 1 interface. It resolves the Installation Binding per owner, or uses the configured installation id when set, mints a token for the one requested repository with the access profile's permissions, and derives the bot login and commit identity from GitHub. It maintains Provider Status per the data model lifecycle. Satisfies AS 1.1, AS 1.5 and the bounded-failure clause of AS 1.6.

  _Acceptance criteria:_
  - The mint request names exactly one repository and exactly the profile's permissions
  - The response carries every Entitlement field for the `app` identity
  - An uninstalled owner returns `repo_not_installed` and no mint is attempted; scope is never widened
  - The installation override skips the lookup; only successful lookups are remembered, and a binding is dropped when a mint against it reports not-found
  - Bot login and commit identity come from GitHub and cannot be set by configuration
  - A failed identity lookup leaves the provider `degraded`, refuses mints with `provider_unavailable`, and is retried on a later request
  - A rejected credential sets provider state `invalid`

- [x] **Register the provider and extend the contract**

  Register the github-app provider in `src/tessera/serve.ts` when it is configured, extend the HTTP contract test in `src/tessera/server.test.ts` to drive the route against the fake GitHub API, and update `docs/subsystems/tessera/contract.md` for the success response and the provider error modes.

  _Acceptance criteria:_
  - An unconfigured app still yields `provider_unconfigured` (AS 1.7 preserved)
  - The contract test reaches the success shape and each US1 error code over HTTP
  - `/status` reports the provider state and login, and no secret
  - The contract documents the downscoping invariant and each error mode
  - The compose header names the settings that configure the app

**PR Outcome**: Tessera mints downscoped bot tokens against a fake GitHub API and fails closed with typed, bounded errors. Each request mints afresh until Slice 3.

---

## Slice 3: Cache, Coalesce and Serve Through Outages
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Minted tokens are cached per (installation, repository set, permission set), re-minted when fewer than ten minutes remain, shared among concurrent requests, and served during a GitHub outage while still unexpired.

**Justification**: This is isolated behavior inside the provider layer with its own acceptance scenarios. It changes no route and no response shape, and is tested with an injectable clock against the fake GitHub API.

**Addresses**: FR-004, FR-009, FR-010, FR-043; Acceptance Scenarios 1.2, 1.3, 1.4, 1.6 (cached-token clause)

### Tasks

- [x] **Cache installation tokens with a ten-minute re-mint threshold**

  Add an in-memory token cache under `src/tessera/providers/github-app/`, owned by the github-app provider because the key needs the installation id. It implements the Cached Installation Token entity and lifecycle from the data model, honours the request's `refresh` flag, and reports its entry count on `/status`. Satisfies AS 1.2 and AS 1.3.

  _Acceptance criteria:_
  - A repeat request with more than ten minutes left makes no GitHub call
  - A request with less than ten minutes left mints a new token
  - Different repositories or access levels never share an entry
  - `refresh` evicts the entry before issuing
  - The clock is injectable; nothing is written to disk
  - The cache can be cleared as a whole, for the key-reload transition US3 wires

- [ ] **Share one mint among concurrent requests**

  Make concurrent requests for the same cache key await a single in-flight mint. Satisfies AS 1.4.

  _Acceptance criteria:_
  - Concurrent identical requests produce one mint call and receive the same token
  - Requests for different keys do not wait on each other
  - A failed mint is not retained; the next request mints again

- [ ] **Serve an unexpired cached token when GitHub is unavailable**

  When a re-mint fails with `provider_unavailable` and the cached token for that key is unexpired, serve it and mark the provider `degraded`; otherwise the error propagates. Satisfies the cached-token clause of AS 1.6 and transition 4 of the cache lifecycle.

  _Acceptance criteria:_
  - An outage with an unexpired entry returns that entry
  - An outage with no entry or an expired entry returns `provider_unavailable`
  - `repo_not_installed`, `credential_invalid` and `mint_failed` are never masked by a cached token
  - An expired token is never served
  - The contract's Invariants document the cache key, the threshold, coalescing and outage behavior

**PR Outcome**: Tokens are reused and coalesced, and a short GitHub outage does not interrupt callers that hold a live cache entry. All of AS 1.1–1.7 hold.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Where should the app private key and PAT be stored? Option 1: a named docker volume mounted only into Tessera and filled by an npm-safe `march tessera secrets import`. Host stewards running as the operator can't read it, but it adds an import step. Option 2: a host directory outside `$HOME`, wired through compose `secrets:`. That is simpler, but any process running as the operator uid, including every steward pane, can read it. (Recommended: named volume.) | Non-Functional Quality | High | Medium | inherited | — |
| SD-002 | inherited from spec: Where should the plaintext per-service client keys persist between `march up` runs? `~/.march` is mounted into every container, so following the castra-token precedent would let any container read every key. Options: (a) 0600 files under `~/.march`, following the castra precedent; (b) only hashes kept in Tessera's volume, with plaintext keys regenerated and re-injected on every `march up` so services restart onto fresh keys; (c) a separate host directory outside the shared HOME. (Recommended: b.) | Domain & Data Model | High | Medium | inherited | — |
| SD-003 | inherited from spec: How should a steward pane receive its Tessera client key? Options: (a) a 0600 key file beside `~/.march/steward` that the wrapper and helper read; (b) a pane env var injected by Castra/agent-deck at launch, which would have to be exempt from the tmux-env scrub; (c) a key minted per steward session. Every option is reachable by other processes on the host; the policy caps the damage at app/write. | Interaction & UX | Medium | Low | inherited | — |
| SD-004 | inherited from spec: Which identity should steward commits carry? Options: (a) the bot as author and committer, with the noreply email, so history fully reflects the bot; (b) the operator stays author and the bot is only the push/PR identity; (c) the bot as committer with a `Co-authored-by:` trailer for the operator. The brief's motivation, "history misrepresents authorship", points to (a) or (c), but the brief only says *PRs* are bot-authored. | Domain & Data Model | High | Medium | inherited | — |
| SD-005 | inherited from spec: How should v1 handle steward pushes that touch `.github/workflows/*`? GitHub rejects those without `workflows:write`. Options: (a) leave it out of write, so such pushes fail closed and the steward escalates; (b) add an opt-in `write+workflows` access level that the policy grants per client or per repo; (c) include it in the default write profile. | Integration | Medium | Medium | inherited | — |
| SD-006 | inherited from spec: SD-001 is open between a named volume filled by `march tessera secrets import` and a host directory outside `$HOME` wired through compose `secrets:`, but FR-020, User Story 3 scenario 4 and the CLI contract make the CLI import mandatory — option 1's mechanism — so the artifacts effectively commit to it. | plan-review:Internal contradiction | Important | Low | inherited | — |
| SD-007 | inherited from spec: SD-002 is open, but User Story 3 scenario 3 and FR-019 ("each service receives its own client key and no other service's key") quietly exclude option (a) if "receives" means "can obtain", and the data model calls the client-keys file "operator-owned" although option (b) has `march up` write it. | plan-review:Internal contradiction | Important | Low | inherited | — |
| SD-008 | inherited from spec: `march doctor` must check that each service's client key is accepted (FR-040, User Story 8 scenario 6), but the only authenticated route is `POST /v1/github/token`; checking a key would mean minting a real token or sending a deliberately invalid body, and doctor's access to every plaintext key depends on SD-002. | plan-review:Logical gap | Important | Low | inherited | — |
| SD-009 | inherited from spec: The Copilot review request must happen exactly once per PR (FR-032, User Story 7 scenario 3, SC-008), but no idempotency mechanism is given: Legate's working state is rebuilt from the Herald fold, so after a restart it would request again unless a transition event in the fold or a check of GitHub's requested reviewers prevents it. | plan-review:Logical gap | Important | Low | inherited | — |
| SD-010 | Slice 3, task "Serve an unexpired cached token when GitHub is unavailable", serves the cached token only when the re-mint fails with `provider_unavailable`, and says `repo_not_installed`, `credential_invalid` and `mint_failed` are never masked. The data model's Cached Installation Token lifecycle item 4 (`stale` → `stale`) fires whenever a re-mint fails while the old token is unexpired, with no limit on the failure class. The narrower rule in the tasks is probably the intended one, but the two artifacts disagree. | plan-review:Internal contradiction | Important | Low | open | — |
| SD-011 | The spec's Edge Cases list includes "GitHub returning a secondary rate limit on mint". In Slice 2, task "Add a bounded GitHub client and a fake GitHub fixture", only network errors and 5xx map to `provider_unavailable`, and any other failure maps to `mint_failed`. That sends a secondary-rate-limit 403/429 to `mint_failed` without `Retry-After`, and Slice 3 will not serve a cached token for it. No task says how this edge case is classified. | plan-review:Logical gap | Important | Low | open | — |
| SD-012 | `resolveGitHubAppConfig` treats a key-file path that is set but does not exist the same as an unset one: the service starts unconfigured and logs the setting as missing. The contracts' Health and Status error conditions say Tessera does not serve with a broken key file or secret path, which suggests a set-but-unreadable key file should exit non-zero, while the Slice 1 acceptance criterion says a missing app id or key file yields an unconfigured provider. The two disagree on whether a set-but-nonexistent path is fatal or unconfigured. | implementation-review:Broken contracts | Important | Low | open | — |
| SD-013 | `classifyGitHubFailure` maps every 422 from installation-token creation to `repo_not_installed`. GitHub returns 422 both when a requested repository is not accessible to the installation and when the requested permissions are not granted to the installation (the App lacks one of the access profile's permissions). A misconfigured App is therefore reported as not installed on the repository, and the owner's binding is dropped on every such failure. Distinguishing the two means reading GitHub's response message text; the alternative is to keep one code and name both causes in its message. | implementation-review:Error handling gaps | Important | Low | open | — |

Of the inherited items, only SD-005 touches this story: the `write` access profile excludes `workflows` pending that decision.

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Serve Tessera with an Unconfigured Provider | — | — |
| S2 | Mint Downscoped Installation Tokens | S1 | — |
| S3 | Cache, Coalesce and Serve Through Outages | S2 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Enforce a Default-Deny Policy per Client | depended upon by | US2 adds client-key authentication and policy in front of the token route this story ships unauthenticated, and extends the HTTP contract test. |
| User Story 3: Keep Credentials Only in Tessera | depended upon by | US3 adds the secret store, the HOME-path refusal, stack registration in `march up`, the compose security paragraph, and the key-reload trigger that clears this story's cache. |
| User Story 4: Fetch Tokens Through One Client | depended upon by | US4's client speaks the wire contract this story serves; it can be built in parallel against the contracts file. |
| User Story 7: Request a Copilot Review as the Operator | depended upon by | US7 registers the operator-token provider behind the provider interface from Slice 1. |
| User Story 8: See Issuances, Expiry and Health | depended upon by | US8 adds audit events, the `tessera.issue` span, metrics, and the remaining `/status` fields to the route and providers built here. |
