# Tasks: Reconcile Container Liveness From a Caller Snapshot

**Source**: `specs/2026-06-13-011-brood-session-index/brood-session-index.spec.md` — User Story 3
**Data Model**: `specs/2026-06-13-011-brood-session-index/brood-session-index.data-model.md`
**Contracts**: `specs/2026-06-13-011-brood-session-index/brood-session-index.contracts.md`
**Story Number**: 03

---

## Slice 1: Reconcile SpawnView Liveness From Caller Snapshot
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Complete `derivedStatus(record, dockerSnapshot?)` by consulting the optional caller-supplied Docker snapshot for container liveness while preserving the pure record-only behavior when no snapshot is supplied.

**Justification**: This is the coherent US3 increment over the US1 reader and US2 derived view: callers that already have a Docker observation can make `containerLive` reflect reality without forcing `derivedStatus(record)` or `listSpawnRecords()` to shell out, mutate records, or touch Docker state. It does not add CLI presentation, teardown, registry work, or new persisted status values.

**Addresses**: FR-001, FR-002, FR-006, FR-007, FR-011, FR-012; Acceptance Scenarios 3.1-3.3

### Tasks

- [ ] **Honor optional Docker snapshots in SpawnView derivation**

  Extend `src/brood/spawn-index.ts` and its focused tests so `derivedStatus(record, dockerSnapshot?)` uses a supplied snapshot to derive `containerLive`, while the no-snapshot path keeps using only the persisted record as established by US2. Treat the snapshot as read-only caller evidence: it can report an absent container or a present container with known running state, but derivation must not persist a derived value, mutate Docker, or introduce a required Docker call.

  _Acceptance criteria:_
  - A `running` record derived with a snapshot reporting the container absent returns a `SpawnView` with `containerLive: false`
  - A snapshot reporting a present, running container returns `containerLive: true` for the derived view
  - A snapshot reporting a present, non-running container returns `containerLive: false` for the derived view
  - Calling `derivedStatus(record)` with no snapshot continues to infer liveness from the persisted record alone
  - Derivation does not mutate the record JSON or Docker state and does not persist `"needs-attention"` or `"disposed"` status values
  - `listSpawnRecords()` and `loadSpawnRecord(id)` remain pure readers and do not gain Docker behavior

**PR Outcome**: `derivedStatus(record, dockerSnapshot?)` reconciles `containerLive` from caller-supplied Docker evidence when present and keeps the no-snapshot path cheap and pure. Tests prove absent, running, and non-running snapshots affect only the derived view, with no disk mutation, Docker mutation, or expansion of persisted `SpawnStatus`.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Backing-store mechanism: Feature 1 as written reads per-spawn JSON under `~/.march/spawns/`, but the feature map's 2026-05 architecture note records Brood shipped as a SQLite registry at `~/.march/brood`. The decomposition (the `SpawnView` / `derivedStatus` / `failureReason` API and tolerance guarantees) holds either way; whether the reader binds to the JSON directory, the registry, or both is left to task slicing. | clarify:Mechanism vs. decomposition | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` derivation predicate is unpinned. US2 resolved the record-only predicate to persisted `failed` records; this story does not broaden the predicate because the US3 contract assigns caller-supplied Docker evidence to `containerLive` reconciliation only. | Scope Within the Feature | Low | Medium | resolved | Resolved 2026-07-05 — US3 uses snapshots only for `containerLive`; attention remains the US2 persisted-status predicate. |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Reconcile SpawnView Liveness From Caller Snapshot | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Read Spawn Records Tolerantly | depends on | US3 consumes the `src/brood/spawn-index.ts` module and record-loading substrate from US1. |
| User Story 2: Derive the SpawnView Without Persisting New Status | depends on | US3 completes the already-shaped `derivedStatus(record, dockerSnapshot?)` API by reconciling the optional snapshot. |
| User Story 4: Surface Why a Spawn Failed | depended upon by | US4 can rely on the same derived view surface without changing US3's Docker-snapshot scope. |
