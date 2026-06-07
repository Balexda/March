# Tasks: SpawnRecord Backend Traceability

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 7
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 07

---

## Slice 1: Selected Backend Record Population

**Goal**: Persist the selected backend name into every newly-created SpawnRecord while preserving the existing record schema and historical records.

**Justification**: US7 changes one durable metadata value at record creation time. Direct CLI dispatch and Hatchery handoff both create SpawnRecords, so they must land together to avoid a partial state where downstream consumers can trust one dispatch path but not the other.

**Addresses**: FR-016; Acceptance Scenarios 7.1, 7.2, 7.3, 7.4

### Tasks

- [ ] **Record selected backend names in new SpawnRecords**

  Update the CLI dispatch and Hatchery handoff record-creation paths so `writeInitialSpawnRecord` receives the resolved backend's `name` instead of relying on a hardcoded default. Keep the `SpawnRecord` type, persisted schema version, and existing record-reader behavior unchanged; this slice only changes how new records are populated. Cover both Codex and Claude/default dispatch paths while leaving existing on-disk records untouched.

  _Acceptance criteria:_
  - A new Codex dispatch writes `backend: "codex"` into the initial SpawnRecord, satisfying AS 7.1 under the live Codex substitution.
  - A new Claude Code dispatch, including the no-flag default path, writes `backend: "claude-code"`, satisfying AS 7.2.
  - Hatchery-created SpawnRecords use the selected backend supplied to the handoff path, not a separate hardcoded backend value.
  - Existing SpawnRecord files are never scanned, migrated, rewritten, or back-filled, satisfying AS 7.3.
  - `SpawnRecord.version` remains `1` and no new persisted fields are added, satisfying AS 7.4.
  - Existing lifecycle transitions, prompt/image/container updates, and failure cleanup behavior remain unchanged.

**PR Outcome**: New SpawnRecords accurately report the backend that ran the spawn across direct CLI dispatch and Hatchery handoff, while historical records and the version-1 schema remain untouched.

---

## Specification Debt

None — all ambiguities resolved.

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Selected Backend Record Population | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: SpawnBackend Interface and Registry | depends on | US7 records the `SpawnBackend.name` value defined by the backend contract. |
| User Story 3: Claude Code Backend (Refactor with Behavioral Preservation) | depends on | US7 preserves Claude Code as the default recorded backend. |
| User Story 4: Gemini CLI Backend | depends on | US7 consumes the live US4 substitution, `codexBackend`, as the non-default backend recorded in new SpawnRecords. |
| User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline | depends on | US7 records the same selected backend already used for dispatch-stage derivation. |
| User Story 1: Backend Selection at Dispatch Time | depends on | US7 relies on US1's resolved backend selection for CLI flag, env-var, and default paths. |
| User Story 6: Per-Backend Auth Pre-Flight Validation | depends on | US7 records successful launches after selected-backend auth has already passed. |
