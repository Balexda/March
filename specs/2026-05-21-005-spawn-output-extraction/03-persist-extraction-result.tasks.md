# Tasks: Persist Extraction Result

**Source**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.spec.md` - User Story 3
**Data Model**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.data-model.md`
**Contracts**: `specs/2026-05-21-005-spawn-output-extraction/spawn-output-extraction.contracts.md`
**Story Number**: 03

---

## Slice 1: Brood-Owned Extraction Result Persistence

**Goal**: Persist the backend-neutral `ExtractionResult` for a spawn through the Brood lifecycle authority, replacing the open storage-boundary debt with an idempotent current-result contract that records success and failure without duplicating patch artifacts.

**Justification**: User Story 3 turns the validated output from US2 into durable lifecycle state for downstream consumers. Brood already owns session state and cleanup, so the current extraction result should live with the Brood spawn record while legacy `~/.march/spawns/<id>.json` compatibility remains a fallback/read-through concern. This keeps March aligned with `docs/vision.md` and `docs/operating-philosophy.md`: autonomous callers get clean terminal state instead of re-parsing logs or waiting for operator intervention.

**Addresses**: FR-009, FR-010, FR-013, FR-014; Acceptance Scenarios 3.1, 3.2, 3.4

### Tasks

- [ ] **Add Brood persistence fields for extraction results**

  Extend the Brood session registry contract so a spawn session can store one current `ExtractionResult` with the fields required by the data model. The persisted shape should represent success with a validated patch and failure with stable failure metadata, while keeping diagnostics bounded and avoiding any branch push, PR creation, or Steward launch behavior.

  _Acceptance criteria:_
  - Successful results persist status `succeeded`, spawn id, backend, patch text, touched paths, digest, and extraction timestamp (AS 3.1).
  - Failed results persist status `failed`, spawn id, backend, failure reason, bounded diagnostic summary, and extraction timestamp (AS 3.2).
  - The Brood registry stores at most one current extraction result per spawn id, resolving SD-002 without introducing a separate artifact append log (AS 3.4).
  - The persistence shape remains backend-neutral and does not store unbounded raw backend output (FR-009, FR-013).
  - The change preserves legacy spawn-record readability for callers that still load `~/.march/spawns/<id>.json`.

- [ ] **Implement idempotent extraction result writes**

  Add the write path that accepts the terminal validation outcome from US2 and records it against the spawn's lifecycle row. Re-running extraction for unchanged source output should replace or preserve the same current result deterministically rather than appending duplicate patch files or creating multiple result rows.

  _Acceptance criteria:_
  - A successful validation outcome writes a successful `ExtractionResult` linked to the source spawn id and backend (AS 3.1).
  - A failed validation outcome writes a failed `ExtractionResult` with stable failure reason and bounded diagnostic (AS 3.2).
  - Retrying unchanged output leaves one current persisted result with the same patch digest or failure category, excluding the operational extraction timestamp (AS 3.4).
  - Missing or stale Brood spawn rows fail cleanly with a terminal persistence diagnostic instead of hanging autonomous callers (FR-014).
  - The write path has no Feature 6 dependency and does not apply patches, push branches, or create pull requests.

- [ ] **Cover persistence behavior with focused tests**

  Add tests for Brood-backed extraction result storage using isolated registry state and US2-style validation fixtures. The tests should prove success, failure, retry determinism, diagnostic bounding, and legacy record compatibility without requiring Docker, Castra, Hatchery, or a live Steward session.

  _Acceptance criteria:_
  - Tests assert successful persistence includes spawn id, backend, patch text, digest, touched paths, and extraction timestamp (AS 3.1).
  - Tests assert failed persistence includes spawn id, backend, failure reason, bounded diagnostic, and extraction timestamp (AS 3.2).
  - Tests assert repeated writes for unchanged output do not create duplicate patch artifacts or additional current-result rows (AS 3.4).
  - Tests cover absent Brood session state and prove the persistence path exits cleanly.
  - Existing Brood, spawn extraction, Hatchery, and CLI tests continue to pass.

