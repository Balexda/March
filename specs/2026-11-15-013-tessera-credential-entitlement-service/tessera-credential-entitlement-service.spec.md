# Feature Specification: Tessera Credential Entitlement Service

**Spec Folder**: `2026-11-15-013-tessera-credential-entitlement-service`
**Branch**: `feature/secret-service`
**Created**: 2026-11-15
**Status**: Draft
**Input**: Operator description — build Tessera, the single March service that holds GitHub credentials and hands out scoped, short-lived entitlements, so that PRs are authored by a GitHub App bot while Copilot reviews are still requested as the operator.
**Source Feature Map**: — (Tessera is Castra/Statio-scale infrastructure specified directly from an operator description; no feature map.)

## Clarifications
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Session 2026-11-15

This spec cites [`docs/vision.md`](../../docs/vision.md) and
[`docs/operating-philosophy.md`](../../docs/operating-philosophy.md). Like Castra
and Statio, Tessera is an infrastructure seam with no row in the per-component
table. It applies all three rules of thumb: credentials are provisioned at
deploy and never negotiated per request (rule 1); every GitHub access is declared
in a policy and scoped to one repository and one access level (rule 2); and a
denied or failed issuance is a typed, bounded error, never a hang or a silent
fallback to another identity (rule 3).

Where the codebase audit contradicts the operator's brief, the audit wins and
the difference is recorded here.

- _The sessions that run `git push` and `gh pr create` are host-side stewards: agent-deck panes on the host tmux server, running as the operator's uid. Spawn worker containers hold no GitHub credential and never push. This spec says "steward" throughout and drops "workers" and "castra" from the policy (Castra makes no GitHub calls). Corrected v1 policy: herald, brood, hatchery and statio get app/read; steward gets app/write; legate gets app/write plus user. Default is deny._ `[Critical Assumption]`
- _Scrubbing the steward environment is a requirement. `march up` removes only the Castra token from the tmux environment today, so `GH_TOKEN`/`GITHUB_TOKEN` reach every steward pane. `march up` must remove them from the tmux anchor environment and from an already-running tmux server's global environment. The `gh` wrapper and the credential helper must not rely on the scrub alone: each call overrides any inherited token with the Tessera token and points `gh` at an empty config directory so the host `~/.config/gh/hosts.yml` is never read._ `[Critical Assumption]`
- _The wrapper must be an executable literally named `gh`, earlier on the steward `PATH`, because the steward PR skill's allowed-tools match the literal `gh pr create` / `gh pr view`. Steward origin remotes are ssh, so an HTTPS credential helper never fires unless github.com remotes are rewritten to HTTPS for steward sessions; the helper plus that rewrite is the push path._ `[Critical Assumption]`
- _Statio becomes an app/read client of Tessera. Tessera issues credentials; Statio runs `gh`. This resolves Statio's open SD-002 (forge-auth provisioning) and retires its "only forge-credentialed image" claim; updating that spec's row is a back-reference made when Statio is migrated, not new debt here._ `[Critical Assumption]`
- _Whether a fine-grained PAT can add Copilot as a reviewer is verification work inside User Story 7, with a classic token as the documented fallback. The review request is idempotent and never blocks the merge gate._ `[Critical Assumption]`
- _The rate-limit budget is a verification and observability requirement, not a design choice. An installation token has its own budget, separate from the operator's PAT; moving Herald's reads to the app separates the two. Remaining budget or secondary-limit errors are exposed as a low-cardinality metric._ `[Critical Assumption]`
- _Bot authorship changes any logic that depends on the PR author: PR discovery by author, bot-review filtering (which treats `[bot]` logins as reviewers to ignore), and the steward==reviewer comment dedup. These must handle operator-authored and bot-authored PRs side by side during migration._ `[Critical Assumption]`
- _Secrets never resolve under the shared host HOME. Tessera does not mount HOME and refuses to start if a secret path resolves under it. The goal is "no ambient or accidental use", not isolation: Hatchery, Brood and Castra mount the Docker socket (root-equivalent) and host stewards share the operator's uid. Narrowing the HOME mount for the other services is flagged here, not done._ `[Critical Assumption]`
- _Health follows house convention: `GET /healthz` and `GET /status`, both unauthenticated and reachable only on `127.0.0.1` and the `march` network. There is no `/v1/health`. `/status` carries provider state, soonest expiry and logins, never secret values._
- _The installation is resolved per repository owner and cached, with `TESSERA_GITHUB_INSTALLATION_ID` as an override. A repo the app is not installed on yields `repo_not_installed`; scope is never widened. `repo` is required for the `app` identity in v1._
- _The bot login and the bot's noreply commit identity are derived from GitHub at startup. If that lookup fails the provider is degraded and `/status` says so._
- _PAT expiry is read from GitHub's token-expiration response header. When absent, expiry is reported as unknown. The warning fires at 14 days or less._
- _Tokens are cached per (installation, repo set, permission set) and re-minted when fewer than 10 minutes remain. During a GitHub outage a cached token is served while it has life; otherwise the request fails. Concurrent requests for the same key share one mint. Tessera never falls back from the app identity to the user identity._
- _Access profiles are fixed: read = metadata, contents, pull requests, issues, checks and statuses (read); write = read plus contents, pull requests and issues (write). Legate's squash merge and reactions fit inside write._
- _Audit records are structured log events; there is no audit database. The logger has no redaction today, so a test asserts that no token appears in log output. Tessera's only durable state is its secret store and config files._
- _Consumers use `MARCH_TESSERA_URL` and `MARCH_TESSERA_CLIENT_KEY`; the service keeps the operator's `TESSERA_*` names. Tessera is registered in the stack ahead of its consumers. The `GH_TOKEN` fallback sits behind `MARCH_TESSERA_GH_TOKEN_FALLBACK`, off by default. All operator CLI subcommands work from a plain npm install._
- _In a request, `identity` is the kind (`app` or `user`). In a response, `identity` is the login string and `commit_identity` is a separate name/email pair._

