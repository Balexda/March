# Tasks: Reach the Gateway Over HTTP With Auth and Uniform Typed Errors

**Source**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — User Story 5
**Data Model**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.data-model.md`
**Contracts**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md`
**Story Number**: 05

---

## Slice 1: Add Statio Client Configuration

**Goal**: Deliver the typed async consumer seam for Statio, including environment resolution, stable client errors, and a best-effort authenticated readiness probe.

**Justification**: This slice is a standalone working increment because consumers can construct and test the `ForgeClient` boundary without the service implementation, while later HTTP slices plug into the same wire and error contracts.

**Addresses**: FR-006, FR-009, FR-010, FR-012; Acceptance Scenarios 5.3, 5.5, 5.6

### Tasks

- [x] **Define Statio client types and config**

  Add the US5-facing Statio wire types, `ForgeClient` interface, client error type, and configuration helpers under `src/statio/`, following the Castra client/config boundary pattern. Keep this focused on transport concerns from the contracts and avoid changing existing forge consumers or `gh` call sites.

  _Acceptance criteria:_
  - Wire/error types match the contracts and data model for US5
  - Client config resolves `MARCH_STATIO_URL`, `MARCH_STATIO_PORT`, and `MARCH_STATIO_TOKEN`
  - The deterministic default port is available and override validation fails fast
  - `StatioClientError` preserves envelope code and HTTP status
  - No existing consumer behavior or direct `gh` call site changes

- [x] **Implement the async Statio client**

  Add the fetch-based `StatioClient` under `src/statio/` implementing the `ForgeClient` contract. It should call the documented `/v1/*` routes, forward a provided slice trace key, map non-2xx envelopes for AS 5.3 and AS 5.5, and make `reachable()` exercise an authenticated read surface for AS 5.6.

  _Acceptance criteria:_
  - Client methods return the documented wire shapes
  - Non-2xx envelopes map to `StatioClientError` with stable code and status
  - Transport failures map to typed client errors without envelope codes
  - Slice trace headers are forwarded when provided
  - `reachable()` returns false for wrong-token, forge-down, and transport failures without throwing
  - Tests cover success, envelope errors, transport errors, trace header forwarding, and readiness behavior

**PR Outcome**: Consumers have a typed async Statio client and configuration surface that can be tested without a live service and later swapped into Herald/Legate follow-on work.

---

## Slice 2: Expose Authenticated HTTP Gateway Routes

**Goal**: Deliver the Fastify HTTP surface for Statio's open health/status routes, authenticated `/v1/*` routes, and uniform error envelopes.

**Justification**: This slice is a standalone working increment because a caller can start the service and reach the US3 repository read through the bearer-token HTTP boundary, proving auth and envelope behavior before additional forge reads are added.

**Addresses**: FR-006, FR-007, FR-009, FR-012; Acceptance Scenarios 5.1, 5.2, 5.3, 5.5, 5.6

### Tasks

- [ ] **Build the Statio Fastify service**

  Add the Statio service builder and serve entrypoint under `src/statio/`, with thin CLI dispatch in `src/cli/` only if needed to start the service. The HTTP layer should expose open health/status routes, authenticate `/v1/*`, route `/v1/repo` through the existing repo metadata seam, and leave later PR/list/thread routes to their own stories.

  _Acceptance criteria:_
  - `/healthz` and `/status` are open and satisfy AS 5.1
  - `/v1/repo` requires the bearer token and returns the documented success wrapper
  - Missing or wrong bearer tokens return `unauthorized` envelopes
  - Unknown routes return `not_found` envelopes
  - Forge and validation failures map to the stable envelope codes
  - Service startup validates the Statio port configuration
  - Tests cover open routes, auth rejection, authorized success, unknown routes, and error mapping

- [ ] **Wire client and service compatibility**

  Ensure the async client from Slice 1 interoperates with the service routes from this slice using the shared wire contracts. The compatibility work belongs in `src/statio/` tests and should verify the client-facing behavior from AS 5.3, AS 5.5, and AS 5.6 through the real Fastify app boundary.

  _Acceptance criteria:_
  - Client calls succeed against the authorized `/v1/repo` route
  - Client envelope mapping works against service-generated non-2xx responses
  - `reachable()` reports ready only through the authenticated `/v1/*` surface
  - Wrong-token and forge-down readiness probes return false
  - The service remains stateless across concurrent requests

**PR Outcome**: Statio can be started as an HTTP gateway with open liveness/status, bearer-token-gated v1 reads, uniform typed errors, and a compatible async client.

---

## Slice 3: Correlate Gateway Requests With Slice Traces

**Goal**: Make Statio request handling participate in the existing March trace model by nesting request spans under a provided slice id.

**Justification**: This slice is a standalone working increment because it closes the US5 trace-correlation contract without requiring the broader RED metrics, container packaging, or Grafana dashboard work owned by US6.

**Addresses**: FR-011; Acceptance Scenario 5.4

### Tasks

- [ ] **Add Statio request span correlation**

  Add Statio span helpers under `src/observability/` and service integration under `src/statio/` so request handling can read `x-march-slice-id` and nest spans on the deterministic slice trace. Keep telemetry env-gated and no-op when disabled, following the existing Castra and Herald trace patterns.

  _Acceptance criteria:_
  - Requests with `x-march-slice-id` produce child-nested Statio spans when telemetry is enabled
  - Requests without a slice id still produce valid service-local request spans when telemetry is enabled
  - Malformed or oversized slice ids are ignored for correlation and do not affect responses
  - Telemetry remains a no-op when `MARCH_OTEL` is unset
  - Span attributes stay low-cardinality and avoid concrete request paths
  - Tests cover child correlation, ignored invalid headers, and no-op behavior

**PR Outcome**: Statio HTTP requests carry slice-level trace correlation compatible with the existing one-trace-per-slice debugging model.

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
| S1 | Add Statio Client Configuration | — | — |
| S2 | Expose Authenticated HTTP Gateway Routes | S1 | — |
| S3 | Correlate Gateway Requests With Slice Traces | S2 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Resolve Repository Identity and Default Branch | depends on | The authenticated readiness route and `/v1/repo` route use the repo metadata seam from US3. |
| User Story 1: Read a Pull Request's State Through the Gateway | depended upon by | Single-PR reads use this story's client, auth, and envelope model. |
| User Story 2: Discover and List Pull Requests | depended upon by | PR listing uses this story's client, auth, and envelope model. |
| User Story 4: Read Unresolved Review Threads | depended upon by | Review-thread reads use this story's client, auth, and envelope model. |
| User Story 6: Operate Statio as an Observable Container | depended upon by | Containerization and dashboards package and observe the service foundation delivered here. |
