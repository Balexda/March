# Tasks: Resolve the Merge Gate From a Per-Verb Policy Table

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 1
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 01

---

## Slice 1: Resolve and Manage Per-Verb Merge Policy
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Use one effective per-verb policy for Legate merge requirements and operator inspection, and store opt-in reviewer settings through Herald.

**Justification**: Ship resolution, validation, and operator controls together so profile edits appear in the CLI and take effect on the next tick. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-001–FR-008, FR-035, AS 1.1–1.9, SC-001.

### Tasks

- [ ] **Resolve complete policy rows by verb**

  Extend the shared policy module in `src/herald/profiles/merge-policy.ts` with the built-in rows and profile layering in the data model. Resolve merge requirements and reviewer configuration for AS 1.1–1.6 and AS 1.8.

  _Acceptance criteria:_
  - The SC-001 matrix covers every built-in verb, a profile-added verb, an unknown verb, and a missing verb with empty, relaxed, and per-verb policies.
  - Profile defaults apply only to profile-added verbs. Require an explicit per-verb override to relax changes-requested.
  - Reviewer resolution honors per-verb opt-ins and modes. Cut and forge request no reviewer by default.
  - Resolve bot approval with a normalized allowlist and use the built-in fallback when bot approval is enabled without a list.

- [ ] **Validate and round-trip policy through Herald**

  Extend the shared validator and registry path in `src/herald/profiles/` to accept the contracted wire shape and enforce AS 1.7. Keep existing stored policies readable.

  _Acceptance criteria:_
  - Valid policies round-trip through the registry with normalized bot logins and reviewer modes. Existing dependency-update and CodeRabbit settings survive unrelated policy edits.
  - Validation rejects March's configured or default bot identity after normalization, invalid allowlists, duplicate reviewer IDs, unsupported modes, unknown keys, and reserved verb keys.
  - Invalid writes preserve the saved policy. Invalid stored policy resolves through the built-in table.

- [ ] **Apply resolved requirements at the Legate gate**

  Keep babysit and merge readiness aligned in `src/legate/loop/` as they consume the new requirements. Connect AS 1.1, AS 1.3–1.5, and FR-008 to the existing merge path.

  _Acceptance criteria:_
  - Cut remains eligible without approval on an otherwise clear PR. Changes-requested blocks unless explicitly relaxed for the verb.
  - Required approval fails closed when available observations cannot establish an eligible reviewer. An aggregate bot count alone cannot satisfy the new forge policy.
  - CI, conflict, thread, and GitHub merge-state checks retain their existing behavior. US2 owns generalized reviewer verdict sensing and evaluation.

- [ ] **Edit and show effective policies in the CLI**

  Extend `march profile merge-policy` in `src/cli/program.ts` using the existing Herald client and the shared resolver. Implement the Operator CLI contract for AS 1.6, AS 1.7, and AS 1.9.

  _Acceptance criteria:_
  - Per-verb add and remove operations handle normalized bot logins and reviewer modes, preserve unrelated settings, and validate edits before saving.
  - Removing the last configured bot approver applies the resolver fallback when bot approval remains enabled. Removing the last reviewer leaves requests disabled for the verb.
  - Table and JSON output show every built-in and profile-added verb with effective requirements, approvers, reviewers, and value provenance.
  - Update affected subsystem contracts, the Legate compose header, and gate help or comments to match the behavior shipped in this slice.

**PR Outcome**: Operators can inspect and edit the policy Legate resolves for each verb. Later stories can consume the saved reviewer configuration and trusted approver list.

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
| S1 | Resolve and Manage Per-Verb Merge Policy | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US2 | depended upon by | Applies the resolved allowlist to each reviewer's latest verdict and head commit. |
| US4 | depended upon by | Uses resolved reviewer configuration to decide which review requests to send. |