## Artifact Hierarchy
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

RFC → Milestone → Feature → User Story → Slice → Tasks

This spec has no parent RFC or feature map. Its user stories are the unit
`smithy.cut` slices into implementation PRs; each PR updates
`docs/subsystems/tessera/contract.md` and the compose header it touches.

## User Scenarios & Testing *(mandatory)*
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: optional -->

### User Story 1: Mint a Downscoped Bot Token (Priority: P1)

As a March service, I want to ask Tessera for a GitHub token scoped to one repository and one access level so that I act as the bot with no more access than the task needs.

**Why this priority**: This is the service itself. Nothing else in the spec works without a running Tessera that can mint an installation token.

**Independent Test**: Against a fake GitHub API, request an app token and assert the mint request body, the response shape, cache reuse, and re-mint near expiry. No real GitHub call.

**Acceptance Scenarios**:

1. **Given** a configured GitHub App and an allowed client, **When** the client requests `app` / `write` for `acme/widgets`, **Then** Tessera mints an installation token restricted to that repository and the write permission set, and returns the token, its expiry, the bot login, and the bot commit identity.
2. **Given** a token was issued for a (installation, repo, access) key, **When** the same request arrives with more than 10 minutes of life left, **Then** the cached token is returned and GitHub is not called.
3. **Given** a cached token with less than 10 minutes left, **When** it is requested again, **Then** a new token is minted.
4. **Given** two concurrent requests for the same key and no cache entry, **When** both are processed, **Then** GitHub receives one mint call.
5. **Given** the app is not installed on the repository's owner, **When** a token is requested, **Then** the request fails with `repo_not_installed` and no broader token is issued.
6. **Given** GitHub is unreachable, **When** a request arrives for a key with an unexpired cached token, **Then** that token is served; **and when** no unexpired token exists, **Then** the request fails with `provider_unavailable` within a bounded time.
7. **Given** no GitHub App is configured yet, **When** Tessera starts, **Then** it serves, reports the provider as unconfigured, and fails app requests with `provider_unconfigured`.

---

### User Story 2: Enforce a Default-Deny Policy per Client (Priority: P1)

As an operator, I want each March service to have its own Tessera key and a policy naming what it may request so that a service can obtain only the identities, repositories and access it needs.

**Why this priority**: Without per-caller identity Tessera is the shared token under another name. Policy must exist before any consumer is wired.

**Independent Test**: Start Tessera with a client-keys file and a policy file and no GitHub at all; assert 401 for an unknown key and 403 for each out-of-policy request.

**Acceptance Scenarios**:

