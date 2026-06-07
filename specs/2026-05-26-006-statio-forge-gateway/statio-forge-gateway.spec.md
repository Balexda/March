# Feature Specification: Statio Forge Gateway (Service Foundation)

**Spec Folder**: `2026-05-26-006-statio-forge-gateway`
**Branch**: `feature/statio`
**Created**: 2026-05-26
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — Statio (forge gateway), introduced in the Proposal services list parallel to Castra. Origin epic: Balexda/March #250.
**Source Feature Map**: — (Statio is Castra-scale infra; the platform RFC mentions the concept, this spec is the planning artifact; no separate feature map.)

## Clarifications

### Session 2026-05-26

- This spec covers the **Statio service foundation**: standing up the service,
  clients, `ForgeClient` interface, the v1 read surface, and telemetry — with
  **no existing `gh` call site modified**. The Herald cutover and Legate cutover
  (sense-io / `legate.unwedge` routed through Statio; `gh` dropped from those
  images) are separate follow-on PRs that depend on this spec. Forge mutations
  (v2 — `createIssue`/`addComment`/`createPr`/`mergePr`/…) are a later Stage B
  follow-on once the v1 reads are cut over.
- Scope is **`gh` only**. `git` stays a direct local operation owned by the
  services that run it; Statio does not abstract the working tree.
- The v1 surface is **reads only** — it reproduces the exact `gh` reads the
  codebase performs today (`gh repo view`, `gh pr view`, `gh pr list`,
  `gh api graphql` review threads). Creation is done by stewards in-spawn and is
  out of scope here.
- Statio is **stateless**: it holds no event log, no registry, no fold of system
  state. Herald remains the observation authority; Legate the decision authority.
  An optional short read cache is a latency/rate-limit concern, never a source of
  truth (the resilience seam, default-off in this foundation spec).
- The reference implementation is **Castra** (`src/castra/`,
  [`docs/Castra.md`](../../docs/Castra.md)) — service + typed async client +
  swappable adapter + uniform error envelope + deterministic port + bearer-token
  `/v1/*` + OTel telemetry. Statio mirrors it (Castra also ships a sync client for
  the legate's synchronous tick; Statio is **async-only** — the Legate cutover
  goes async rather than carrying a `curl`-based sync client).
- Forge facts produced by Statio must be **behavior-preserving** relative to the
  current `gh` output `sense-io.ts` consumes, so the Herald cutover changes only the
  transport, not the observed shape.
- Statio is held to [`docs/operating-philosophy.md`](../../docs/operating-philosophy.md):
  no interactive surfaces (auth provisioned at deploy, not negotiated per
  request), minimum required access (Statio is the only forge-credentialed image),
  clean exits (timeout-bounded `gh` calls; `forge_error` envelope, never a hang).

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing

### User Story 1: Read a Pull Request's State Through the Gateway (Priority: P1)

As Herald's observation path, I want to read a single PR's state, mergeability,
review decision, CI rollup, and unresolved-thread summary through one typed call
so that I no longer assemble `gh pr view` argv and parse JSON-by-`-q`.

**Why this priority**: `getPr` is the highest-traffic forge read — the legate
babysit loop calls it for every tracked slice's PR. Nothing else in the cutover
matters if the per-PR read is not faithful.

**Independent Test**: Call `getPr(number)` against a repo with a known PR and
verify the returned summary carries number, url, state, mergeable, review
decision, a CI check rollup, head branch, title, and author — matching what
`sense-io.ts`'s `queryPrForBabysit` produces today.

**Acceptance Scenarios**:

1. **Given** an open PR exists, **When** a consumer calls `getPr(number)`, **Then**
   Statio returns its state, mergeable, review decision, CI rollup, head branch,
   title, and author in the v1 wire shape.
2. **Given** the repo owner is resolvable, **When** Statio runs the underlying
   `gh pr view`, **Then** it scopes the call with `-R <owner>` (falling back to a
   repo-path cwd when owner is unavailable), matching today's resolution logic.
3. **Given** the requested PR number does not exist, **When** `getPr` runs,
   **Then** Statio returns a `not_found` error envelope rather than a malformed
   success.
4. **Given** `gh` fails or times out, **When** `getPr` runs, **Then** Statio
   returns a `forge_error` envelope and does not hang the caller.

---

