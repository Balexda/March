# Tasks: Read Spawn Records Tolerantly

**Source**: `specs/2026-06-13-011-brood-session-index/brood-session-index.spec.md` — User Story 1
**Data Model**: `specs/2026-06-13-011-brood-session-index/brood-session-index.data-model.md`
**Contracts**: `specs/2026-06-13-011-brood-session-index/brood-session-index.contracts.md`
**Story Number**: 01

---

## Slice 1: Add Tolerant Spawn Record Reader
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver `listSpawnRecords()` and the story-owned `loadSpawnRecord(id)` behavior in a new spawn index reader so downstream Brood verbs have one tolerant read API over existing per-spawn JSON records.

**Justification**: This is a complete read substrate for US1: callers can list valid records, skip corrupt in-flight writes, tolerate records without `profile`, and load one known id without re-parsing JSON at each call site. It does not implement derived view flags, Docker liveness reconciliation, CLI verbs, teardown, or any write path owned by later stories.

**Addresses**: FR-001, FR-002, FR-003, FR-004, FR-012; Acceptance Scenarios 1.1-1.4

### Tasks

- [ ] **Add the spawn index reader module**

  Add `src/brood/spawn-index.ts` as the repository-internal reader module over the existing `src/brood/spawn-record.ts` record shape and path helpers. Expose story-owned list and load behavior while leaving `derivedStatus` for the later derived-view slices; AS 1.1 and AS 1.4 define the observable read outcomes.

  _Acceptance criteria:_
  - `listSpawnRecords()` returns valid records from the configured spawn-record directory
  - `loadSpawnRecord(id)` returns the matching record when present
  - A missing id returns the deterministic not-found result from the contract
  - The reader accepts records without an M2-era `profile` field
  - The module does not mutate disk or Docker state

- [ ] **Implement the safe-read skip warning**

  Extend the reader path in `src/brood/spawn-index.ts` with the US1 safe-read protocol for list operations. Keep unreadable-file handling local to the index reader so downstream verbs can consume `listSpawnRecords()` without duplicating parse recovery logic.

  _Acceptance criteria:_
  - A parse failure during listing is retried once before the file is skipped
  - A still-unparseable record is skipped without failing the whole list
  - The skip path emits a warning diagnostic as described by the contracts
  - Other valid records in the same directory are still returned
  - The implementation remains a pure read path with no cleanup or rewrite side effects

- [ ] **Cover tolerant reader behavior with tests**

  Add focused tests beside the Brood record/index modules using isolated home-directory fixtures. Cover AS 1.1-1.4 through the exported API, including valid records, an unreadable mid-write record, a profile-less record, a known id, and an unknown id.

  _Acceptance criteria:_
  - Tests exercise both `listSpawnRecords()` and `loadSpawnRecord(id)`
  - Valid records load while the corrupt fixture is skipped with a warning
  - Profile-less records are accepted through the public reader API
  - Not-found load behavior is deterministic and non-throwing
  - Existing `src/brood/spawn-record.ts` behavior remains compatible

**PR Outcome**: `src/brood/spawn-index.ts` provides the US1 tolerant read API for per-spawn JSON records, with tests proving valid records load, corrupt in-flight reads are skipped after one retry and warning, profile-less records are accepted, missing ids do not throw, and the reader performs no disk or Docker mutation. The derived `SpawnView` and Docker-snapshot behavior remain for US2/US3.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Backing-store mechanism: Feature 1 as written reads per-spawn JSON under `~/.march/spawns/`, but the feature map's 2026-05 architecture note records Brood shipped as a SQLite registry at `~/.march/brood` behind `SessionRepository` (`src/brood/service/repository.ts` `list`/`get`, store at `src/brood/service/store.ts`). The spawn-handoff JSON record is now an intermediate artifact: Hatchery writes it (`src/hatchery/spawn-handoff.ts`) and immediately registers the session into the SQLite registry (`src/hatchery/service/brood-registration.ts`). A reader bound only to the JSON directory therefore sees handoff records, not the full set of sessions (stewards/legates, post-handoff lifecycle) tracked in the registry, so downstream Brood verbs could observe stale or partial state (raised as a P1 review concern on PR #387). The decomposition (the `SpawnView` / `derivedStatus` / `failureReason` API and tolerance guarantees) holds either way; whether the reader binds to the JSON directory, the registry, or both must be **resolved before forge** — note that US1's tolerance scenarios (corrupt-mid-write skip, profile-less acceptance) are JSON-file semantics that a registry binding would re-shape. | clarify:Mechanism vs. decomposition | High | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` derivation predicate is unpinned. The feature names the flag but not the precise set of conditions (e.g. `failed`, container-dead-while-running, stale) that set it. The view shape is fixed; the predicate is settled at task slicing. | Scope Within the Feature | Low | Medium | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Add Tolerant Spawn Record Reader | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: Derive the SpawnView Without Persisting New Status | depended upon by | US2 consumes the record-loading substrate from this story before adding non-persisted `SpawnView` flags. |
| User Story 3: Reconcile Container Liveness From a Caller Snapshot | depended upon by | US3 layers optional Docker-snapshot liveness reconciliation onto the derived view after US1 and US2 exist. |
| User Story 4: Surface Why a Spawn Failed | depended upon by | US4 verifies the already-landed `failureReason` write path through the reader produced by this story. |
