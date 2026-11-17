# Tasks: Mint a Downscoped Bot Token

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 1
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 01

## Scope and Implementation Boundaries

| Concern | Plan |
|---------|------|
| Ownership | Service behavior lives in `src/tessera/`; CLI dispatch stays thin in `src/cli/program.ts`. Follow `src/statio/` for Fastify, lifecycle and packaging conventions. |
| Authorization | US2 owns key-file loading and policy enforcement. Provide an injectable authorization boundary for allowed-client contract tests; production issuance denies all requests until US2 supplies it. Never copy Statio's optional-auth behavior. |
| Providers | US1 implements `github-app` and the registry seam. Reserve `github-user` as unconfigured; US7 implements it without changing the token route. |
| Deployment | US1 supplies the image and unconfigured compose service. US3 owns secure secret storage/import, HOME-path validation, client-key distribution, reload detection and stack startup ordering. Do not select a storage scheme from open debt. |
| Client | US4 owns the thin Node client and token CLI, independently against the wire contract. US1 adds only the serve command. |
| Observability | Include safe logs and issuance spans with the new path. US8 owns the complete audit schema, metrics, expiry warnings, doctor and dashboard. Follow [vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for bounded unattended issuance. |
| Verification | Functional tasks include fake-GitHub and HTTP contract coverage in existing npm test layers; no real GitHub access. Each implementation slice runs `npm run typecheck`, `npm run build`, and `npm test`, plus AGENTS.md CLI checks when dispatch changes. |

## Slice 1: Serve Repository-Scoped App Entitlements

**Goal**: Run Tessera and issue single-repository bot entitlements through its HTTP contract, with bounded failures and unconfigured-provider startup.

**Justification**: Delivers a complete uncached issuance path exercisable through an injected allowed client and fake GitHub. Production remains closed until US2 provides authorization.

**Addresses**: FR-001 (service packaging; client belongs to US4), FR-002 (provider seam; user implementation belongs to US7), FR-003, FR-005–FR-007, FR-009–FR-010, FR-042–FR-043; AS 1.1, 1.5–1.7 (uncached failure path).

### Tasks

- [ ] **Define issuance models and provider selection**

  Add request, entitlement, provider and typed-error models under `src/tessera/`, following the data model and Provider Interface contract. Introduce provider selection and an authorization boundary for AS 1.1 and 1.7 without implementing US2 policy or US7 PAT behavior.

  _Acceptance criteria:_
  - Validation rejects unknown fields and invalid identity, access, repository or optional-field types.
  - Provider selection never substitutes identities; absent providers return the contracted unconfigured error.
  - Production authorization defaults to deny; tests can supply an allowed caller without an environment bypass.
  - Fixed access profiles alone determine permissions, excluding workflows under the current spec default.

- [ ] **Implement bounded GitHub App discovery and minting**

  Implement the app provider under `src/tessera/` using replaceable GitHub transport for AS 1.1 and 1.5–1.7. Resolve installations and bot identity from GitHub, honoring the installation override without broadening repository scope.

  _Acceptance criteria:_
  - App authentication signs bounded-lifetime assertions; every GitHub operation has a finite timeout.
  - Minting satisfies AS 1.1 for both fixed access profiles and exactly one repository.
  - Owner lookup and installation override preserve AS 1.5, including installations excluding the repository.
  - GitHub-derived login and numeric bot user id determine commit identity; configuration cannot override them.
  - Missing app id or secret leaves the provider unconfigured; failed identity discovery degrades it and later success recovers it.
  - Fake-GitHub coverage exercises discovery, minting and typed failures without calling real GitHub.

- [ ] **Expose issuance and provider health over HTTP**

  Add Fastify routes and service configuration under `src/tessera/`, using Statio's server structure as guidance. Implement the token and health/status contracts for AS 1.1 and 1.5–1.7, keeping GitHub-specific behavior behind the provider interface.

  _Acceptance criteria:_
  - Allowed-client requests return the complete contracted entitlement and error envelope.
  - Health remains available without app credentials; status reports provider state without secret values.
  - Outages, invalid credentials, absent installations and other mint failures use contracted status/code mappings; unavailable responses include Retry-After.
  - Unauthorized requests never invoke GitHub; malformed allowed-client requests fail validation.
  - HTTP contract coverage includes success, typed failure and unconfigured-provider responses against fake dependencies.

- [ ] **Trace issuance without exposing credentials**

  Integrate issuance with `src/observability/logger.ts` and deterministic trace helpers, following `src/observability/statio-trace.ts`. Include denial and failure spans from the first runnable service; US8 adds full audit, metrics and dashboard coverage.

  _Acceptance criteria:_
  - Each issuance request emits a span, nested under the supplied slice id when present.
  - Denial and provider failure mark spans errored; failed startup identity discovery also emits an errored span.
  - Safe structured logs distinguish issuance success and typed failures.
  - Tokens, assertions, private keys, bearer keys, hashes and upstream response bodies never appear in captured logs, spans, status or errors.

- [ ] **Package the runnable Tessera service**

  Add `src/tessera/serve.ts`, thin dispatch in `src/cli/program.ts`, and image/compose assets under `docker/`. Follow existing lifecycle and build conventions, delivering AS 1.7 without choosing US3's secret-store implementation.

  _Acceptance criteria:_
  - The contracted serve command and host/port overrides work from the built npm CLI.
  - Missing provider credentials do not prevent listening; signal shutdown closes HTTP and telemetry cleanly.
  - Image build wiring uses the npm build path and launches Tessera serve.
  - Compose joins the March network, publishes on loopback only, and mounts neither HOME nor Docker socket nor ambient GitHub credentials.
  - Compose header explains unconfigured startup, the US2 authorization prerequisite and US3 deployment boundary, including residual Docker-socket and host-steward risks.
  - `docs/subsystems/tessera/contract.md` documents the implemented surface, configuration and authorization prerequisite; affected CLI contract documentation is updated.

**PR Outcome**: Tessera starts without app credentials, reports provider state, and exercises bounded repository-scoped issuance through an authorized test boundary; live issuance stays denied until US2 lands.

## Slice 2: Reuse and Refresh Installation Tokens Safely

**Goal**: Reuse scoped tokens, share concurrent mints, and survive outages only while matching cached credentials remain unexpired.

**Justification**: Adds observable availability and latency improvements to working issuance without mixing deployment or consumer migration work.

**Addresses**: FR-004, FR-009–FR-010, FR-042–FR-043; AS 1.2–1.4, 1.6.

### Tasks

- [ ] **Cache scoped tokens and share concurrent mints**

  Extend the app provider in `src/tessera/` with the Cached Installation Token lifecycle for AS 1.2–1.4. Keep cache and in-flight coordination in the provider so installation bindings and permissions remain part of each cache decision.

  _Acceptance criteria:_
  - Cache reuse and proactive refresh satisfy AS 1.2–1.3; tokens with ten minutes or more remaining are fresh.
  - Concurrent requests for one key share one mint as in AS 1.4; failed in-flight work clears for later retries.
  - Installation, repository and permission differences never share entitlements.
  - Tokens persist only in memory and expiry comes from GitHub's mint response.

- [ ] **Preserve bounded outage recovery and explicit invalidation**

  Extend provider failure and invalidation behavior in `src/tessera/` for AS 1.6 and the refresh contract. Coordinate refresh, expiry and key changes with in-flight minting so invalidated work cannot repopulate stale credentials.

  _Acceptance criteria:_
  - Failed proactive mint during an outage serves a matching token only while unexpired, with degraded status and an errored span.
  - Missing or expired entries fail within the timeout with the contracted error, never using another identity or ambient token.
  - Explicit refresh evicts before issuance; refresh failure cannot reuse the evicted token.
  - Key replacement invalidates affected tokens and bindings and re-derives identity through the provider reload boundary; US3 supplies secret-store change detection.
  - Fake-GitHub HTTP coverage exercises AS 1.2–1.4 and 1.6; status cache counts and `docs/subsystems/tessera/contract.md` reflect the lifecycle.

**PR Outcome**: Repeat callers reuse scoped tokens, concurrent callers avoid duplicate mints, and outages return only valid cached credentials or bounded typed failures.

## Specification Debt

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
| SD-009 | inherited from spec: The Copilot review request must happen exactly once per PR (FR-032, User Story 7 scenario 3, SC-008), but no idempotency mechanism is given: Legate's working state is rebuilt from the Herald fold, so after a restart it would request again unless a transition event in the fold or a check of GitHub's requested reviewers prevents it. | plan-review:Logical gap | Important | Low | resolved | Resolved 2026-11-16 in the spec — durable `review.requested` record per spec `2026-11-16-014-legate-per-verb-review-requests-and-merge-gates`. |

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Serve Repository-Scoped App Entitlements | — | — |
| S2 | Reuse and Refresh Installation Tokens Safely | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Enforce a Default-Deny Policy per Client | depended upon by | Supplies production authentication/policy through the deny-by-default seam. US1 tests inject an allowed caller; production issuance requires US2. |
| User Story 3: Keep Credentials Only in Tessera | depended upon by | Owns secret provisioning, reload detection and stack wiring; US1 provides provider reload/invalidation. |
| User Story 4: Fetch Tokens Through One Client | depended upon by | Proceeds independently against the wire contract; end-to-end use requires US1 and US2. |
| User Story 7: Request a Copilot Review as the Operator | depended upon by | Implements the reserved user-provider slot without changing the route. |
| User Story 8: See Issuances, Expiry and Health | depended upon by | Extends baseline health/status and safe tracing with complete audit, metrics, doctor and dashboard coverage. |