### User Story 2: Discover and List Pull Requests (Priority: P1)

As the legate loop's PR-discovery path, I want to list PRs filtered by head branch
and/or author and state so that I can match an open PR to a slice without shelling
`gh pr list`.

**Why this priority**: PR discovery (`listPrs`) is how the loop adopts a steward's
PR and how the Hatchery self-heal asks "is there a PR for this head?". It is a v1
read both consumers need.

**Independent Test**: Call `listPrs({ author: "@me", state: "open" })` and
`listPrs({ head: "<branch>" })` and verify each returns the bounded list-item
shape (number, url, state, mergeable, head branch, title, CI rollup, createdAt)
matching today's `gh pr list --json` output.

**Acceptance Scenarios**:

1. **Given** open PRs authored by the caller, **When** `listPrs({ author, state })`
   runs, **Then** Statio returns the list-item shape for each.
2. **Given** a head branch with an open PR, **When** `listPrs({ head })` runs,
   **Then** Statio returns the PR(s) for that head.
3. **Given** no PRs match the filter, **When** `listPrs` runs, **Then** Statio
   returns an empty list (not an error).
4. **Given** an invalid filter combination or malformed argument, **When**
   `listPrs` runs, **Then** Statio returns an `invalid_request` envelope.

---

### User Story 3: Resolve Repository Identity and Default Branch (Priority: P1)

As any forge consumer, I want to resolve the repository's `owner` and
`defaultBranch` through one call so that PR-scoping (`-R owner`) and default-branch
logic do not each re-derive it from `gh repo view`.

**Why this priority**: `repoInfo` underpins the other reads (owner scoping) and the
default-branch sync. It is small but foundational.

**Independent Test**: Call `repoInfo()` and verify it returns `{ owner,
defaultBranch }` matching `gh repo view --json nameWithOwner,defaultBranchRef`.

**Acceptance Scenarios**:

1. **Given** a repo Statio can resolve, **When** `repoInfo()` runs, **Then** it
   returns the `owner` (owner/name) and the `defaultBranch` name.
2. **Given** owner resolution succeeds but default-branch is requested, **When**
   `repoInfo()` runs, **Then** both fields are populated from the same `gh repo
   view` (no second round trip required by the caller).
3. **Given** `gh` cannot resolve the repo, **When** `repoInfo()` runs, **Then**
   Statio returns a `forge_error` envelope.

---

### User Story 4: Read Unresolved Review Threads (Priority: P1)

