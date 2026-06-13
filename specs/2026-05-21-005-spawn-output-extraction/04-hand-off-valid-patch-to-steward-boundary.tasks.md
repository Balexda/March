# Tasks: Hand Off Valid Patch to Steward Boundary

**Source**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.spec.md` - User Story 4
**Data Model**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.data-model.md`
**Contracts**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.contracts.md`
**Story Number**: 04

---

## Slice 1: Hatchery Handoff Eligibility From Extraction Readiness

**Goal**: Gate Hatchery's Steward handoff on the persisted extraction readiness contract so only a successful, non-empty validated patch can become Steward input.

**Justification**: User Story 4 starts where US3 ends: Hatchery must consume the backend-neutral extraction result rather than re-parsing raw worker logs or accepting arbitrary spawn text. This slice delivers the security and autonomy boundary first, aligning with March's clean-exit posture by turning failed, missing, or no-op extraction into terminal diagnostics instead of launching a Steward that cannot safely apply work.

**Addresses**: FR-008, FR-011, FR-012, FR-014; Acceptance Scenarios 4.1, 4.2, 4.4

### Tasks

- [x] **Read extraction readiness before Steward handoff**

  Update the Hatchery spawn handoff path to consume the lifecycle read contract introduced by US3 before preparing any Steward patch input. The handoff should use only the successful `ExtractionResult.patch` fields and extraction metadata, while failed or missing extraction state produces a terminal Hatchery diagnostic without launching Steward patch-application behavior.

  _Acceptance criteria:_
  - Hatchery handoff reads the persisted extraction result or readiness helper instead of parsing raw container logs for patch content (AS 4.1, FR-012).
  - A succeeded extraction result exposes only validated patch text, digest, touched paths, backend, spawn id, and extraction timestamp as handoff input (AS 4.1).
  - Failed extraction state prevents Steward patch application launch and reports bounded failure metadata (AS 4.2, FR-011).
  - Missing extraction state is treated as not eligible and exits cleanly with a bounded diagnostic, not a hang or prompt for operator input (FR-014).
  - The handoff eligibility decision participates in the slice trace (keyed by `traceIdForDispatch`, nesting as a child on the `hatchery.spawn` → `steward.send` leg, never claiming root): an eligible decision emits a child span, and the failed and missing refusal paths emit *errored* spans so a refused Steward handoff is visible in the trace rather than silently absent (AGENTS.md observability lock-step; new lifecycle action / new failure mode).

- [x] **Reject empty validated patches at the handoff boundary**

  Add a final Hatchery-side guard that rejects a successful extraction result whose normalized validated patch is empty or no-op before any Steward handoff is prepared. Keep this as a defense-in-depth check over US2 validation so downstream code cannot launch a Steward with no meaningful patch input.

  _Acceptance criteria:_
  - Empty, whitespace-only, or normalized no-op patch text in a successful extraction result fails handoff eligibility (AS 4.4, FR-008).
  - The no-op failure records a bounded Hatchery diagnostic and does not expose raw backend output.
  - The no-op refusal emits an *errored* span on the slice trace (consistent with the failed/missing refusal paths above), keeping refused handoffs observable.
  - The guard does not re-parse backend envelopes or bypass the persisted extraction status.
  - Tests cover succeeded, failed, missing, and no-op extraction readiness decisions without Docker, Castra, or a live Steward session.
  - Tests assert the eligibility decision emits the expected span and that the failed, missing, and no-op refusal paths emit errored spans (low-cardinality attributes only).

**PR Outcome**: Hatchery can decide whether a spawn is eligible for Steward handoff from the persisted extraction result alone. Only successful non-empty validated patches reach the handoff input, while failed, missing, or no-op extraction results stop with bounded diagnostics and no Steward patch-application launch.

---

## Slice 2: Steward Patch Application Uses Validated Handoff Input

**Goal**: Ensure the Steward launch and patch-application path receives only the validated handoff payload and applies it in the manager or spawn worktree branch, never the operator's main checkout.

**Justification**: Once Hatchery has a safe handoff payload, the remaining User Story 4 behavior is constraining where and how that payload is applied. Keeping this separate from readiness gating lets the first slice fail closed before launch, then this slice updates prompt/artifact/application behavior without expanding into Feature 6 branch push or PR creation.

**Addresses**: FR-011, FR-012, FR-014; Acceptance Scenarios 4.1, 4.3

### Tasks

- [ ] **Build Steward artifacts from validated handoff input**

  Update Hatchery's manager prompt and handoff artifact creation so the Steward receives the validated patch and extraction metadata rather than raw spawn output. Preserve bounded diagnostics and metadata useful for review, but keep raw backend logs out of patch input.

  _Acceptance criteria:_
  - The patch artifact or prompt section used for Steward application is populated from the validated `ExtractionResult.patch.patchText` only (AS 4.1).
  - Handoff metadata includes spawn id, backend, touched paths, patch digest, extraction timestamp, and any bounded diagnostic summary needed for review.
  - Raw backend output is not passed as patch input and is not required for Steward to apply or review the validated artifact (FR-012).
  - Existing manager prompt requirements for acceptance-criteria verification and task checkbox updates remain intact.

- [ ] **Constrain patch application to the Steward worktree branch**

  Keep patch application scoped to the manager or spawn worktree path recorded for the handoff and reject attempts to apply the validated patch outside that branch-owned worktree. This task should preserve Hatchery's current separation from Feature 6: it may apply the patch for Steward review, but it must not push branches, open pull requests, or mutate the operator's main checkout.

  _Acceptance criteria:_
  - A launched Steward applies the validated patch only in the recorded manager or spawn worktree branch (AS 4.3).
  - Patch application refuses missing, empty, or operator-main-checkout worktree targets with terminal diagnostics instead of falling back silently (AS 4.3, FR-014).
  - Tests prove the apply path is invoked with the handoff worktree path and never with the repository root when those paths differ.
  - The slice does not add branch push, PR creation, or merge behavior; Feature 6 remains the owner of downstream PR integration.

**PR Outcome**: Steward handoff artifacts and application behavior consume the validated extraction payload and apply it only inside the handoff worktree branch. Hatchery no longer feeds arbitrary spawn text into Steward patch application, and Feature 6 remains responsible for push and PR integration.

---

## Specification Debt

None — all ambiguities resolved.

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Hatchery Handoff Eligibility From Extraction Readiness | — | — |
| S2 | Steward Patch Application Uses Validated Handoff Input | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Validate Patch Payload | depends on | US4 relies on US2's accepted patch validation and no-op rejection; it adds only the final Hatchery handoff guard. |
| User Story 3: Persist Extraction Result | depends on | US4 consumes the persisted extraction result and readiness contract from US3 rather than re-parsing backend logs. |