1. **Given** a request with no key or an unknown key, **When** it reaches `/v1/*`, **Then** it is rejected as `unauthorized`.
2. **Given** the `herald` client is allowed app/read, **When** it requests app/write, **Then** it is rejected as `policy_denied`.
3. **Given** a client allowed a set of repositories, **When** it requests a repository outside that set, **Then** it is rejected as `policy_denied`.
4. **Given** any client other than `legate`, **When** it requests the `user` identity, **Then** it is rejected as `policy_denied`.
5. **Given** a known client with no policy rule, **When** it requests anything, **Then** it is rejected (default deny).
6. **Given** a policy file that names an unknown client, grants `user` to a non-legate client, or is missing, **When** Tessera starts, **Then** it exits with an error instead of serving.

---

### User Story 3: Keep Credentials Only in Tessera (Priority: P1)

As an operator, I want the app private key and my PAT to live only where Tessera can read them so that no other container, and no steward acting on its own, can pick them up.

**Why this priority**: The stack's containers share the host HOME. Placing the secrets wrongly would make Tessera's policy meaningless on day one.

**Independent Test**: Inspect the rendered compose configuration and assert the secret store is mounted into Tessera only and Tessera has no HOME mount; start Tessera with a secret path under the shared HOME and assert it refuses to start.

**Acceptance Scenarios**:

1. **Given** the stack's compose files, **When** they are rendered, **Then** only the Tessera service mounts the secret store, Tessera mounts no host HOME, and its port is published on `127.0.0.1` only.
2. **Given** a secret path that resolves under the shared host HOME, **When** Tessera starts, **Then** it exits with an error naming the path.
3. **Given** a fresh host, **When** the operator runs `march up`, **Then** Tessera starts before the services that consume it, and each service receives its own client key and no other service's key.
4. **Given** the operator has a new app key or PAT, **When** they import it through the CLI, **Then** the secret is stored without passing through a command-line argument or a file under the shared HOME, and Tessera picks it up without a rebuild.
5. **Given** the Tessera compose file, **When** a reader opens its header, **Then** it documents the setup steps, the host-specific configuration, and a security paragraph stating the secret placement and the residual risks.

---

### User Story 4: Fetch Tokens Through One Client (Priority: P1)

As a March service author, I want one call that returns a GitHub token for an identity, repository and access level so that no service reads `GH_TOKEN` from its environment.

**Why this priority**: Every consumer migration and the steward shims depend on this client and the CLI seam built on it. Its wire contract is fixed in the contracts file, so it can be built in parallel with the service.

**Independent Test**: Drive the client against a fake Tessera; assert caching, typed errors, the fail-closed default, and that the environment token is read only when the fallback flag is on.

**Acceptance Scenarios**:

1. **Given** a reachable Tessera, **When** a service asks for an app/read token for a repository, **Then** it receives the entitlement and may reuse it until 10 minutes before expiry.
2. **Given** the fallback flag is unset and Tessera is unreachable, **When** a token is requested, **Then** the call fails with a typed error within a bounded time and `GH_TOKEN`/`GITHUB_TOKEN` are not read.
3. **Given** the fallback flag is set and Tessera cannot issue an app token, **When** a token is requested, **Then** the environment token is returned, marked as a fallback, logged as a warning and counted.
4. **Given** the fallback flag is set, **When** the `user` identity is requested and Tessera cannot issue it, **Then** the call fails; the fallback never stands in for the `user` identity.
5. **Given** an operator at a terminal, **When** they run the token command for a repository, **Then** only the token is written to standard output.

---

### User Story 5: Stewards Open Pull Requests as the Bot (Priority: P1)

As an operator, I want stewards to keep running plain `gh pr create` and `git push` while acting as the bot so that March's PRs are authored by the bot and I can approve them.

**Why this priority**: This is the outcome the whole feature exists for.

**Independent Test**: Run the `gh` wrapper and the git credential helper against a fake Tessera in a session that has `GH_TOKEN` exported and a populated host `gh` config; assert the real `gh` and git receive only the Tessera token, and that both fail closed when Tessera is down.

**Acceptance Scenarios**:

