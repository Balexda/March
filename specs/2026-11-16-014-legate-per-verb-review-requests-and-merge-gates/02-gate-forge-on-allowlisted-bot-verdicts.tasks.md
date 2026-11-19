# Tasks: Gate Forge on Allowlisted Bot Verdicts

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 2
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 02

---

## Slice 1: Apply Trusted Review Verdicts to the Merge Gate
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Let a current-head approval from an eligible review bot satisfy the forge gate and keep changes-requested blocking until superseded or explicitly relaxed.

**Justification**: Ship review evidence with its gate behavior so Legate can merge reviewed forge PRs autonomously and fail closed when evidence is incomplete. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-008–FR-013, FR-035, AS 2.1–2.8, SC-002–SC-003.

### Tasks

- [x] **Carry reviewer verdicts through PR observation**

  Extend review reduction in `src/observe/sense-io.ts` and carry its policy-free output through Herald using the Review Observation shape in the data model. Cover the evidence required by AS 2.1–2.7.

  _Acceptance criteria:_
  - The snapshot carries each normalized reviewer's latest meaningful verdict, author kind, reviewed commit or null, and submission time. Suffix variants of a bot login collapse to one identity. A comment does not erase a substantive verdict, and a dismissed approval cannot count.
  - March's own bot is excluded from reviewer verdicts. The observer classifies author kind independently of verb allowlists.
  - Preserve review pagination, completeness, legacy counts, and CodeRabbit observations. Existing snapshots remain readable. Update the contracts for the changed observation surface.

- [x] **Evaluate the shared merge gate from reviewer verdicts**

  Update the shared helpers in `src/herald/profiles/merge-policy.ts` and their Legate consumers so babysit and merge readiness apply the same evidence rules for AS 2.1–2.8.

  _Acceptance criteria:_
  - Approval requires an eligible human or, when the verb permits it, a verified allowlisted bot whose approval names the current head. Tests cover stale and missing commit evidence, untrusted bots, March's bot, human accounts with matching logins, and equivalent suffixed and unsuffixed bot logins.
  - An allowlisted bot's latest changes-requested blocks even on an older head until superseded. Human changes-requested continues to block. Explicit per-verb relaxation bypasses that requirement. Non-allowlisted bot verdicts have no effect on the gate.
  - Incomplete observations fail closed for required review checks. Legacy aggregate bot counts cannot establish trusted approval.
  - Integrated merge tests cover SC-002 and SC-003, including cut on a clear PR without approval. CI, conflicts, unresolved threads, and GitHub merge-state checks retain their existing behavior. Update the Legate contract and affected gate descriptions.

**PR Outcome**: Forge can merge on an eligible current-head bot approval while the shared gate enforces the resolved review requirements for every verb.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

_None — no open implementation questions._

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Apply Trusted Review Verdicts to the Merge Gate | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US1 | depends on | Supplies per-verb requirements and normalized bot allowlists. |
| US4 | depended upon by | Uses reviewer verdicts to identify review needs for the current head. |
| US6 | depended upon by | Uses reviewer observations to derive operator-visible review state. |
