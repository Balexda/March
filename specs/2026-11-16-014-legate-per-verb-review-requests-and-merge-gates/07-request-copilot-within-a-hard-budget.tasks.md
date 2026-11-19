# Tasks: Request Copilot Within a Hard Budget

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 7
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 07

---

## Slice 1: Request Copilot Under Durable Account-Wide Caps
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Let profiles opt individual verbs into Copilot review using the operator's Tessera identity and hard UTC budgets.

**Justification**: Ship credential and budget enforcement with the first usable request path. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-023, FR-032–FR-035, AS 7.1–7.6, SC-005. Reuses FR-017–FR-020 and FR-024–FR-028.

### Tasks

- [x] **Enforce account-wide UTC request budgets**

  Extend Legate's review request limits with the Reviewer Cap Window from the data model. Enforce FR-033 for AS 7.1, 7.3 and 7.6.

  _Acceptance criteria:_
  - Both Copilot windows must have capacity and each defaults to zero. CodeRabbit retains its optional daily cap. Invalid settings warn and use the contracted defaults.
  - Count durable intents per reviewer across all profiles, including intents whose post failed. An acknowledged intent consumes capacity before any subsequent decision in the same tick.
  - Deterministic coverage exercises both UTC boundaries independently, cross-profile exhaustion, and usage restored by replay.

- [x] **Apply per-verb request eligibility to Copilot**

  Extend the Legate review coordinator to evaluate Copilot for AS 7.1, 7.2, 7.5 and 7.6. Reuse the shared request rules established by US4.

  _Acceptance criteria:_
  - The resolved verb must list Copilot. Evaluate FR-017–FR-020 using Copilot's sensed reviews and notices and its durable request history.
  - An acknowledged Herald intent precedes posting. A failed append prevents posting, and replay restores the wait on the same head.
  - Request opt-in leaves approval controlled by the allowlist under AS 7.5. Deterministic coverage exercises opt-in and verdict handling with and without the allowlist entry.

- [x] **Request Copilot with the operator's Tessera identity**

  Implement the adapter through the Legate runtime request seams and Tessera client. Cover AS 7.2 and 7.4.

  _Acceptance criteria:_
  - After eligibility and cap checks, obtain the slice-scoped `user` identity with `write` access. Use its token only for the bounded GitHub requested-reviewers call for Copilot.
  - Identity refusal or failure leaves the request unmade, with no app or ambient credential fallback. Token material stays out of logs, spans and events.
  - Deterministic coverage exercises authenticated posting and identity failure. Merge evaluation remains available after request failure.

- [x] **Apply Copilot back-off and report request decisions**

  Extend Legate's US5 pacing and request telemetry to Copilot. Apply the Events / Hooks contract for AS 7.3 and 7.4.

  _Acceptance criteria:_
  - A 429 or applicable sensed notice records account-wide durable Copilot back-off. The US5 reset and bounded retry rules apply, and refusal never triggers a different reviewer.
  - Request decisions emit the contracted `legate.review.request` child span and increment the reviewer/outcome counter. Actual rate-limit hits increment the reviewer-only counter.
  - Deterministic coverage confirms errored spans for cap exhaustion, unavailable identity and other failures, and a non-errored deferred outcome for back-off.

- [x] **Document Copilot configuration and identity ownership**

  Update the Legate subsystem contract and compose header for FR-035. Preserve the Tessera handoff required by FR-034.

  _Acceptance criteria:_
  - The contract describes opt-in, the credential boundary, cap refusal and request telemetry. The compose header documents cap variables and defaults, and the service receives those variables.
  - Affected approval guidance reflects the effective per-verb allowlist and its independence from review requests.
  - Tessera US7, FR-032, SC-008 and the GitHub request contract defer policy to this spec. Tessera owns the user identity and SD-009 records the durable intent resolution.

**PR Outcome**: Legate can request Copilot for an opted-in verb with the operator's identity, durable budgets and observable refusals.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: reviewer; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Will GitHub accept the Tessera-provided user credential for the Copilot reviewer endpoint? | S1 | testing | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Request Copilot Under Durable Account-Wide Caps | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US4 | depends on | Supplies request eligibility, durable intents and the bounded wait. |
| US5 | depends on | Supplies durable account-wide reviewer pacing and reset behavior. |
| Tessera US4 | depends on | Supplies the client for acquiring the operator's user identity. |