1. **Given** a steward session in a worktree of an allowed repository, **When** the steward runs `gh pr create`, **Then** the real `gh` runs with a fresh bot token for that repository and the PR is authored by the bot.
2. **Given** a steward session whose origin remote is ssh, **When** the steward runs `git push`, **Then** the push goes over HTTPS with a bot token from the credential helper.
3. **Given** a pane with `GH_TOKEN` already exported and a logged-in host `gh` config, **When** the steward runs `gh` or `git push`, **Then** the bot token is used and neither host credential is.
4. **Given** Tessera is unreachable or denies the request, **When** the steward runs `gh` or `git push`, **Then** the command exits non-zero with a one-line reason and no host credential is used.
5. **Given** `march up` runs on a host whose shell exports `GH_TOKEN`, **When** steward panes are later created, **Then** their environment does not contain `GH_TOKEN` or `GITHUB_TOKEN`, including when the tmux server was already running.
6. **Given** a steward session, **When** it runs `gh` many times in a row, **Then** each invocation obtains its token from Tessera and no token is written to disk.

---

### User Story 6: Migrate Services off the Ambient Token (Priority: P2)

As an operator, I want Herald, Brood, Hatchery, Legate and Statio to get their GitHub access from Tessera so that every GitHub call the stack makes is attributed, scoped and audited.

**Why this priority**: Bot-authored PRs arrive with Story 5. This story makes Tessera the only credential path for the services, which can follow once the client exists.

**Independent Test**: With the fallback flag unset and no `GH_TOKEN` in the environment, exercise each service's GitHub call sites against fakes and assert each child process receives a Tessera-issued token and an empty `gh` config directory.

**Acceptance Scenarios**:

1. **Given** Herald observing a profile, **When** it runs its `gh` reads and its default-branch sync, **Then** each uses an app/read token for that profile's repository.
2. **Given** Brood's orphan gate and Hatchery's pre-pin fetch, **When** they call GitHub, **Then** each uses an app/read token.
3. **Given** Legate merging a PR or adding a reaction, **When** it calls `gh`, **Then** it uses an app/write token for that PR's repository; the legate conductor's skill scripts do the same.
4. **Given** a service container with the host HOME mounted, **When** it runs `gh`, **Then** `gh` cannot read the mounted `hosts.yml`.
5. **Given** open PRs authored by the operator and by the bot at the same time, **When** Herald and Legate discover PRs, classify reviews and dedup comments, **Then** both kinds of PR are tracked correctly and steward replies posted as the bot are not mistaken for external bot reviews.
6. **Given** Tessera is down and the fallback flag is unset, **When** a service needs GitHub, **Then** the operation fails with a typed error and an errored span, and the service keeps running.

---

### User Story 7: Request a Copilot Review as the Operator (Priority: P2)

As an operator, I want Legate to request a Copilot review on each newly opened PR using my identity so that the review bills my personal Copilot plan.

**Why this priority**: It is new behaviour that depends on the user-identity provider, the policy and the client. It adds value but does not gate bot authorship.

**Independent Test**: Against fake Tessera and fake GitHub, open a PR in the fold and assert one review request made with the user token; repeat the tick and assert no second request; fail the request and assert the merge gate is unaffected.

**Acceptance Scenarios**:

1. **Given** a configured operator token, **When** `legate` requests the `user` identity, **Then** Tessera returns the PAT unchanged with the operator's login and the token's expiry when discoverable.
2. **Given** a PR has just been opened by a steward, **When** Legate next acts on it, **Then** it requests a Copilot review using the `user` identity.
3. **Given** a review was already requested for a PR, **When** Legate acts on it again, **Then** no second request is made.
4. **Given** the review request fails, **When** Legate continues, **Then** an errored span is emitted and merging is not blocked.
5. **Given** the operator's PAT is a fine-grained token, **When** the review request is verified against real GitHub before rollout, **Then** either it succeeds or the setup documentation states that a classic token is required.
6. **Given** the operator token is absent, **When** Legate would request a review, **Then** it skips the request and reports the provider as unconfigured, without error noise on every tick.

---

### User Story 8: See Issuances, Expiry and Health (Priority: P2)

As an operator, I want every issuance audited and every credential's health visible so that I can tell who obtained what and learn about an expiring token before it breaks the stack.

**Why this priority**: Tessera is usable without dashboards, but an unobserved credential service fails silently — and the PAT will expire.

**Independent Test**: Issue, deny and fail requests against fakes; assert one audit event and one span per request, the metric values, the expiry warning, and that a sentinel token string never appears in any log output.

**Acceptance Scenarios**:

