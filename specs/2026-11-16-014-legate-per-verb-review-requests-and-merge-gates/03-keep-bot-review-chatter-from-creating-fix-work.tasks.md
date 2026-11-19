# Tasks: Keep Bot Review Chatter From Creating Fix Work

**Source**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.spec.md` — User Story 3
**Data Model**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.data-model.md`
**Contracts**: `specs/2026-11-16-014-legate-per-verb-review-requests-and-merge-gates/legate-per-verb-review-requests-and-merge-gates.contracts.md`
**Story Number**: 03

---

## Slice 1: Filter Reviewer Chatter During PR Sensing
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Keep reviewer notices and March review triggers out of Legate's fix queue while preserving actionable PR feedback.

**Justification**: Shared sensing feeds both fix dispatch and merge readiness. Filtering there delivers the behavior before US4 posts review requests. [March vision](../../docs/vision.md) · [Operating philosophy](../../docs/operating-philosophy.md)

**Addresses**: FR-014–FR-016, AS 3.1–3.5, SC-007.

### Tasks

- [ ] **Classify reviewer conversation comments and March triggers**

  Extend the classification in `src/observe/review-bot-comments.ts` using the classification portion of the Reviewer Adapter contract. Preserve existing CodeRabbit and Codex marker handling and cover AS 3.1, AS 3.2, AS 3.3, and AS 3.5.

  _Acceptance criteria:_
  - Fixtures cover CodeRabbit summaries, progress, rate limits, and pauses. Notices carry a reset timestamp when the notice supplies one.
  - An unrecognized conversation comment from a bot whose normalized login matches the reviewer's adapter classifies as status, with or without the `[bot]` suffix. This identity-based fallback works without a marker and leaves unrelated authors eligible to give feedback.
  - Recognize March's opening trigger marker and preserve existing command-first triggers. Marker-based exclusion requires the marker or command to open the comment. A human comment quoting either later in its body remains feedback.

- [ ] **Keep reviewer chatter out of fix and merge decisions**

  Classify the full comment body in the shared PR sensing path in `src/observe/sense-io.ts`, before building bounded previews. Keep classified notices in the policy-free snapshot shape defined in the data model and preserve the separate inline-thread path for AS 3.4.

  _Acceptance criteria:_
  - A mixed PR regression test shows that status, progress, rate-limit, and trigger comments cause neither a fix turn nor an outstanding conversation-comment merge blocker. An unacknowledged human comment still needs a response.
  - The snapshot reports reviewer progress, pause, and rate-limit signals only for verified reviewer bot authors. Marker text alone cannot create those signals.
  - An unresolved bot inline thread still needs a response and blocks merge even if its body opens with a reviewer marker.
  - Existing Codex review-state and CodeRabbit request observations remain available. Update the owning subsystem contract for any mapped snapshot surface changes.

**PR Outcome**: Legate continues to act on PR feedback and unresolved inline threads while reviewer conversation chatter stops creating fix work.

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
| S1 | Filter Reviewer Chatter During PR Sensing | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 4: Request a CodeRabbit Review Once per Head Commit | depended upon by | US4 uses the classification seam and can post triggers after US3 keeps them out of fix dispatch. |
