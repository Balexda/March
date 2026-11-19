# Tasks: Show Review State to the Operator

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 6
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 06

---

## Slice 1: Show Review State in Herald

<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Show the effective review state of each tracked PR in both forms of `march herald state`.

**Justification**: Ship the shared derivation with its operator-facing consumer so the same change defines the states and makes them visible. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-029, FR-030, AS 6.1–6.2, SC-009.

### Tasks

- [ ] **Derive review state from the fold**

  Add the shared pure derivation for AS 6.1 using the spec contract and data-model precedence.

  _Acceptance criteria:_
  - Use the resolved verb's bot allowlist and configured reviewers, sensed verdicts and notices, this PR's request ledger, and the account-wide back-off fold.
  - Deterministic coverage exercises all six states, precedence when signals overlap, missing head SHA, stale heads and elapsed waits, and bot identity and allowlist rules.

- [ ] **Expose review state in the Herald CLI**

  Enrich the Herald state read using the owning profile's registered merge policy and the slice verb. Render the resulting field in the CLI for AS 6.2 and SC-009.

  _Acceptance criteria:_
  - The table and JSON include a state for every tracked PR while preserving the existing summary and JSON fields. Historical projections use only review history through the requested sequence.
  - The derived field stays on the read projection. Sensed snapshots, events, and merge decisions retain their existing behavior.
  - Cover both CLI formats and profile-specific policy resolution with deterministic tests. Update the Herald subsystem contract for the changed state surface.

**PR Outcome**: Operators can inspect the review state of a tracked PR from Herald.

---

## Slice 2: Show Reviewer Budget in Grafana

<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Show request activity, rate limiting, and remaining review budget on the Legate dashboard.

**Justification**: Budget telemetry uses the account-wide ledger and can ship independently of PR state presentation. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-031, AS 6.3–6.4.

### Tasks

- [ ] **Export remaining review budget**

  Compute the cap windows in data model entity 8 from the same durable request history used for enforcement, and export the contracted gauge each Legate tick for AS 6.3.

  _Acceptance criteria:_
  - Count requests across profiles in UTC day and month buckets. Refresh after the tick's recorded requests so the displayed balance reflects new intents.
  - Publish finite caps with only reviewer and window labels, floor remaining capacity at zero, and omit unlimited windows. Use the specified defaults and share cap arithmetic with existing enforcement.
  - Deterministic tests cover multi-profile counts, UTC rollover, zero and exhausted budgets, and unlimited windows. Update the Legate subsystem contract for the gauge.

- [ ] **Display review telemetry on the Legate dashboard**

  Add panels using the existing review request and rate-limit counters and the cap gauge for AS 6.4.

  _Acceptance criteria:_
  - Operators can see requests grouped by reviewer and outcome, rate-limit hits by reviewer, and remaining cap by reviewer and window. The cap panel treats an absent unlimited window as absent rather than exhausted.

**PR Outcome**: Operators can inspect the budget and review activity without reading raw events.

---

## Specification Debt

<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions

<!-- audience: reviewer; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | How can a sensed in-progress notice without a commit SHA be attributed to the current head? | S1 | reading code | local |

## Dependency Order

<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Show Review State in Herald | — | — |
| S2 | Show Reviewer Budget in Grafana | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US2 | depends on | Supplies sensed verdicts and policy-aware bot matching for S1. |
| US4 | depends on | Supplies the folded request ledger and wait configuration for S1 and S2, and the request counter for S2. |
| US5 | depends on | Supplies account-wide back-off for S1 and the rate-limit counter for S2. |

Copilot budget windows are visible from the folded ledger and configured limits. Copilot request posting and enforcement belong to US7.
