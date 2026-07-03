# Tasks: Surface Why a Spawn Failed

**Source**: `specs/2026-06-13-011-brood-session-index/brood-session-index.spec.md` — User Story 4
**Data Model**: `specs/2026-06-13-011-brood-session-index/brood-session-index.data-model.md`
**Contracts**: `specs/2026-06-13-011-brood-session-index/brood-session-index.contracts.md`
**Story Number**: 04

---

## Slice 1: Verify Failure Reason Persistence Through the Reader
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Lock the already-landed `failureReason` write path into the Brood session-index contract by proving a failed record written through `markSpawnRecordFailed` is readable through `loadSpawnRecord(id)` without a schema-version bump or a required field migration.

**Justification**: US4's data-model surface is intentionally additive and mostly present in `src/brood/spawn-record.ts`; the remaining coherent increment is focused contract coverage across the writer and the US1 reader. This gives F2 `inspect` a stable source for failure context while avoiding new runtime behavior, new persisted status values, registry work, CLI output, or Docker interaction.

**Addresses**: FR-001, FR-009, FR-010, FR-012; Acceptance Scenarios 4.1-4.3

### Tasks

- [ ] **Cover failed-record reasons through the spawn index reader**

  Add focused coverage beside the Brood record/index tests that creates a spawn record, marks it failed with an error, reloads it through the session-index `loadSpawnRecord(id)` API, and asserts the persisted `failureReason` survives as optional record data. Keep any code changes limited to preserving the established `SpawnRecord` / `markSpawnRecordFailed` surface if the test exposes drift; do not add CLI presentation or a new persistence mechanism.

  _Acceptance criteria:_
  - A record marked failed with an `error` is reloaded through `loadSpawnRecord(id)` with that value in `failureReason`
  - The persisted record still has schema `version` 1 after `failureReason` is written
  - The raw `error` option key is not persisted as a record field
  - A record without `failureReason` still loads through `loadSpawnRecord(id)` with the field absent
  - No new required field, status enum value, Docker call, or disk mutation outside the existing failed-record write is introduced

**PR Outcome**: Brood's failure-context write path is contract-covered end to end: `markSpawnRecordFailed` persists the optional `failureReason`, `loadSpawnRecord(id)` returns it for downstream consumers, older records without the field still load, and the persisted schema version remains `1`.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Backing-store mechanism: Feature 1 as written reads per-spawn JSON under `~/.march/spawns/`, but the feature map's 2026-05 architecture note records Brood shipped as a SQLite registry at `~/.march/brood`. The decomposition (the `SpawnView` / `derivedStatus` / `failureReason` API and tolerance guarantees) holds either way; whether the reader binds to the JSON directory, the registry, or both is left to task slicing. | clarify:Mechanism vs. decomposition | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` derivation predicate is unpinned. The feature names the flag but not the precise set of conditions (e.g. `failed`, container-dead-while-running, stale) that set it. The view shape is fixed; the predicate is settled at task slicing. | Scope Within the Feature | Low | Medium | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Verify Failure Reason Persistence Through the Reader | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Read Spawn Records Tolerantly | depends on | US4 reloads failed records through the `loadSpawnRecord(id)` reader established by US1. |
