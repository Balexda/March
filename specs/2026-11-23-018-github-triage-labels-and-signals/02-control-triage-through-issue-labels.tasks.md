# Tasks: Control triage through issue labels

**Source**: `specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.spec.md` — User Story 2
**Data Model**: `specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.data-model.md`
**Contracts**: `specs/2026-11-23-018-github-triage-labels-and-signals/github-triage-labels-and-signals.contracts.md`
**Story Number**: 02

---

## Slice 1: Interpret issue labels and history
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver a deterministic interpreter in `src/triage/` for operator overrides, re-entry, and explicit acceptance.

**Justification**: The decisions share an authoritative snapshot, ordered observations, and verdict provenance. One slice delivers the complete contract and verifies it with fixtures independently of GitHub services.

**Addresses**: FR-001, FR-003, FR-004, FR-005 and AS 2.1–2.3.

### Tasks

- [x] **Interpret live labels and protect operator edits**

  Share the exact contract catalog across triage consumers and keep its outcomes and confidence values aligned with `src/triage/verdict.ts`. Interpret the live GitHub snapshot, observed changes, and optional verdict provenance for AS 2.1.

  _Acceptance criteria:_
  - Map every contract element to its exact label. Keep acceptance and resubmit under operator ownership.
  - Prefer live labels when the mirror lags. A missing state label implies untriaged and conflicting managed labels yield unresolved state.
  - Preserve entire edited groups, including removals and conflicts, across same-content verdicts, reopen, and resubmit. Use provenance and history to identify known writer changes, preserve observed differences when attribution is uncertain, and defer conclusions that require missing evidence.
  - Hash the ordered title and body with unambiguous field boundaries and treat a missing body as empty. A content transition retires the override even if the issue later returns to the original text.
  - Verify catalog mapping, state decoding, mirror lag, same-content overrides, uncertain attribution, and override retirement with fixtures.

- [x] **Recognize fresh re-entry transitions**

  Evaluate AS 2.2 from ordered observations and distinct change identities. Use caller-provided evidence of previously handled changes to recognize replay.

  _Acceptance criteria:_
  - A fresh title/body hash change, closed-to-open transition, or distinct resubmit addition qualifies a current open issue, including an `automated` issue. Co-occurring triggers qualify once per observation with a reported trigger. Replaying that observation after it was handled cannot qualify through another co-occurring trigger.
  - Replay, persistent resubmit, comments, timestamps alone, March's triage writes, and rubric-only revisions produce no new eligibility. Removal and re-addition of resubmit can qualify again.
  - Incomplete history yields unresolved re-entry so consumers can defer and re-evaluate. Fixtures cover each trigger, each exclusion, co-occurrence and its replay, closed issues, and incomplete history.

- [x] **Verify explicit acceptance of the current recommendation**

  Evaluate AS 2.3 from the live labels, content hash, and acceptance history. Reuse the F1 build-outcome classification in `src/triage/verdict.ts` and document the mapped interface in `docs/subsystems/triage/contract.md`.

  _Acceptance criteria:_
  - Authorization requires an open issue with only the triaged state, exactly one outcome and one confidence, and a still-present acceptance addition verified against the current build recommendation.
  - Return point-in-time decision evidence with the build outcome, content hash, and addition identity for authorized cases. Removal, content changes, and effective recommendation changes invalidate the earlier association. A later addition needs its own verified association.
  - Fixtures cover authorization for each build outcome and denial for each non-build outcome, confidence alone, managed-label conflicts, and absent, stale, ambiguous, removed, or unverified acceptance.
  - Keep history acquisition, GitHub writes, scheduling, and downstream live rechecks and intake deduplication with their owning features.

**PR Outcome**: Fixture-tested label and history interpretation for verdict writing, re-triage, and intake consumers.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

_None — no specification debt was recorded._

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|---|---|---|---|---|
| IQ-001 | Which qualifying trigger does the result report when fresh triggers co-occur? | S1 | building | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|---|---|---|---|
| S1 | Interpret issue labels and history | — | — |

### Cross-Story Dependencies

US1 and US2 share the FR-001 catalog. Either story can introduce it first and the other should reuse it. US2 fixtures run independently of repository provisioning.

### Cross-Repo Notes

None — single repo.
