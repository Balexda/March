# Tasks: Operate Statio as an Observable Container

**Source**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — User Story 6
**Data Model**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.data-model.md`
**Contracts**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md`
**Story Number**: 06

---

## Slice 1: Package Statio for the March Network
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver the Statio container image and compose recipe that run the existing service with the required token, deterministic port, localhost host binding, and external `march` network membership.

**Justification**: This slice is a standalone working increment because an operator can build and run Statio from the repo root, prove the service is reachable in the same topology as Castra, and fail fast on missing auth before broader telemetry and dashboard work lands.

**Addresses**: FR-013, FR-017; Acceptance Scenarios 6.1, 6.2

### Tasks

- [x] **Add the Statio service image and compose recipe**

  Add `docker/statio.Dockerfile` and `docker/statio.docker-compose.yml` following the Castra/Hatchery container conventions while keeping Statio forge-only. The compose file should require `MARCH_STATIO_TOKEN`, publish the deterministic service port to localhost only, join the external `march` network, provide the peer-network URL, and install/provision only the runtime dependencies Statio needs to execute `gh` reads.

  _Acceptance criteria:_
  - Compose bring-up aborts clearly when `MARCH_STATIO_TOKEN` is unset for AS 6.1
  - The service binds localhost on `MARCH_STATIO_PORT` or the deterministic 9689 default for AS 6.2
  - The container joins the external `march` network and exposes `MARCH_STATIO_URL` for peer consumers
  - The image includes the built March CLI, Statio service entrypoint, `gh`, and minimal runtime dependencies
  - The compose recipe does not mount unrelated host control surfaces or grant broader access than Statio needs
  - Tests or script-level validation cover required-token interpolation, port override wiring, network declaration, and service command shape

- [x] **Add build and entrypoint integration for Statio**

  Wire the Statio image into the repo's build scripts and CLI/service startup path as needed so operators can build the image through `npm run` and the container can start `march statio serve` consistently with the local service command. Preserve the existing public CLI contract except for adding the Statio serve entrypoint required by this story.

  _Acceptance criteria:_
  - `npm run` exposes a Statio image build command consistent with existing service image scripts
  - The container entrypoint starts the Statio service on the configured host and port
  - Port override validation still fails fast before binding
  - Startup does not modify existing `gh` call sites or consumer behavior
  - Verification covers the new script/entrypoint path without requiring a live forge

**PR Outcome**: Statio can be built and started as a secured service container on the `march` network, with deterministic host reachability and no broader host access than the forge gateway requires.

---

## Slice 2: Emit Statio RED Metrics, Heartbeat, Spans, and Logs
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Make the running Statio service observable under `service.name=march-statio` with request RED metrics, heartbeat/uptime, per-operation spans, and request logs. Metrics, spans, and the OTLP log-export bridge are no-op unless `MARCH_OTEL=1`; pino stdout/JSONL request logging stays active regardless (matching `src/observability/logger.ts`, which only gates the OTLP stream on `otelEnabled`).

**Justification**: This slice is a standalone working increment because it makes Statio's service behavior debuggable through the existing OTel pipeline before adding the Grafana dashboard presentation layer.

**Addresses**: FR-011, FR-018; Acceptance Scenarios 6.3, 6.4

### Tasks

- [ ] **Add Statio metrics and heartbeat instrumentation**

  Add Statio-owned metric helpers under `src/observability/` or `src/statio/` following the existing service telemetry patterns. Record request count and latency with low-cardinality labels, expose heartbeat/uptime instruments, and integrate them with Statio request handling so telemetry remains disabled when `MARCH_OTEL` is unset.

  _Acceptance criteria:_
  - Request count and latency metrics are emitted for handled Statio routes when telemetry is enabled for AS 6.3
  - Heartbeat and uptime instruments identify a live Statio process for AS 6.3
  - Metric labels use route patterns/status classes/operation names and never PR numbers, concrete request paths, tokens, or slice ids
  - Instrument creation is stable across repeated OTel initialization in tests
  - With `MARCH_OTEL` unset, metric and heartbeat helpers are no-ops for AS 6.4
  - Tests cover enabled metrics, no-op telemetry, heartbeat stopping, and low-cardinality labels

- [ ] **Instrument Statio operations and request logs**

  Extend Statio request/forge handling so authenticated reads emit per-operation spans, mark failures as errored spans, preserve child nesting from `x-march-slice-id`, and write request logs through the shared pino/OTLP logger under `march-statio`. Keep logs bounded and free of token, PR body, or raw forge payload data.

  _Acceptance criteria:_
  - Each v1 read operation emits a span with low-cardinality attributes when telemetry is enabled for AS 6.3
  - Forge failures and unexpected service failures mark the corresponding span errored
  - Valid slice ids continue to nest Statio spans under the deterministic slice trace; malformed or oversized ids are ignored without response impact
  - Request logs carry Statio service identity and enough status/outcome context for Grafana log panels
  - With `MARCH_OTEL` unset, spans and the OTLP log-export bridge are no-ops and service behavior is unchanged for AS 6.4; pino stdout/JSONL request logging remains active so operators keep local/container logs in telemetry-off runs
  - Tests cover successful spans, errored spans, slice-id nesting, ignored invalid slice ids, and log field hygiene