1. **Given** any token request, **When** it completes, **Then** one audit event records caller, identity, provider, repository, access, outcome, cache result and expiry, and one `tessera.issue` span is emitted.
2. **Given** a denied or failed request, **When** it completes, **Then** the span is errored and a denial is counted with its reason.
3. **Given** a slice id on the request, **When** the span is emitted, **Then** it is a child in that slice's trace.
4. **Given** a PAT within 14 days of expiry, **When** Tessera checks it, **Then** it logs a warning at most once a day, the seconds-until-expiry gauge reflects it, and `/status` flags it.
5. **Given** tokens issued and logged at every level, **When** all log output is searched for the token values, **Then** none is found.
6. **Given** a running stack, **When** the operator runs `march doctor`, **Then** it reports whether Tessera is reachable, each service's client key is accepted, and any service still has an ambient GitHub token.
7. **Given** the Grafana stack, **When** the operator opens the Tessera dashboard, **Then** issuances, denials, mint latency and time-to-expiry are shown.

---

### User Story 9: Remove Ambient GitHub Credentials (Priority: P3)

As an operator, I want the long-lived `GH_TOKEN` removed from every container once all consumers are migrated so that Tessera is the only way the stack reaches GitHub.

**Why this priority**: It is the clean-up that locks in the result. It must come last, after every consumer works without the ambient token.

**Independent Test**: Render every compose file and assert none passes `GH_TOKEN` or `GITHUB_TOKEN`; run the stack with the fallback flag unset and assert a full dispatch-to-merge cycle succeeds.

**Acceptance Scenarios**:

1. **Given** all consumers are migrated, **When** the compose files are rendered, **Then** no service receives `GH_TOKEN` or `GITHUB_TOKEN`.
2. **Given** the fallback flag is unset everywhere, **When** a slice runs from dispatch to merge, **Then** it completes with every GitHub call made on a Tessera-issued token.
3. **Given** the compose headers and source comments that describe a shared stack-wide token, **When** this story lands, **Then** they describe Tessera instead.
4. **Given** the HOME mount still exposes `~/.config/gh` and `~/.ssh` to containers, **When** this story lands, **Then** the documentation states that exposure plainly and points to the follow-up that narrows the mount.

### Edge Cases

- A host tmux server already running when `march up` scrubs the environment.
- An operator shell rc that re-exports `GH_TOKEN` into new panes.
- A steward invoking `gh` by absolute path, bypassing the wrapper.
- The `gh` wrapper resolving to itself on `PATH`.
- A repository whose owner has no installation of the app, or an installation that excludes the repository.
- Profiles whose repositories span several owners.
- The app private key rotated while tokens are cached.
- The PAT revoked or expired while Tessera is running.
- A token revoked on GitHub while still cached in Tessera or in a client.
- Clock skew between the Tessera container and GitHub when signing the app assertion.
- GitHub returning a secondary rate limit on mint.
- A steward push that changes files under `.github/workflows/`.
- Tessera restarting while services hold cached tokens.
- Operator-authored and bot-authored PRs open at the same time during migration.
- A steward worktree whose repository cannot be resolved.

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| US1 | Mint a Downscoped Bot Token | — | specs/2026-11-15-013-tessera-credential-entitlement-service/01-mint-a-downscoped-bot-token.tasks.md |
| US4 | Fetch Tokens Through One Client | — | specs/2026-11-15-013-tessera-credential-entitlement-service/04-fetch-tokens-through-one-client.tasks.md |
| US2 | Enforce a Default-Deny Policy per Client | US1 | — |
| US3 | Keep Credentials Only in Tessera | US1 | — |
| US8 | See Issuances, Expiry and Health | US1 | — |
| US5 | Stewards Open Pull Requests as the Bot | US4 | — |
| US6 | Migrate Services off the Ambient Token | US4 | — |
| US7 | Request a Copilot Review as the Operator | US2, US4 | — |
| US9 | Remove Ambient GitHub Credentials | US5, US6, US7 | — |

## Requirements *(mandatory)*
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: recommended -->

### Functional Requirements

**Service and providers**