As the legate babysit/fix path, I want the PR's unresolved review threads — with
the per-comment ids needed to dedup `/smithy.fix` (#224) — through one call so that
the `gh api graphql` query lives in one place.

**Why this priority**: Review threads drive the fix loop. The GraphQL query and its
resolved-thread filtering / comment-id extraction are the most error-prone part of
the current `gh` surface (SD-004); centralizing them faithfully is essential.

**Independent Test**: Call `reviewThreads(prNumber)` against a PR with mixed
resolved/unresolved threads and verify only unresolved threads are returned, each
carrying the first comment's id/path/line/author, a bounded body preview, the last
author/timestamp, the comment count, and the full list of comment ids.

**Acceptance Scenarios**:

1. **Given** a PR with resolved and unresolved threads, **When** `reviewThreads`
   runs, **Then** only unresolved threads are returned.
2. **Given** an unresolved thread, **When** it is returned, **Then** it includes
   the first comment's id, path, line, author, a bounded body preview, the last
   author and timestamp, the comment count, and every comment's id.
3. **Given** the repo owner cannot be split into owner/name, **When**
   `reviewThreads` runs, **Then** Statio returns an empty thread list (matching
   today's guard), not an error.
4. **Given** `gh api graphql` fails, **When** `reviewThreads` runs, **Then**
   Statio returns a `forge_error` envelope.

---

### User Story 5: Reach the Gateway Over HTTP With Auth and Uniform Typed Errors (Priority: P1)

As a consuming service, I want to reach Statio over HTTP with a bearer token, a
typed async client, and a uniform error envelope so that I can call typed methods
and branch on stable error codes without a live `gh` in my own image.

**Why this priority**: The transport, auth, error model, and the typed async client
are what make every read above consumable. Without them the reads are
unreachable.

**Independent Test**: Start the service; call a `/v1/*` route without a token
(expect `401 unauthorized`), with the token (expect `200`), and an unknown route
(expect `404 not_found`). Exercise the async (`fetch`) client against the same
routes and verify typed results and error mapping.

**Acceptance Scenarios**:

1. **Given** the service is running, **When** `GET /healthz` is called, **Then** it
   returns liveness without requiring a token; **and** `GET /status` returns
   service/version/uptime + `gh` reachability, also open.
2. **Given** a `/v1/*` request without (or with a wrong) bearer token, **When** it
   is handled, **Then** Statio returns `401 unauthorized` in the uniform envelope.
3. **Given** any non-2xx response, **When** a client receives it, **Then** it is
   the envelope `{"error":{"code","message"}}` with a stable code, mapped by the
   client to a typed `StatioClientError` preserving `code` and `status`.
4. **Given** a request carries an `x-march-slice-id` header, **When** Statio
   handles it, **Then** the slice id is available for span correlation (the trace
   nests as a child, not a new root).
5. **Given** the async client, **When** it calls a route, **Then** it resolves
   URL/token from `MARCH_STATIO_URL` / `MARCH_STATIO_TOKEN`, returns the wire
   types, and maps the error envelope to a typed `StatioClientError`.
6. **Given** a `reachable()` probe, **When** the token is wrong or `gh` is down,
   **Then** the probe reports not-ready (it exercises the authenticated `/v1/*`
   surface, not just open `/healthz`) and never throws.

---

### User Story 6: Operate Statio as an Observable Container (Priority: P2)

As the operator, I want to run Statio as a container on the `march` network with
the same recipe as Castra and observe it in Grafana so that forge behavior is
deployable and debuggable like the rest of the stack.

**Why this priority**: P2 because the service and clients (US1–US5) define the
capability; this story makes it deployable and observable. It is required before
any consumer cutover (the Herald and Legate follow-ons) but not before the service logic is proven.

**Independent Test**: Build the image, set the token, `compose up`; confirm the
service binds the deterministic port, is reachable on the `march` network, and —
with `MARCH_OTEL=1` — emits RED metrics, heartbeat/uptime, per-op spans, and logs
visible on the Statio Grafana dashboard. With telemetry off, the service runs
unchanged (no-op).

**Acceptance Scenarios**:

1. **Given** `docker/statio.docker-compose.yml`, **When** the operator brings it up
   without the bearer token set, **Then** bring-up aborts with a clear message
   (the token is required).
2. **Given** the image is built and the token is set, **When** the operator
   `compose up`s, **Then** Statio binds the deterministic port (9689 by default,
   override `MARCH_STATIO_PORT`), localhost-bound, joined to the external `march`
   network, and reachable at `MARCH_STATIO_URL`.
3. **Given** `MARCH_OTEL=1`, **When** the service handles requests, **Then** it
   emits RED metrics, a heartbeat/uptime gauge, per-op spans (child-nested on
   `x-march-slice-id` when present), and request logs under
   `service.name=march-statio`, surfaced on the **March — Statio forge gateway**
   Grafana dashboard.
4. **Given** `MARCH_OTEL` is unset, **When** the service runs, **Then** all
   telemetry is a no-op and behavior is unchanged.

### Edge Cases

- `gh` is not installed or not authenticated inside the Statio container at start
  (`/status` reports `gh` unreachable; `/v1/*` reads return `forge_error`).
- `gh` returns valid JSON with unexpected/missing fields; response shaping must
  not throw — it degrades to the documented wire shape or a `forge_error`.
- A PR exists but its `statusCheckRollup` is empty or null (CI rollup summarizes to
  "no checks", not a crash).
- The repo owner cannot be resolved (owner-less `gh` falls back to a repo-path cwd;
  `reviewThreads` returns empty rather than erroring).
- A consumer sends an oversized or malformed slice-id header (ignored for
  correlation; never affects the response).
- Two consumers call concurrently; Statio holds no per-request state, so calls are
  independent (a future read cache must preserve this observable independence).
- The forge rate-limits Statio; v1 surfaces it as `forge_error` (the F6 retry/
  budget seam is default-off until measured).

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US3 | Resolve Repository Identity and Default Branch | — | specs/2026-05-26-006-statio-forge-gateway/03-resolve-repository-identity-and-default-branch.tasks.md |
| US5 | Reach the Gateway Over HTTP With Auth and Uniform Typed Errors | — | — |
| US1 | Read a Pull Request's State Through the Gateway | US3, US5 | — |
| US2 | Discover and List Pull Requests | US3, US5 | — |
| US4 | Read Unresolved Review Threads | US3, US5 | — |
| US6 | Operate Statio as an Observable Container | US1–US5 | — |

US3 (repoInfo) and US5 (transport/auth/errors/clients) are the foundation; the
remaining reads build on them; US6 packages and instruments the result.

## Requirements

### Functional Requirements

- **FR-001**: Statio MUST expose the v1 read surface — `repoInfo`, `listPrs`,
  `getPr`, `reviewThreads` — over HTTP, each mapping to the corresponding `gh`
  invocation performed in `src/observe/sense-io.ts` today.
- **FR-002**: Statio MUST be the forge gateway — the *intended* single owner of
  `gh` once consumers are cut over — and MUST NOT abstract or perform `git`
  operations. The single-`gh`-owner end state is reached by the Herald and Legate
  cutover follow-ons (see FR-019); this foundation spec stands Statio up alongside
  the existing `gh` call sites and does not yet make Statio the only `gh` caller.
- **FR-003**: Statio MUST be stateless — it MUST hold no event log, registry, or
  fold of system state, and MUST NOT be a place consumers read "current state"
  from.
- **FR-004**: The v1 surface MUST be reads only; mutations (`createPr`, `mergePr`, `addComment`, `createIssue`, …) are deferred to v2.
- **FR-005**: Every `gh` invocation MUST be bounded by a timeout; a failed,
  unreachable, or timed-out `gh` MUST surface as a `forge_error` envelope, never a
  hang or an uncaught exception.
- **FR-006**: Every non-2xx response MUST be the uniform envelope
  `{"error":{"code","message"}}` with stable codes: `invalid_request`,
  `unauthorized`, `not_found`, `forge_error`, `internal`.
- **FR-007**: `/v1/*` routes MUST require a bearer token; `/healthz` and `/status`
  MUST be open.
- **FR-008**: Statio MUST expose named, allow-listed read methods only — it MUST
  NOT expose an arbitrary `gh api` passthrough.
- **FR-009**: Statio MUST ship a typed async (`fetch`) client implementing the
  `ForgeClient` interface, owning URL/token resolution, the slice-id header, the
  error envelope, and the wire types. (No sync/`curl` client — unlike Castra,
  Statio is async-only; the Legate cutover adapts to async.)
- **FR-010**: Clients MUST resolve the base URL from `MARCH_STATIO_URL` (falling
  back to `http://localhost:<deterministic-port>`) and the token from
  `MARCH_STATIO_TOKEN`, and MUST map the non-2xx envelope to a typed
  `StatioClientError` preserving `code` and `status`.
- **FR-011**: Clients MUST forward an `x-march-slice-id` trace header when
  provided, and the service MUST nest its spans as children on that id (never
  claiming a root span).
- **FR-012**: Clients MUST provide a best-effort `reachable()` probe that
  exercises the authenticated `/v1/*` surface and never throws.
- **FR-013**: The service MUST bind a deterministic port (9689 for `march-statio`,
  via `sha256(name) → 8800–9799`), overridable by `MARCH_STATIO_PORT`, validating
  the override and failing fast on a non-numeric / out-of-range value.
- **FR-014**: `gh repo view` owner resolution MUST scope PR reads with `-R <owner>`
  when available and fall back to a repo-path cwd otherwise, preserving today's
  resolution behavior.
- **FR-015**: `reviewThreads` MUST return only unresolved threads, each with the
  first comment's id/path/line/author, a bounded body preview, the last
  author/timestamp, the comment count, and the full list of comment ids (#224
  dedup support).
- **FR-016**: Response shaping MUST be behavior-preserving relative to the current
  `gh` JSON `sense-io.ts` consumes (the Herald cutover changes transport, not shape).
- **FR-017**: Statio MUST deploy as a container (`docker/statio.Dockerfile` +
  `docker/statio.docker-compose.yml`) that requires the bearer token (aborting
  bring-up if unset), binds the port to localhost, and joins the external `march`
  network.
- **FR-018**: Statio MUST emit RED metrics, a heartbeat/uptime gauge, per-op
  spans, and request logs under `service.name=march-statio`, all no-op unless
  `MARCH_OTEL=1`, with a Grafana dashboard; metric labels MUST stay
  low-cardinality (no PR numbers or concrete request paths).
- **FR-019**: This spec MUST NOT modify any existing `gh` call site
  (`sense-io.ts`, `orphan-branch.ts`, `clean-stale-branch.sh`, Herald `/readyz`);
  consumer cutover happens in the Herald and Legate follow-on PRs.

### Key Entities

- **RepoInfo**: `{ owner, defaultBranch }` resolved from `gh repo view`.
- **PullRequestSummary**: the per-PR read (`getPr`) — number, url, state,
  mergeable, review decision, CI rollup, failed checks, head branch, title,
  author, unresolved-thread summary.
- **PullRequestListItem**: the bounded per-PR shape returned by `listPrs`.
- **ReviewThread**: an unresolved review thread with comment ids for #224 dedup.
- **ForgeErrorEnvelope**: the uniform `{"error":{"code","message"}}` body.
- **StatioConfig**: service name, env var names, identifier validation, and the
  deterministic port helper.

## Assumptions

- The Statio container has `gh` installed and authenticated (env token and/or a
  read-only `~/.config/gh` mount, decided in implementation — SD-002).
- Consumers reach Statio on the shared `march` Docker network created by the
  otel-lgtm stack (the Castra/Hatchery topology).
- The current `gh` output shape in `sense-io.ts` is the authoritative target for
  v1 response shaping; the Herald cutover is the parity test.
- Castra (`src/castra/`) is a directly reusable scaffolding reference for the
  service, clients, config, error model, and telemetry.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Env-var naming convention: `MARCH_STATIO_*` (this spec) vs. Castra's `CASTRA_*`. Two conventions exist in the stack. | Constraints | Low | Medium | open | Confirm the canonical prefix before implementation; inherited from the feature map. |
| SD-002 | Forge-auth provisioning: env token vs. read-only `~/.config/gh` mount, and interaction with `gh`'s own credential resolution. | Domain & Data Model | Medium | Medium | open | Decide the supported default + compose wiring during implementation. |
| SD-003 | Whether the resilience seam (rate-limit/retry/read-cache) ships in this foundation spec (default-off) or arrives with the first measured need. | Architecture | Low | Medium | open | Default stance: ship the seam, default-off; revisit on measured rate-limit pressure. |
| SD-004 | `reviewThreads` GraphQL response shaping (resolved-thread filtering + comment-id dedup) must match `sense-io.ts`'s current output exactly for a behavior-preserving Herald cutover. | Domain & Data Model | Medium | High | open | Pin the wire shape against `queryReviewThreads` in the contracts/data-model. |

## Out of Scope

- Cutting any consumer over to Statio (the Herald and Legate cutovers) or
  removing `gh` from any other image.
- Forge mutations: `createPr`, `mergePr`, `deleteRemoteBranch`, issue/comment
  CRUD (v2).
- Any `git` operation (worktree, branch, fetch/switch/pull) — stays direct.
- In-spawn steward forge actions (PR open/push from inside sessions).
- An arbitrary `gh api` passthrough surface.
- Enabling (as opposed to seam-ing) a read cache, retry policy, or rate-limit
  budget.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A consumer resolves `repoInfo`, `getPr`, `listPrs`, and
  `reviewThreads` through the Statio client with no `gh` in the consumer's
  process, against a live repo.
- **SC-002**: The four v1 reads produce output behavior-equivalent to today's
  `gh` calls in `sense-io.ts` (verified field-by-field for `getPr` and
  `reviewThreads`).
- **SC-003**: `/v1/*` requires the bearer token (401 without it); `/healthz` and
  `/status` are open; every non-2xx is the uniform envelope with a stable code.
- **SC-004**: The async client calls each v1 route and returns typed results, with
  every non-2xx mapped to a typed `StatioClientError` carrying `code` and `status`.
- **SC-005**: `docker compose up` brings Statio up on the `march` network at the
  deterministic port, refuses to start without the token, and (with `MARCH_OTEL=1`)
  shows RED metrics, heartbeat/uptime, spans, and logs on the Statio Grafana
  dashboard.
- **SC-006**: No existing `gh` call site is changed by this spec.
