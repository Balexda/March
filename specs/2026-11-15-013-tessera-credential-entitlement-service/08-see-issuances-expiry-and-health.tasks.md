# Tasks: See Issuances, Expiry and Health

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 8
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 08

Follow [March Vision](../../docs/vision.md) and the [Operating Philosophy](../../docs/operating-philosophy.md) for bounded diagnostics and minimally scoped access.

## Slice 1: Record Issuance Outcomes
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Give operators a matching audit record and span for each token request, with aggregate issuance and failure signals.

**Justification**: Extends the live issuance path independently of expiry reporting and stack diagnostics.

**Addresses**: FR-034–FR-036 (issuances, denials, mint latency and rate-limit pressure), FR-038, FR-042–FR-043, AS 8.1–8.3, AS 8.5, SC-005.

### Tasks

- [ ] **Complete token request audit and tracing**

  Extend the issuance lifecycle in `src/tessera/server.ts` and reuse `src/observability/tessera-trace.ts` for AS 8.1–8.3 and AS 8.5.

  _Acceptance criteria_
  - Each token request produces one audit event and one span when tracing is enabled, including authentication, validation, policy and provider failures.
  - The event follows the Issuance Audit Record schema, including repository, expiry, secret-redacted reserved subject, and typed reason. Unavailable fields follow the schema.
  - Denials and mint failures mark the span errored. A valid slice ID attaches it to the deterministic dispatch trace.
  - Fake-provider and HTTP coverage verifies completion paths, trace parentage and sentinel credential exclusion from telemetry and errors, including untrusted request and upstream data. Record observable behavior in the Tessera subsystem contract.

- [ ] **Measure issuance and GitHub rate limits**

  Add Tessera service instruments under `src/observability/` and measure at the request and provider boundaries.

  _Acceptance criteria_
  - Count each request outcome once, with a bounded reason for denials and failures.
  - Mint latency measures upstream mint attempts including failures. Cache hits and coalesced callers add no mint samples.
  - Rate-limit instruments reflect available GitHub signals. Labels exclude repositories, request paths, slice IDs, credentials and arbitrary error text.
  - Fake GitHub coverage verifies measurements, bounded labels and telemetry gating.

**PR Outcome**: Operators can correlate individual issuance attempts with aggregate failures and upstream rate-limit pressure.

## Slice 2: Show Provider Health and Expiry
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Surface provider readiness and expiry in Tessera and show its service metrics in Grafana.

**Justification**: Delivers the operator-facing health view and dashboard together with the expiry instruments they consume.

**Addresses**: FR-036 (expiry gauge), FR-037–FR-039, FR-041–FR-043, AS 8.4, AS 8.5, AS 8.7, SC-007.

### Tasks

- [ ] **Expose provider health and expiry warnings**

  Complete the Health and Status contract in `src/tessera/` and publish expiry measurements through `src/observability/`.

  _Acceptance criteria_
  - Liveness remains available with unconfigured or degraded providers. Status reports both provider records, cache count and the earliest known credential expiry.
  - Known expiry yields seconds remaining per provider and a warning metric at the 14-day threshold. Unknown expiry produces no warning. App status keeps app key expiry distinct from installation token expiry.
  - Status flags the warning. Tessera logs it upon detection, at most once per day for the expiring credential. Expiry checks work without token issuance traffic.
  - Clock-controlled tests cover threshold, repeat checks, unknown expiry and credential replacement with fake provider data. Responses and logs exclude secrets and raw upstream errors. Keep the Tessera subsystem contract current.

- [ ] **Add the Tessera service dashboard**

  Add a service dashboard under `docker/grafana/dashboards/` for AS 8.7.

  _Acceptance criteria_
  - Existing Grafana provisioning discovers the dashboard.
  - Panels render representative service telemetry for issuances, denial reasons, mint latency, time to expiry and rate-limit pressure using the emitted instruments and bounded labels. Missing expiry data is distinguishable from zero seconds remaining.

**PR Outcome**: Operators can see Tessera health and impending expiry while the service runs.

## Slice 3: Diagnose Running Stack Credential Wiring
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Report Tessera reachability, per-service key acceptance and ambient GitHub credentials through `march doctor`.

**Justification**: Delivers a complete diagnostic once deployed client-key wiring and the probe contract are settled.

**Addresses**: FR-038, FR-040, FR-042–FR-043, AS 8.6.

### Tasks

- [ ] **Check Tessera wiring from doctor**

  Extend the probes and findings in `src/doctor/` for AS 8.6. This slice requires a recorded resolution to SD-008 and the deployed client-key wiring from US3.

  _Acceptance criteria_
  - A bounded check reports Tessera reachability. Findings distinguish accepted, rejected, missing and unverifiable key wiring for each Tessera consumer service.
  - The agreed probe verifies the deployed key for the expected client identity without minting a credential or contacting GitHub.
  - Findings identify services carrying ambient `GH_TOKEN` or `GITHUB_TOKEN` by presence only. Human and JSON output omit credentials, fingerprints and raw environment output.
  - Fake Docker and HTTP coverage distinguishes healthy wiring, credential drift, ambient tokens and unavailable dependencies. Update affected subsystem contracts.

**PR Outcome**: Operators can distinguish reachability, key wiring faults and leftover ambient credentials in one doctor run.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-002 | Service client key distribution | Domain & Data Model | High | Medium | spec:SD-002 |
| SD-008 | Non-issuing key verification | plan-review:Logical gap | High | Low | spec:SD-008 |

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Record Issuance Outcomes | — | — |
| S2 | Show Provider Health and Expiry | S1 | — |
| S3 | Diagnose Running Stack Credential Wiring | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 | depends on | S1 extends issuance, tracing and the app provider. S2 completes the existing health and status surfaces. |
| US2 | integrates with | S1 can exercise auth and policy outcomes through the existing injectable boundary. S3 uses production authentication. |
| US3 | depends on | S3 cannot complete without US3's deployed client-key wiring (plus the SD-008 resolution). S2 consumes provider status after credential replacement. |
| US7 | integrates with | S2 can ship with fake provider coverage and report the user provider as unconfigured. Live PAT expiry requires US7. |
