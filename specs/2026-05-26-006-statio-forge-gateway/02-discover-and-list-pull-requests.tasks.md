# Tasks: Discover and List Pull Requests

**Source**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — User Story 2
**Data Model**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.data-model.md`
**Contracts**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md`
**Story Number**: 02

---

## Slice 1: Add the PR List Forge Read

**Goal**: Deliver Statio's in-process `listPrs(req)` read through the forge seam, filtering by author, state, and/or head branch while shaping each result into the bounded PR list item.

**Justification**: This slice is a standalone working increment because the adapter can prove `gh pr list` parity and validation behavior before the HTTP surface delegates to it.

**Addresses**: FR-001, FR-003, FR-004, FR-005, FR-008, FR-014, FR-016, FR-019; Acceptance Scenarios 2.1-2.4

### Tasks

- [x] **Implement the `listPrs(req)` forge seam**

  Extend the Statio forge adapter under `src/statio/` so `listPrs(req)` validates the documented filters, resolves repository identity for owner-scoped `gh pr list` calls when available, falls back to the repo-path cwd when owner is unavailable, and shapes the returned array into `PullRequestListItem` values. Keep the adapter stateless and read-only, with no consumer cutover.

  _Acceptance criteria:_
  - Author plus state filters return bounded list items for AS 2.1
  - Head-branch filters return matching PRs for AS 2.2
  - Empty `gh pr list` output becomes an empty list for AS 2.3
  - Invalid filters or malformed arguments become an `invalid_request` outcome for AS 2.4
  - Failed, timed-out, unreachable, or unparseable `gh` results become `forge_error`
  - Tests cover success by author/state, success by head, empty results, invalid filters, malformed output, owner scoping, owner fallback, and forge failure behavior

**PR Outcome**: Statio has a tested in-process `listPrs(req)` forge read that preserves today's PR-discovery projection and is ready for the gateway route.

---

## Slice 2: Expose `listPrs` Through the Gateway Surface

**Goal**: Route PR discovery through Statio's authenticated `GET /v1/prs` endpoint and the async client method using the established bearer-token, envelope, and trace-header behavior.

**Justification**: This slice is a standalone working increment because consumers can discover PRs by author/state or head branch over HTTP with the same typed success and error behavior proven by the forge seam.

**Addresses**: FR-001, FR-006, FR-007, FR-009, FR-010, FR-011, FR-014, FR-016, FR-019; Acceptance Scenarios 2.1-2.4

### Tasks

- [x] **Add the authenticated `/v1/prs` route**

  Extend the Statio Fastify service so `GET /v1/prs` accepts the documented query filters, delegates to `listPrs(req)`, and returns the success wrapper or uniform error envelope. Preserve health/status behavior, bearer-token auth, and slice trace correlation for the new route.

  _Acceptance criteria:_
  - Authorized author/state requests return `{ prs: PullRequestListItem[] }` for AS 2.1
  - Authorized head requests return `{ prs: PullRequestListItem[] }` for AS 2.2
  - No-match requests return `{ prs: [] }` with a successful response for AS 2.3
  - Invalid query values return `invalid_request` envelopes for AS 2.4
  - The route requires bearer-token auth and keeps `x-march-slice-id` correlation available
  - Tests cover authorized success, auth rejection, empty results, invalid query values, forge failure, and trace header forwarding

- [x] **Verify async client compatibility for `listPrs(req)`**

  Ensure the fetch-based Statio client interoperates with the service route for `listPrs(req)`, including query serialization, response unwrapping, trace header forwarding, and `StatioClientError` mapping for non-2xx envelopes. Keep `reachable()` behavior anchored to the existing authenticated readiness probe.

  _Acceptance criteria:_
  - Client `listPrs({ author, state })` and `listPrs({ head })` return the list item shape through the real service boundary
  - Non-2xx envelopes preserve stable `code` and `status` in `StatioClientError`
  - Transport failures remain typed client errors without envelope codes
  - `reachable()` continues to report readiness without throwing
  - Compatibility tests cover client success, query serialization, trace header forwarding, and error mapping against the service route

**PR Outcome**: Statio clients can discover PRs through the authenticated gateway with typed list-item success, empty-list, validation, and forge-error behavior.

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
| S1 | Add the PR List Forge Read | — | — |
| S2 | Expose `listPrs` Through the Gateway Surface | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Resolve Repository Identity and Default Branch | depends on | PR discovery uses repo identity to scope `gh pr list` with `-R <owner>/<name>` and fall back when owner is unavailable. |
| User Story 5: Reach the Gateway Over HTTP With Auth and Uniform Typed Errors | depends on | The HTTP route and async client use the existing bearer-token, envelope, trace-header, and client transport foundation. |
| User Story 6: Operate Statio as an Observable Container | depended upon by | Containerization and dashboards observe this route as part of the complete v1 read surface. |