**PR Outcome**: Statio emits the operational signals needed to debug request rate, errors, latency, liveness, forge failures, and slice-correlated request paths through the existing observability stack.

---

## Slice 3: Surface Statio in Grafana and Operator Validation
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Add the Statio Grafana dashboard and operational validation so operators can confirm the container is reachable and its telemetry is visible in the March observability stack.

**Justification**: This slice is a standalone working increment because it completes the operator-facing surface for Story 6 without changing the gateway's forge behavior or cutting any consumer over to Statio.

**Addresses**: FR-017, FR-018; Acceptance Scenarios 6.2, 6.3, 6.4

### Tasks

- [ ] **Add the Statio Grafana dashboard**

  Add a `March — Statio forge gateway` dashboard under `docker/grafana/dashboards/` and ensure provisioning discovers it alongside the existing March service dashboards. The dashboard should visualize Statio RED metrics, heartbeat/uptime, span/log correlation, and forge-error visibility using the labels emitted by Slice 2.

  _Acceptance criteria:_
  - The dashboard is provisioned with the existing Grafana stack and uses `service.name=march-statio`
  - Panels show request rate, error rate, latency, heartbeat/uptime, and recent Statio logs for AS 6.3
  - Queries use only low-cardinality labels and route patterns
  - Dashboard content remains useful when there is no traffic or telemetry is disabled
  - Validation covers dashboard JSON parseability and provisioning visibility

- [ ] **Document and validate the operator run path**

  Update the relevant operator-facing docs or compose comments so the Statio bring-up sequence is clear: observability stack first, token required, image build, compose up, deterministic localhost URL, and telemetry-on/off behavior. Add automated validation that checks the compose/dashboard artifacts without requiring a live Docker daemon unless the existing verification path already provides one.

  _Acceptance criteria:_
  - Operator instructions cover token setup, `MARCH_STATIO_PORT`, `MARCH_STATIO_URL`, `MARCH_OTEL`, and the external `march` network for AS 6.2-AS 6.4
  - Validation catches missing required token interpolation, missing dashboard provisioning, malformed dashboard JSON, and accidental public port binding
  - The documented telemetry-off path states that service behavior is unchanged when `MARCH_OTEL` is unset
  - The documented telemetry-on path points to the `March — Statio forge gateway` dashboard
  - No consumer cutover or existing `gh` call site is modified

**PR Outcome**: Operators have a documented, validated path to run Statio in the March stack and inspect its forge gateway signals in Grafana.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Env-var naming convention: `MARCH_STATIO_*` (this spec) vs. Castra's `CASTRA_*`. Two conventions exist in the stack. | Constraints | Low | Medium | inherited | — |
| SD-002 | inherited from spec: Forge-auth provisioning: env token vs. read-only `~/.config/gh` mount, and interaction with `gh`'s own credential resolution. | Domain & Data Model | Medium | Medium | inherited | — |
| SD-003 | inherited from spec: Whether the resilience seam (rate-limit/retry/read-cache) ships in this foundation spec (default-off) or arrives with the first measured need. | Architecture | Low | Medium | inherited | — |
| SD-004 | inherited from spec: `reviewThreads` GraphQL response shaping (resolved-thread filtering + comment-id dedup) must match `sense-io.ts`'s current output exactly for a behavior-preserving Herald cutover. | Domain & Data Model | Medium | High | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Package Statio for the March Network | — | — |
| S2 | Emit Statio RED Metrics, Heartbeat, Spans, and Logs | S1 | — |
| S3 | Surface Statio in Grafana and Operator Validation | S2 | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Read a Pull Request's State Through the Gateway | depends on | Operational telemetry and dashboards observe the single-PR read once implemented, but this story does not change the read semantics. |
| User Story 2: Discover and List Pull Requests | depends on | Operational telemetry and dashboards observe list reads once implemented, but this story does not change PR discovery behavior. |
| User Story 3: Resolve Repository Identity and Default Branch | depends on | Container readiness and authenticated reachability rely on the repository read surface from the foundation stories. |
| User Story 4: Read Unresolved Review Threads | depends on | Operational telemetry and dashboards include review-thread route behavior once implemented, but this story does not change thread shaping. |
| User Story 5: Reach the Gateway Over HTTP With Auth and Uniform Typed Errors | depends on | Containerization and telemetry package the authenticated HTTP service, client env vars, error model, and trace-header foundation delivered by US5. |