- **FR-001**: The system MUST provide a containerized service, started by `march tessera serve`, that follows the existing March service shape: its own image, compose file, contract document and thin client. *(US1, US3)*
- **FR-002**: The system MUST issue GitHub credentials through a provider interface with exactly two providers in v1, a GitHub App provider and an operator-token provider, arranged so that a non-GitHub provider can be added without changing the token route. *(US1, US7)*
- **FR-003**: The GitHub App provider MUST mint installation tokens restricted to the single requested repository and to the fixed permission set of the requested access level. *(US1)*
- **FR-004**: The system MUST cache installation tokens per (installation, repository set, permission set), re-mint when fewer than 10 minutes remain, and share one mint among concurrent requests for the same key. *(US1)*
- **FR-005**: The system MUST resolve the installation per repository owner, allow a configured installation id to override the lookup, and reject a repository the app is not installed on without widening scope. *(US1)*
- **FR-006**: The system MUST derive the bot login and commit identity from GitHub and MUST NOT accept them from configuration. *(US1)*
- **FR-007**: The system MUST start and serve when a provider's secret or id is absent, reporting that provider as unconfigured and failing only requests for it. *(US1, US7)*
- **FR-008**: The operator-token provider MUST return the operator's token unchanged, report its login, and report its expiry when GitHub exposes one. *(US7)*
- **FR-009**: The system MUST NOT substitute one identity for another on any failure. *(US1, US4, US7)*
- **FR-010**: Every GitHub call the service makes MUST be time-bounded, and a failed issuance MUST return a typed error. *(US1)*

**Caller authentication and policy**

- **FR-011**: The system MUST authenticate every `/v1/*` request by a per-client bearer key compared in constant time, and MUST store only a hash of each key. *(US2)*
- **FR-012**: The system MUST authorize each request against a policy mapping a client to its allowed identities, repositories and maximum access, denying anything not granted. *(US2)*
- **FR-013**: The system MUST restrict the `user` identity to the `legate` client. *(US2, US7)*
- **FR-014**: The system MUST refuse to start with a missing, empty or invalid client-keys or policy file. *(US2)*
- **FR-015**: The request shape MUST reserve an optional subject field for the future per-spawn ticket seam; in v1 it is recorded in the audit event and affects no decision. *(US2)*

**Secret placement and stack integration**

- **FR-016**: The app private key and the operator token MUST be stored where only the Tessera container mounts them, and never under a path any other March container mounts. *(US3)*
- **FR-017**: Tessera MUST NOT mount the host HOME and MUST refuse to start when a secret path resolves under the shared host HOME. *(US3)*
- **FR-018**: Tessera's port MUST be published on `127.0.0.1` only and reachable otherwise only on the March Docker network. *(US3)*
- **FR-019**: `march up` MUST start Tessera before the services that consume it, and MUST give each service its own client key without exposing that key to any other service's environment or to the steward tmux environment. *(US3)*
- **FR-020**: The operator MUST be able to import or replace a secret through the CLI without the secret appearing in a command-line argument, and Tessera MUST pick up a replaced secret without an image rebuild. *(US3)*
- **FR-021**: The Tessera compose file header MUST document setup, host-specific configuration, the secret placement, and the residual risks (Docker-socket holders and host stewards). *(US3)*

**Consumers**

- **FR-022**: The system MUST provide one Node client call that returns a GitHub entitlement for an identity, repository and access level, with a bounded timeout and typed errors. *(US4)*
- **FR-023**: The client MUST fail closed by default and MUST read `GH_TOKEN`/`GITHUB_TOKEN` only when an explicit migration flag is set; a fallback MUST be logged, counted, and never used for the `user` identity. *(US4)*
- **FR-024**: The CLI MUST expose a token command that prints only the token, and a git credential-helper command. *(US4, US5)*
- **FR-025**: Steward sessions MUST have a wrapper named `gh` ahead of the real `gh` on `PATH` that obtains a bot token per invocation and executes the real `gh` with it. *(US5)*
- **FR-026**: Steward sessions MUST have github.com remotes rewritten to HTTPS and a git credential helper that supplies a bot token per invocation. *(US5)*
- **FR-027**: The steward wrapper and helper MUST override any inherited `GH_TOKEN`/`GITHUB_TOKEN`, MUST prevent `gh` from reading the host `gh` configuration, and MUST fail closed when Tessera cannot issue. *(US5)*
- **FR-028**: `march up` MUST remove `GH_TOKEN` and `GITHUB_TOKEN` from the steward tmux environment, including an already-running server's global environment. *(US5)*
- **FR-029**: Herald, Brood, Hatchery, Legate (including its conductor skill scripts) and Statio MUST obtain GitHub credentials from the client and pass them to child processes per call. *(US6)*
- **FR-030**: Service containers MUST run `gh` with a configuration directory that does not contain the operator's login. *(US6)*
- **FR-031**: PR discovery, review classification and comment dedup MUST work for operator-authored and bot-authored PRs at the same time, and MUST NOT treat the March bot's own comments as external bot reviews. *(US6)*
- **FR-032**: Legate MUST request a Copilot review with the `user` identity once per newly opened PR, idempotently, without blocking the merge gate on failure. *(US7)*
- **FR-033**: When migration is complete, no March compose file MAY pass `GH_TOKEN` or `GITHUB_TOKEN`, and stale documentation of a shared token MUST be replaced. *(US9)*

