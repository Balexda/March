# Tasks: Derive the SpawnView Without Persisting New Status

**Source**: `specs/2026-06-13-011-brood-session-index/brood-session-index.spec.md` — User Story 2
**Data Model**: `specs/2026-06-13-011-brood-session-index/brood-session-index.data-model.md`
**Contracts**: `specs/2026-06-13-011-brood-session-index/brood-session-index.contracts.md`
**Story Number**: 02

---

## Slice 1: Add Non-Persisted SpawnView Derivation
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Deliver the US2-owned `SpawnView` shape and `derivedStatus(record)` behavior in `src/brood/spawn-index.ts` so callers can distinguish attention, disposal, and inferred container liveness without adding persisted status values.

**Justification**: This is a complete derived-view increment over the US1 reader: downstream callers can derive operator-facing flags from an already-loaded record, tests can prove no disk mutation occurs, and the persisted `SpawnStatus` contract remains unchanged. It deliberately leaves caller-supplied Docker snapshot reconciliation to US3 and does not add CLI, teardown, or write-path behavior.

**Addresses**: FR-001, FR-002, FR-005, FR-007, FR-008, FR-012; Acceptance Scenarios 2.1-2.4

### Tasks

- [ ] **Add the derived SpawnView API**

  Extend `src/brood/spawn-index.ts` with the `SpawnView` type and derived-view export described by the contracts, with focused coverage beside `src/brood/spawn-index.test.ts`. Compute US2-owned flags from the supplied `SpawnRecord`: `failed` records need attention, disposed records are represented only in the view, and container liveness is inferred from persisted record state until US3 supplies snapshots.

  _Acceptance criteria:_
  - `derivedStatus(record)` returns the original record plus all US2 view flags
  - `needsAttention` is true for `failed` records and false for non-attention statuses
  - `created`, `running`, `stopped`, and `failed` persisted statuses are covered
  - A runtime-artifact absence condition is exposed only on `SpawnView`
  - `containerLive` is inferred without shelling out to Docker
  - On-disk records remain byte-for-byte free of derived status values after derivation
  - No `"needs-attention"` or `"disposed"` value is added to `SpawnStatus`

**PR Outcome**: `src/brood/spawn-index.ts` exposes the US2 `SpawnView` derivation API, with tests proving attention, disposal, and inferred liveness flags are computed without Docker calls, without disk mutation, and without expanding the persisted `SpawnStatus` enum. Docker-snapshot reconciliation remains for US3.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Backing-store mechanism: Feature 1 as written reads per-spawn JSON under `~/.march/spawns/`, but the feature map's 2026-05 architecture note records Brood shipped as a SQLite registry at `~/.march/brood`. The decomposition (the `SpawnView` / `derivedStatus` / `failureReason` API and tolerance guarantees) holds either way; whether the reader binds to the JSON directory, the registry, or both is left to task slicing. | clarify:Mechanism vs. decomposition | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` derivation predicate is unpinned. The feature names the flag but not the precise set of conditions (e.g. `failed`, container-dead-while-running, stale) that set it. The view shape is fixed; the predicate is settled at task slicing. | Scope Within the Feature | Low | Medium | resolved | Resolved 2026-07-02 — US2 derives `needsAttention` from persisted `failed` records; snapshot-driven dead-container attention remains in US3. |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Add Non-Persisted SpawnView Derivation | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Read Spawn Records Tolerantly | depends on | US2 extends the `src/brood/spawn-index.ts` module and consumes records loaded by the US1 reader. |
| User Story 3: Reconcile Container Liveness From a Caller Snapshot | depended upon by | US3 layers caller-supplied Docker snapshot reconciliation onto the derived view after US2 establishes the non-persisted flags. |
| User Story 4: Surface Why a Spawn Failed | depended upon by | US4 can later surface `failureReason` through consumers of the same derived view without changing US2's persistence rules. |
