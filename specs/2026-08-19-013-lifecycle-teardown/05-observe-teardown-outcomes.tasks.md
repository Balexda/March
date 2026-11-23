# Tasks: Observe Teardown Outcomes

**Source**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.spec.md` — User Story 5
**Data Model**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.data-model.md`
**Contracts**: `specs/2026-08-19-013-lifecycle-teardown/lifecycle-teardown.contracts.md`
**Story Number**: 05

## Slice 1: Correlate Teardown Diagnostics

<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Let operators identify where a teardown stopped from its response, trace, and request log, and count outcomes in Grafana.

**Justification**: Brood already produces ordered step results, teardown spans, and a duration and outcome series. Align their diagnostics in one slice so the same failed request is recognizable across all three surfaces. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-019, FR-020, FR-021, FR-022. AS 5.1–5.5 and SC-007.

### Tasks

- [ ] **Align teardown traces and returned step outcomes**

  Reuse the span and ordered step results in `src/brood/service/teardown.ts` and the context handling in `src/observability/brood-trace.ts`. Cover AS 5.2–5.4 at the Brood service boundary.

  _Acceptance criteria_
  - Each cleanup step is visible under the teardown span with its name, outcome, and bounded diagnostic detail where available. Failed or deferred outcomes mark the teardown span errored.
  - Unverified steward removal is reported as a steward failure with deferred worktree and branch steps in both the trace and the ordered non-terminal response.
  - An inbound trace parent reaches the teardown span through the HTTP route and cleanup telemetry stays under that span.

- [ ] **Record teardown outcomes in metrics and request logs**

  Reuse Brood's teardown instruments and structured request logger to cover AS 5.1 and 5.5. Exercise success, partial, and failed outcomes across the telemetry and service boundaries.

  _Acceptance criteria_
  - Successful cleanup emits a successful teardown span and records a success count and duration. Partial and failed results record their corresponding outcomes. Metric labels use low-cardinality kind, outcome, and profile dimensions and exclude session or spawn IDs, branch names, worktree paths, and concrete request paths.
  - Request logs for failed or deferred cleanup identify the affected steps with bounded diagnostics, including when the HTTP response is successful and the teardown status is non-terminal. Preserve request error logging for HTTP errors.
  - Document the resulting signals in Brood's contract and keep the Brood dashboard aligned with emitted telemetry.

**PR Outcome**: Operators can distinguish completed, partial, and failed teardown attempts and locate the step that blocked cleanup.

## Specification Debt

_None — no specification debt was recorded._

## Dependency Order

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Correlate Teardown Diagnostics | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 Request A Safe Teardown | depends on | Reuse request admission, the teardown endpoint, and its inbound trace context. |
| US3 Reclaim Runtime Artifacts By Exact Identity | integration | Instrument existing outcomes. Any new cleanup action carries its own trace coverage in US3. |
| US4 Make Teardown Idempotent And Retryable | integration | Observe returned outcomes while US4 owns retry rules and call-out deadlines. |