**Observability**

- **FR-034**: The system MUST emit one audit log event per token request, including denials and failures, carrying caller, identity, provider, repository, access, outcome, cache result and expiry. *(US8)*
- **FR-035**: The system MUST emit a `tessera.issue` span per request with caller, identity, provider and cache result, errored on denial or mint failure, nested in the slice trace when a slice id is supplied. *(US8)*
- **FR-036**: The system MUST expose low-cardinality metrics for issuances, denials, mint latency, seconds until credential expiry per provider, and GitHub rate-limit pressure. *(US8)*
- **FR-037**: The system MUST warn, by log and metric, when a credential is within 14 days of expiry. *(US8)*
- **FR-038**: No token, private key, client key or key hash MAY appear in any log, span, metric, status response or error message. *(US8)*
- **FR-039**: The service MUST expose `/healthz` and `/status`, the latter reporting each provider's state, login and expiry and the soonest expiry overall. *(US8)*
- **FR-040**: `march doctor` MUST check Tessera reachability, client-key wiring per service, and whether any service still carries an ambient GitHub token. *(US8)*
- **FR-041**: A Tessera dashboard MUST be added alongside the other service dashboards. *(US8)*

**Testing and documentation**

- **FR-042**: All behaviour MUST be testable against a fake GitHub API; no test in CI may call real GitHub. *(US1–US8)*
- **FR-043**: The HTTP surface MUST have a contract test, and `docs/subsystems/tessera/contract.md` MUST be created and kept current by every implementation PR. *(US1, US2)*

### Key Entities *(include if feature involves data)*

- **Client Registration**: A named caller and the hash of its bearer key.
- **Policy Rule**: What one client may request — identities, repositories, maximum access.
- **Access Profile**: The fixed permission set behind `read` and `write`.
- **Entitlement Request**: Identity kind, repository and access level asked for.
- **Entitlement**: The issued token, its expiry, the login it acts as, and the commit identity.
- **Provider**: A source of credentials for one identity kind.
- **Installation Binding**: Repository owner to app installation.
- **Cached Installation Token**: An unexpired minted token held in memory.
- **Provider Status**: Health, login and expiry of a provider's credential.
- **Issuance Audit Record**: The log event describing one request and its outcome.
- **Spawn Ticket**: Future work — a per-session entitlement minted by Hatchery.

