# Tasks: Request a CodeRabbit Review Once per Head Commit

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 4
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 04

---

## Slice 1: Request CodeRabbit Reviews From Durable Per-Head Intent
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Have Legate request CodeRabbit reviews on eligible opted-in forge PRs with restart-safe deduplication, bounded retries, and a daily budget.

**Justification**: Ship the durable intent and its only writer together so every automated trigger is recoverable from Herald. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-017–FR-024, the CodeRabbit portion of FR-033, FR-035, AS 4.1–4.10, SC-004, SC-008.

### Tasks

- [ ] **Persist review intent and account for the daily budget**

  Add the Review Request Record from data model entity 5 to Herald's event union, ingestion validation, and fold. Give Legate the history needed for per-head suppression and the CodeRabbit UTC daily cap in entity 8.

  _Acceptance criteria:_
  - Valid intents survive fold rebuild. Invalid reviewers, reasons, timestamps, and head SHAs are rejected. Repeated attempts on the same head remain distinct for budget accounting.
  - Suppression is scoped to the tracked PR, reviewer, and head. The cap counts all recorded CodeRabbit attempts across profiles, including attempts whose post failed, and starts a new bucket at UTC midnight.
  - An unset CodeRabbit cap is unlimited and zero disables posting. Invalid cap and wait settings fall back with a warning as specified by the environment contract.

- [ ] **Resolve CodeRabbit eligibility from policy and sensed PR state**

  Evolve the existing `src/legate/loop/handlers/coderabbit-rereview.ts` coordinator path for AS 4.1–4.8. Use US1 reviewer configuration, US2 verdicts and gate predicates, and US3 classified notices.

  _Acceptance criteria:_
  - Only tracked, open, non-draft, CI-green forge PRs with a CodeRabbit opt-in can trigger an initial request (FR-017, AS 4.1). New-head re-requests also require resolved threads and no conflicts (AS 4.7). Auto mode only observes. The old request path cannot bypass these conditions.
  - An APPROVED or CHANGES_REQUESTED verdict on the head suppresses a request. So does a fresh in-progress notice for the head or a recent intent. Once a request is recorded for the head, any CodeRabbit review on that head that answers it blocks another request for it, whatever its state (FR-017, FR-019). A review answers the request when its `submitted_at` is at or after the GitHub `created_at` of the sensed March-marked trigger comment for that head. Both timestamps come from GitHub's clock at whole-second precision, so the legate's clock and the intent's `at` play no part. Sensing samples only the newest PR comments, so missing from the sample is not proof the post failed. When an unanswered intent exists for the head and its trigger is not in the sample, the legate pages the full comment history for the March marker before deciding. Only a complete lookup that finds no trigger, for example after a failed post, means no review answers the request. If the lookup is incomplete or fails, the request stays unresolved for that tick and nothing is posted. A COMMENTED review submitted before the trigger, such as an earlier thread reply, is not an answer. An attempt with no answering review becomes eligible again, after the wait and any active back-off expire. This check reads CodeRabbit's raw reviews on the head, not the verdict summary, which drops COMMENTED reviews.
  - A COMMENTED review on a new head with no recorded request does not block a FR-020 re-request, for example a thread reply. It also does not hide a stale verdict on an older commit. The stale CHANGES_REQUESTED decides that re-request (SD-004).
  - New-head decisions cover all three FR-020 reasons, including a superseded unanswered request. A stale approval qualifies only when approval is the sole unmet gate. A qualifying stale changes-requested verdict continues to block merge until replaced.

- [ ] **Record intent before posting the review trigger**

  Wire the CodeRabbit adapter through Legate's injectable GitHub comment seam. Preserve March trigger recognition in sensing and keep the request path independent of merge authorization.

  _Acceptance criteria:_
  - The intent append is acknowledged before posting. Append failure suppresses the post. A failed or ambiguous post preserves the intent and cannot cause an immediate retry, including after restart.
  - The adapter posts only the incremental review command with a recognized March trigger marker. Tests cover the trigger and its exclusion from fix work for AS 4.10. The opted-in live check covers all four SC-008 outcomes.
  - Deterministic tick and restart coverage proves SC-004, including bounded retry, a push before the first verdict, and refusal when the daily cap is exhausted. Account-wide rate-limit detection and back-off updates belong to US5.

- [ ] **Expose review request outcomes and document the contracts**

  Instrument the request decision for AS 4.9 and align the Legate and Herald subsystem contracts and Legate compose environment header with the shipped behavior.

  _Acceptance criteria:_
  - Decisions that act or are refused emit the contracted `legate.review.request` child span in the existing slice trace. Append/post failures and cap exhaustion record error status. Back-off refusal is observable as back-off.
  - The request counter uses only reviewer and outcome labels. The action log uses the contracted review request actions.
  - Document the wait and CodeRabbit cap defaults and the current-head, allowlisted approval rule where the affected contract text describes the gate.

**PR Outcome**: An opted-in forge PR receives a durably recorded CodeRabbit request when eligible, with bounded retry and quota enforcement.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: reviewer; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which supported trigger body does CodeRabbit accept in the SC-008 live check? | S1 | testing | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Request CodeRabbit Reviews From Durable Per-Head Intent | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 | depends on | Supplies effective per-verb reviewer configuration. |
| US2 | depends on | Supplies sensed verdicts and merge gate predicates. |
| US3 | depends on | Supplies classified notices and filters March triggers from fix work. |
| US5 | depended upon by | Extends request decisions with durable reviewer back-off updates. |
| US6 | depended upon by | Uses request history for review state and cap visibility. |
| US7 | depended upon by | Uses the request ledger and adapter seam for Copilot. |
