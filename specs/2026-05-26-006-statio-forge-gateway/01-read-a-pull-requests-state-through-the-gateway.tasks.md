# Tasks: Read a Pull Request's State Through the Gateway

**Source**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — User Story 1
**Data Model**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.data-model.md`
**Contracts**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md`
**Story Number**: 01

---

## Slice 1: Add the Single-PR Forge Read

**Goal**: Deliver Statio's `getPr(number)` read through the forge seam, shaping one PR's state, mergeability, review decision, CI rollup, head branch, title, author, and unresolved-thread summary without exposing new consumer behavior.

**Justification**: This slice is a standalone working increment because the in-process forge read can be exercised and validated against the current `sense-io.ts` projection before it is exposed over the already-defined HTTP/client transport.

**Addresses**: FR-001, FR-003, FR-004, FR-005, FR-008, FR-014, FR-016, FR-019; Acceptance Scenarios 1.1-1.4

### Tasks

- [ ] **Define the PR summary wire shape**

  Add the US1-facing Statio types under `src/statio/`, extending the existing forge read seam only for `getPr(number)`. Keep the shape aligned with `PullRequestSummary`, `CheckRollup`, `CheckSummary`, and the unresolved-thread summary fields in the data model, and preserve the read-only, named-method boundary from the contracts.

  _Acceptance criteria:_
  - `PullRequestSummary`, check rollup, failed-check, and unresolved-thread fields match the data model for AS 1.1
  - `ForgeClient` exposes `getPr(number)` as an async read without adding mutations or arbitrary `gh` passthroughs
  - `not_found` and `forge_error` outcomes can be represented through the existing uniform error model
  - No existing consumer behavior or direct `gh` call site changes

- [ ] **Implement `getPr(number)` through bounded `gh pr view`**

  Add the Statio forge adapter logic that resolves repository identity, scopes `gh pr view` with `-R <owner>/<name>` when available, falls back to the repo-path cwd when owner is unavailable, and shapes the response into the documented PR summary. The adapter should remain stateless, preserve the current `sense-io.ts` projection, and turn absent PRs, failed commands, timeouts, and unparseable output into typed outcomes.

  _Acceptance criteria:_
  - An open PR returns state, mergeable, review decision, CI rollup, head branch, title, author, and unresolved-thread summary for AS 1.1
  - Repository owner scoping and repo-path fallback preserve AS 1.2
  - Missing PRs return a `not_found` outcome for AS 1.3
  - Failed, timed-out, unreachable, or unparseable `gh` results return a `forge_error` outcome for AS 1.4
  - Tests cover success, owner scoping, owner fallback, missing PR, malformed output, and forge failure behavior

**PR Outcome**: Statio has a tested in-process `getPr(number)` forge read that preserves today's babysit PR projection and is ready to expose through the existing v1 HTTP/client surface.

---

## Slice 2: Expose `getPr` Through the Gateway Surface

**Goal**: Route the single-PR read through Statio's authenticated `/v1/prs/:number` endpoint and async client method using the established bearer-token, envelope, and trace-header behavior.

**Justification**: This slice is a standalone working increment because a consumer can call `getPr(number)` over HTTP and receive the same typed summary and error behavior that the in-process seam already proves.

**Addresses**: FR-001, FR-005, FR-006, FR-007, FR-009, FR-010, FR-011, FR-012, FR-014, FR-016, FR-019; Acceptance Scenarios 1.1-1.4

### Tasks

- [ ] **Add the `/v1/prs/:number` route**

  Extend the Statio Fastify service under `src/statio/` so the authenticated single-PR route delegates to the `getPr(number)` forge seam and returns the documented success wrapper or uniform error envelope. Keep health/status behavior unchanged and preserve the existing slice trace correlation behavior for the new route.

  _Acceptance criteria:_
  - Authorized `GET /v1/prs/:number` responses wrap the `PullRequestSummary` for AS 1.1
  - Missing or malformed PR numbers return stable error envelopes without uncaught validation failures
  - Missing PRs map to `not_found`; forge failures map to `forge_error`
  - The route requires bearer-token auth and keeps `x-march-slice-id` correlation available
  - Tests cover authorized success, auth rejection, invalid number, missing PR, forge failure, and trace header forwarding

- [ ] **Wire the async client to `getPr(number)`**

  Extend the fetch-based Statio client so `getPr(number)` calls the new route, returns the documented wire type, forwards any configured slice id, and maps non-2xx envelopes through `StatioClientError`. Keep `reachable()` semantics unchanged unless they already depend on the method list generically.

  _Acceptance criteria:_
  - Client `getPr(number)` returns the PR summary shape through the real service boundary
  - Non-2xx envelopes preserve stable `code` and `status` in `StatioClientError`
  - Transport failures remain typed client errors without envelope codes
  - `reachable()` continues to report readiness without throwing
  - Compatibility tests cover client success and error mapping against the service route

**PR Outcome**: Statio clients can read a single PR's babysit summary through the authenticated gateway with typed success and error behavior.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Env-var naming convention: `MARCH_STATIO_*` (this spec) vs. Castra's `CASTRA_*`. Two conventions exist in the stack. | Constraints | Low | Medium | inherited | — |
| SD-002 | inherited from spec: Forge-auth provisioning: env token vs. read-only `~/.config/gh` mount, and interaction with `gh`'s own credential resolution. | Domain & Data Model | Medium | Medium | inherited | — |
| SD-003 | inherited from spec: Whether the resilience seam (rate-limit/retry/read-cache) ships in this foundation spec (default-off) or arrives with the first measured need. | Architecture | Low | Medium | inherited | — |
| SD-004 | inherited from spec: `reviewThreads` GraphQL response shaping (resolved-thread filtering + comment-id dedup) must match `sense-io.ts`'s current output exactly for a behavior-preserving Herald cutover. | Domain & Data Model | Medium | High | inherited | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Add the Single-PR Forge Read | — | — |
| S2 | Expose `getPr` Through the Gateway Surface | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Resolve Repository Identity and Default Branch | depends on | Single-PR reads use repo identity to scope `gh pr view` with `-R <owner>/<name>` and fall back when owner is unavailable. |
| User Story 5: Reach the Gateway Over HTTP With Auth and Uniform Typed Errors | depends on | The HTTP route and async client use the existing bearer-token, envelope, trace-header, and client transport foundation. |
| User Story 4: Read Unresolved Review Threads | depended upon by | The richer standalone review-thread read can reuse the unresolved-thread shaping proven by `getPr(number)`. |
| User Story 6: Operate Statio as an Observable Container | depended upon by | Containerization and dashboards observe this route as part of the complete v1 read surface. |
