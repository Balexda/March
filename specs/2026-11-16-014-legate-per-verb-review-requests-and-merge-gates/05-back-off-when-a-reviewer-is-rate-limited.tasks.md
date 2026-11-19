# Tasks: Back Off When a Reviewer Is Rate-Limited

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 5
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 05

---

## Slice 1: Enforce Durable Account-Wide Reviewer Back-off
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Defer automated CodeRabbit requests across all profiles until the reviewer can accept them again.

**Justification**: Ship persistence and enforcement together so Legate can stop requests across profiles and recover the same deadline after restart. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-023, FR-025–FR-028, AS 5.1–5.7, SC-006.

### Tasks

- [ ] **Persist account-wide reviewer back-off**

  Add the Reviewer Back-off event from data model entity 6 to Herald ingestion, the event union, and the multi-profile fold. Feed the resulting state into Legate's shared review history for AS 5.2 and AS 5.5.

  _Acceptance criteria:_
  - Ingestion validates the reviewer, UTC timestamp, cause, and attempt count, including the zero-attempt reset rule. Older logs without back-off events rebuild with no active back-off.
  - The latest event for a reviewer wins across profiles in event order. Replay restores the deadline and attempts, including a reset. An acknowledged update is visible to subsequent request decisions in the same tick.
  - Update the Herald and Legate subsystem contracts for the new event and its account-wide scope.

- [ ] **Record throttling signals and pace request retries**

  Extend the CodeRabbit review-request path to consume the typed outcomes of posting and the reviewer notices already gathered by sensing. Use the existing bounded exponential back-off helper for AS 5.1–5.5.

  _Acceptance criteria:_
  - A 429, a rate-limit notice, or a pause notice records its matching cause. A usable reset time takes precedence over the exponential delay. Consecutive hits without a reset time increase the delay up to the existing ceiling.
  - The same sensed notice cannot renew back-off or increment attempts on repeated ticks or after restart. An expired notice cannot re-arm back-off. Other post failures record `post_failed` and retain the request intent.
  - Any eligible CodeRabbit post sees the account-wide deadline, including when a notice was already sensed for a different profile in the same tick. While cooling down, Legate neither records a new request intent nor posts a trigger. If a back-off update fails to persist, Legate keeps the pending update and retries it on later ticks. It posts nothing to that reviewer until the update persists.
  - Deterministic coverage for SC-006 proves stated resets, exponential delay, suppression across profiles and restart, and the absence of fallback to Copilot. Copilot request implementation belongs to US7.

- [ ] **Clear pacing after a fresh review**

  Observe review recovery even when the reviewer is cooling down or there is no eligible request, as required by AS 5.6.

  _Acceptance criteria:_
  - A new review by the affected reviewer on the current head after the back-off signal resets nonzero attempts durably. Stale reviews cannot clear newer back-off.
  - Sensing and merge-gate evaluation still use incoming reviews during back-off. Test that a qualifying verdict can satisfy the gate and that the reset survives replay.

- [ ] **Report back-off outcomes in the slice trace**

  Extend the existing review request telemetry for AS 5.7 and align the Legate contract with the emitted signals.

  _Acceptance criteria:_
  - A rate-limit hit increments `march.legate.review.rate_limited` once with only the reviewer label. Rate-limit or pause decisions and active-back-off refusals emit a non-errored `legate.review.request` child span with outcome `backoff` and the contracted attributes and deferred action. A refusal caused by an existing deadline does not count as a new hit.
  - Other post failures and failures to persist a back-off update emit errored spans. The existing reviewer/outcome request counter remains aligned with the decision spans.

**PR Outcome**: Legate defers CodeRabbit requests across all profiles after throttling, preserves the deadline through restart, and continues to process reviews.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: reviewer; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How does the CodeRabbit posting seam expose a 429 and any reset time to Legate? | S1 | building | local |
| IQ-002 | Which stable observation identity lets Legate deduplicate notices after replay? | S1 | building | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Enforce Durable Account-Wide Reviewer Back-off | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US4 | depends on | Supplies the review coordinator, durable intent, and posting seam. |
| US6 | depended upon by | Uses the folded back-off state to derive review status. |
| US7 | depended upon by | Applies account-wide pacing to the independently configured Copilot adapter. |
