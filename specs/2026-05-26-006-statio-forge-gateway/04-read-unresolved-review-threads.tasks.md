# Tasks: Read Unresolved Review Threads

**Source**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — User Story 4
**Data Model**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.data-model.md`
**Contracts**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md`
**Story Number**: 04

---

## Slice 1: Add the Review-Thread Forge Read

**Goal**: Deliver Statio's standalone `reviewThreads(prNumber)` forge read, shaping unresolved review threads from the GraphQL surface into the documented per-comment dedup shape.

**Justification**: This slice is a standalone working increment because the GraphQL query, resolved-thread filtering, comment ordering, and bounded preview behavior can be proven behind the forge seam before the HTTP route delegates to it.

**Addresses**: FR-001, FR-003, FR-004, FR-005, FR-008, FR-015, FR-016, FR-019; Acceptance Scenarios 4.1-4.4

### Tasks

- [x] **Implement the `reviewThreads(prNumber)` forge seam**

  Extend the Statio forge adapter under `src/statio/` so `reviewThreads(prNumber)` validates the PR number, resolves repository identity, returns an empty list when owner/name cannot be split, runs the bounded GraphQL read when it can, and shapes only unresolved threads into the documented `ReviewThread` values. Keep the adapter stateless, read-only, and behavior-preserving relative to the current `sense-io.ts` review-thread projection.

  _Acceptance criteria:_
  - Mixed resolved and unresolved GraphQL results return only unresolved threads for AS 4.1
  - Each returned thread includes first-comment id/path/line/author, bounded body preview, last author/timestamp, comment count, and all comment ids for AS 4.2
  - Unsplittable or unavailable repository owner returns an empty list for AS 4.3
  - Failed, timed-out, unreachable, or unparseable GraphQL results become `forge_error` for AS 4.4
  - Tests cover success, resolved filtering, comment ordering, owner-unavailable fallback, malformed output, invalid PR number, and forge failure behavior

**PR Outcome**: Statio has a tested in-process `reviewThreads(prNumber)` read that centralizes the review-thread GraphQL query and preserves the dedup data needed by `/smithy.fix`.

---

## Slice 2: Expose `reviewThreads` Through the Gateway Surface

**Goal**: Route unresolved review-thread reads through Statio's authenticated `/v1/prs/:number/review-threads` endpoint and async client method using the established auth, envelope, and trace-header behavior.

**Justification**: This slice is a standalone working increment because a consumer can read review threads over the gateway with the same typed success and error behavior as the other v1 reads, completing the read surface without cutting over existing `gh` consumers.

**Addresses**: FR-001, FR-005, FR-006, FR-007, FR-009, FR-010, FR-011, FR-015, FR-016, FR-019; Acceptance Scenarios 4.1-4.4

### Tasks

- [x] **Add the authenticated review-threads route**

  Extend the Statio Fastify service so `GET /v1/prs/:number/review-threads` delegates to the `reviewThreads(prNumber)` forge seam and returns the documented `{ threads }` success wrapper or uniform error envelope. Preserve bearer-token auth, health/status behavior, and slice trace correlation for the new route.

  _Acceptance criteria:_
  - Authorized requests return `{ threads: ReviewThread[] }` for AS 4.1 and AS 4.2
  - Missing or malformed PR numbers return stable `invalid_request` envelopes without uncaught validation failures
  - Owner-unavailable results return `{ threads: [] }`
  - Forge failures map to `forge_error`
  - The route requires bearer-token auth and keeps `x-march-slice-id` correlation available
  - Tests cover authorized success, auth rejection, invalid number, owner-unavailable empty result, forge failure, and trace header forwarding

- [x] **Verify async client compatibility for `reviewThreads(prNumber)`**

  Ensure the fetch-based Statio client interoperates with the service route for `reviewThreads(prNumber)`, including response unwrapping, trace header forwarding, and `StatioClientError` mapping for non-2xx envelopes. Keep `reachable()` anchored to the existing authenticated readiness probe rather than this route.

  _Acceptance criteria:_
  - Client `reviewThreads(prNumber)` returns unresolved thread values through the real service boundary
  - Non-2xx envelopes preserve stable `code` and `status` in `StatioClientError`
  - Transport failures remain typed client errors without envelope codes
  - `reachable()` continues to report readiness without throwing
  - Compatibility tests cover client success, trace header forwarding, and error mapping against the service route

**PR Outcome**: Statio clients can read unresolved review threads through the authenticated gateway with typed success, empty-list, validation, and forge-error behavior.

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
| S1 | Add the Review-Thread Forge Read | — | — |
| S2 | Expose `reviewThreads` Through the Gateway Surface | S1 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Resolve Repository Identity and Default Branch | depends on | Review-thread GraphQL reads need repo identity to split owner/name; unavailable identity returns the documented empty thread list. |
| User Story 5: Reach the Gateway Over HTTP With Auth and Uniform Typed Errors | depends on | The HTTP route and async client use the existing bearer-token, envelope, trace-header, and client transport foundation. |
| User Story 1: Read a Pull Request's State Through the Gateway | related | The standalone review-thread read should preserve the same unresolved-thread shaping already used by richer single-PR summaries. |
| User Story 6: Operate Statio as an Observable Container | depended upon by | Containerization and dashboards observe this route as part of the complete v1 read surface. |