## Assumptions
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- The GitHub App does not exist yet and is created separately by the operator. Tessera runs without it; the app provider is simply unconfigured until then.
- The app will be installed with at least the permissions in the write access profile on every repository registered as a profile.
- Steward sessions stay on the host for this feature; moving them into containers is separate deferred work.
- Repository allowlists in the policy are maintained by the operator and seeded from the registered profile repositories. Binding a token to a specific slice waits for per-spawn tickets.
- Statio stays a separate, read-only `gh` gateway. Its cutovers for Herald and Legate remain that spec's follow-on work; this spec only changes where Statio's credential comes from.
- Operator CLI commands work from a plain npm install, reaching services over HTTP and Docker by name.
- This spec follows `docs/vision.md` and `docs/operating-philosophy.md`: the operator sets up credentials once, and the stack then runs unattended on scoped, audited, short-lived access.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Where should the app private key and PAT be stored? Option 1: a named docker volume mounted only into Tessera and filled by an npm-safe `march tessera secrets import`. Host stewards running as the operator can't read it, but it adds an import step. Option 2: a host directory outside `$HOME`, wired through compose `secrets:`. That is simpler, but any process running as the operator uid, including every steward pane, can read it. (Recommended: named volume.) | Non-Functional Quality | High | Medium | open | — |
| SD-002 | Where should the plaintext per-service client keys persist between `march up` runs? `~/.march` is mounted into every container, so following the castra-token precedent would let any container read every key. Options: (a) 0600 files under `~/.march`, following the castra precedent; (b) only hashes kept in Tessera's volume, with plaintext keys regenerated and re-injected on every `march up` so services restart onto fresh keys; (c) a separate host directory outside the shared HOME. (Recommended: b.) | Domain & Data Model | High | Medium | open | — |
| SD-003 | How should a steward pane receive its Tessera client key? Options: (a) a 0600 key file beside `~/.march/steward` that the wrapper and helper read; (b) a pane env var injected by Castra/agent-deck at launch, which would have to be exempt from the tmux-env scrub; (c) a key minted per steward session. Every option is reachable by other processes on the host; the policy caps the damage at app/write. | Interaction & UX | Medium | Low | open | — |
| SD-004 | Which identity should steward commits carry? Options: (a) the bot as author and committer, with the noreply email, so history fully reflects the bot; (b) the operator stays author and the bot is only the push/PR identity; (c) the bot as committer with a `Co-authored-by:` trailer for the operator. The brief's motivation, "history misrepresents authorship", points to (a) or (c), but the brief only says *PRs* are bot-authored. | Domain & Data Model | High | Medium | open | — |
| SD-005 | How should v1 handle steward pushes that touch `.github/workflows/*`? GitHub rejects those without `workflows:write`. Options: (a) leave it out of write, so such pushes fail closed and the steward escalates; (b) add an opt-in `write+workflows` access level that the policy grants per client or per repo; (c) include it in the default write profile. | Integration | Medium | Medium | open | — |
| SD-006 | SD-001 is open between a named volume filled by `march tessera secrets import` and a host directory outside `$HOME` wired through compose `secrets:`, but FR-020, User Story 3 scenario 4 and the CLI contract make the CLI import mandatory — option 1's mechanism — so the artifacts effectively commit to it. | plan-review:Internal contradiction | Important | Low | open | — |
| SD-007 | SD-002 is open, but User Story 3 scenario 3 and FR-019 ("each service receives its own client key and no other service's key") quietly exclude option (a) if "receives" means "can obtain", and the data model calls the client-keys file "operator-owned" although option (b) has `march up` write it. | plan-review:Internal contradiction | Important | Low | open | — |
| SD-008 | `march doctor` must check that each service's client key is accepted (FR-040, User Story 8 scenario 6), but the only authenticated route is `POST /v1/github/token`; checking a key would mean minting a real token or sending a deliberately invalid body, and doctor's access to every plaintext key depends on SD-002. | plan-review:Logical gap | Important | Low | open | — |
| SD-009 | The Copilot review request must happen exactly once per PR (FR-032, User Story 7 scenario 3, SC-008), but no idempotency mechanism is given: Legate's working state is rebuilt from the Herald fold, so after a restart it would request again unless a transition event in the fold or a check of GitHub's requested reviewers prevents it. | plan-review:Logical gap | Important | Low | open | — |

## Out of Scope
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

- Non-GitHub providers. Only the provider seam is built.
- Per-spawn tickets minted by Hatchery and bound to a repository and session lifetime. Only the reserved request field and the entity sketch exist.
- Creating or installing the GitHub App.
- Narrowing the HOME bind mount so containers stop seeing `~/.config/gh` and `~/.ssh`. Flagged for a follow-up; this spec only neutralizes `gh`'s use of it.
- Moving steward sessions into containers.
- Statio's Herald and Legate cutovers, and any Statio mutation endpoints.
- A persistent audit store or audit query API.
- Giving spawn worker containers any GitHub credential.

## Success Criteria *(mandatory)*
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

### Measurable Outcomes

- **SC-001**: Every PR March opens after rollout is authored by the bot, and the operator can approve it.
- **SC-002**: No March compose file passes `GH_TOKEN` or `GITHUB_TOKEN`, and a full dispatch-to-merge cycle succeeds with the fallback flag unset.
- **SC-003**: The app private key and the operator token are mounted into exactly one container.
- **SC-004**: Every issued app token is scoped to one repository, and none outlives GitHub's one-hour installation-token lifetime.
- **SC-005**: 100% of token requests, including denials, produce an audit event and a span; a search of all log output for issued token values finds none.
- **SC-006**: A request outside policy is denied in every tested combination of client, identity, repository and access.
- **SC-007**: The operator is warned at least 14 days before the PAT expires.
- **SC-008**: Each newly opened PR receives exactly one Copilot review request, made as the operator.
- **SC-009**: With Tessera stopped and the fallback flag unset, no service or steward reaches GitHub with any credential, and every affected operation fails within its timeout.
- **SC-010**: The test suite makes zero calls to real GitHub.