**PR Outcome**: Brood can persist one backend-neutral current extraction result per spawn, covering successful validated patches and failed extraction diagnostics without re-reading backend logs or appending duplicate patch artifacts. Legacy spawn-record readers remain compatible, while Steward handoff and PR integration stay out of scope for US4 and Feature 6.

---

## Slice 2: Lifecycle Read Contract for PR Readiness

**Goal**: Expose persisted extraction completion through the spawn lifecycle read surface so downstream Hatchery and Steward consumers can determine PR-integration readiness without inspecting container logs or backend-specific output.

**Justification**: Persistence alone is not enough for User Story 3; consumers need a stable read boundary that says whether extraction is complete and whether the validated patch is ready for handoff. Keeping this as a second slice lets storage land first, then adds the lifecycle-facing readiness contract without launching Steward integration.

**Addresses**: FR-009, FR-011, FR-012, FR-014; Acceptance Scenarios 3.1, 3.2, 3.3

### Tasks

- [ ] **Expose extraction completion on lifecycle reads**

  Update the Brood lifecycle read path or adjacent spawn-owned query helper so consumers can read the current extraction result for a spawn and derive readiness from its terminal status. Successful extraction should expose the validated patch metadata required by later handoff, while failed extraction should expose only failure metadata and diagnostics.

  _Acceptance criteria:_
  - Lifecycle reads for a successful extraction expose status `succeeded`, spawn id, backend, validated patch text, digest, touched paths, and extraction timestamp (AS 3.1, AS 3.3).
  - Lifecycle reads for a failed extraction expose status `failed`, spawn id, backend, failure reason, bounded diagnostic, and extraction timestamp without a patch payload (AS 3.2, AS 3.3).
  - Consumers can determine whether the spawn is ready for PR integration from the persisted extraction status, not from raw container logs (AS 3.3, FR-012).
  - Failed extraction state remains terminal for this feature and cannot be mistaken for PR-ready handoff input (FR-011).
  - Missing extraction state is represented distinctly from succeeded and failed results so autonomous callers do not wait indefinitely on ambiguous state (FR-014).

- [ ] **Add lifecycle-read tests for readiness decisions**

  Add tests that read spawn lifecycle state after successful, failed, missing, and retried extraction results. Keep assertions focused on the stable contract and readiness decision, leaving Hatchery Steward launch behavior to US4.

  _Acceptance criteria:_
  - Tests prove a succeeded extraction result is readable as PR-ready with validated patch metadata (AS 3.3).
  - Tests prove a failed extraction result is readable as not PR-ready and exposes only failure metadata (AS 3.3).
  - Tests prove missing extraction state is distinguishable from both terminal result statuses.
  - Tests prove retry reads return one current result rather than duplicate patch artifacts (AS 3.4).
  - No tests launch Steward integration, apply patches, push branches, or create pull requests.

**PR Outcome**: Spawn lifecycle reads expose a stable extraction-result contract that tells downstream consumers whether a spawn is ready for PR integration, while failed or missing extraction state remains cleanly terminal or distinguishable without log inspection.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-002 | inherited from spec: The exact storage location for `ExtractionResult` must be reconciled with the live Brood registry and any legacy SpawnRecord JSON compatibility expectations before cutting implementation tasks. | Domain & Data Model | Medium | Medium | resolved | US3 resolves the storage boundary: Brood owns the current persisted `ExtractionResult` on the spawn lifecycle row; legacy `~/.march/spawns/<id>.json` compatibility remains read-through/fallback only. |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Brood-Owned Extraction Result Persistence | US2 | — |
| S2 | Lifecycle Read Contract for PR Readiness | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Validate Patch Payload | depends on | US3 persists the accepted or failed validation result produced by US2 and does not re-parse backend logs. |
| User Story 4: Hand Off Valid Patch to Steward Boundary | depended upon by | US4 consumes the persisted readiness contract introduced here and owns Hatchery Steward launch gating. |
