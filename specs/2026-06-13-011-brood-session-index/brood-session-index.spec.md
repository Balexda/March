# Feature Specification: Brood Session Index

**Spec Folder**: `2026-06-13-011-brood-session-index`
**Branch**: `feature/smithy/mark/march-orchestration-platform-m3-f1`
**Created**: 2026-06-13
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` — Feature 1: Brood Session Index, with the source RFC `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` — Feature 1: Brood Session Index

## Clarifications

### Session 2026-06-13

- This feature is the **read-and-derive substrate** Feature 1 of the Brood (Basic) milestone: a new `src/brood-index.ts` module that exposes `listSpawnRecords()`, `loadSpawnRecord(id)`, and `derivedStatus(record, dockerSnapshot?)` over the per-spawn JSON files M1 already writes to `~/.march/spawns/`. It is a pure read layer — it never mutates disk and never mutates Docker state.
- The persisted `SpawnStatus` enum stays exactly `"created" | "running" | "stopped" | "failed"`. The `needsAttention` and `disposed` conditions are **derived** in the `SpawnView` and are **never** written to disk as new status values.
- F1's data-model contribution — the optional `failureReason?: string` field on `SpawnRecord` and the wiring of `markSpawnRecordFailed`'s `error` argument into it — has **already landed** in `src/brood/spawn-record.ts` (forward-compatible; the schema `version` stays `1`, no bump). This spec records it as part of F1's contract surface so downstream slicing treats it as **satisfied**, not net-new work; the genuinely-unbuilt part of F1 is the reader/derive layer (`brood-index.ts`, `listSpawnRecords` / `loadSpawnRecord` / `derivedStatus`, `SpawnView`).
- Docker liveness reconciliation is a **caller-controlled** sub-capability: the caller may pass a `docker inspect` snapshot into `derivedStatus` / view derivation, and the module reconciles `containerLive` from it. When no snapshot is supplied, derivation uses the persisted record alone. The module itself never shells out to Docker as a required step.
- The reader is tolerant by construction: a **safe-read protocol** (one retry on JSON parse failure, then skip-and-warn) guarantees a concurrent dispatch write cannot fail a `list`, and the reader accepts records both with and without an M2-era `profile` field.
- **Architecture-note supersession (2026-05).** The feature map records that Brood has since shipped as a containerized Fastify service whose session state lives in a SQLite registry at `~/.march/brood` behind a swappable `SessionRepository`, rather than a read-and-derive layer over per-spawn JSON. The feature map states the *decomposition still holds* and the F1–F6 descriptions are read with that mechanism correction. This spec marks Feature 1 **as decomposed** — the `SpawnView` / `derivedStatus` / `failureReason` API surface and tolerance guarantees are the load-bearing deliverable; whether the backing store is the JSON directory or the registry is a mechanism the implementation may reconcile (see SD-001). [Critical Assumption]

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Read Spawn Records Tolerantly (Priority: P1)

As a Brood verb author, I want one tolerant reader over the per-spawn records so that every downstream verb (`list`, `inspect`, `logs`, `teardown`, `attach`) loads spawn state through a single well-defined API instead of re-parsing JSON each time.

**Why this priority**: The reader is the foundation every other Brood feature consumes. Without a tolerant `listSpawnRecords()` / `loadSpawnRecord(id)`, a concurrent dispatch write or a schema-skewed record would break `list` and strand the whole verb surface.

**Independent Test**: Seed `~/.march/spawns/` with several record JSON files — including one mid-write/corrupt file and one without an M2-era `profile` field — then call `listSpawnRecords()` and `loadSpawnRecord(id)` and verify the valid records load, the unreadable one is skipped with a warning rather than failing the call, and the profile-less record is accepted.

**Acceptance Scenarios**:

1. **Given** a `~/.march/spawns/` directory with valid record files, **When** `listSpawnRecords()` is called, **Then** every valid record is returned and disk is not mutated.
2. **Given** a record file that fails JSON parse on first read (a concurrent dispatch write in progress), **When** the reader encounters it, **Then** it retries once and, if still unparseable, skips it with a warning rather than throwing.
3. **Given** a record written before the M2-era `profile` field existed, **When** it is read, **Then** it loads successfully without the `profile` field.
4. **Given** a known spawn id, **When** `loadSpawnRecord(id)` is called, **Then** the single record is returned, and a missing id yields a deterministic not-found result rather than a thrown parse error.

---

### User Story 2: Derive the SpawnView Without Persisting New Status (Priority: P1)

As an operator-facing verb, I want a derived view that tells me whether a spawn needs attention, is disposed, or has a live container so that I can surface those conditions without the persisted status enum ever growing new values.

**Why this priority**: Derived conditions (`needsAttention`, `disposed`, `containerLive`) are what make `list`/`inspect` legible, but persisting them would corrupt the durable `SpawnStatus` contract M1 owns. The derivation must be computed, never stored.

**Independent Test**: Construct records in each persisted status, call `derivedStatus(record)` to obtain the `SpawnView`, and verify `needsAttention` / `disposed` / `containerLive` are computed correctly; then re-read the on-disk record and confirm no derived value was written back and the persisted `SpawnStatus` is still one of the four canonical values.

**Acceptance Scenarios**:

1. **Given** a persisted record, **When** its `SpawnView` is derived, **Then** the view exposes `needsAttention`, `disposed`, and `containerLive` flags and the persisted `SpawnStatus` remains one of `"created" | "running" | "stopped" | "failed"`.
2. **Given** a record whose JSON is present but whose container and worktree are gone, **When** the view is derived, **Then** `disposed` is `true` while the persisted status is unchanged on disk.
3. **Given** a `failed` record, **When** the view is derived, **Then** `needsAttention` reflects the attention-worthy condition without `"needs-attention"` ever being written to disk.
4. **Given** view derivation runs, **When** it completes, **Then** no `"needs-attention"` or `"disposed"` value is ever persisted to the record JSON.

---

### User Story 3: Reconcile Container Liveness From a Caller Snapshot (Priority: P2)

As a verb that wants accurate liveness, I want to optionally pass a `docker inspect` snapshot into derivation so that `containerLive` reflects reality, while the reader stays pure when I do not supply one.

**Why this priority**: Liveness drifts from the persisted status when a container dies out of band. Optional reconciliation makes `inspect` accurate without forcing every `list` to shell out to Docker — keeping the default read cheap and pure.

**Independent Test**: Call `derivedStatus(record, dockerSnapshot)` with a snapshot reporting the container absent and verify `containerLive` is `false`; call it again with no snapshot and verify derivation falls back to the persisted record with no Docker call made.

**Acceptance Scenarios**:

1. **Given** a record with status `running` and a snapshot reporting the container gone, **When** `derivedStatus(record, snapshot)` runs, **Then** `containerLive` is `false` and the result reflects the reconciled liveness.
2. **Given** no snapshot is passed, **When** `derivedStatus(record)` runs, **Then** derivation uses the persisted record alone and the module makes no Docker call.
3. **Given** reconciliation runs, **When** it completes, **Then** it does not mutate the persisted record or Docker state.

---

### User Story 4: Surface Why a Spawn Failed (Priority: P2)

As an operator, I want the failure reason carried on the record so that `inspect` can eventually show *why* a spawn failed instead of a bare `failed` status.

**Why this priority**: The `error` passed to `markSpawnRecordFailed` is dropped today; capturing it is the data-model precondition for legible failure diagnosis in F2's `inspect`. It is forward-compatible and low-risk, hence P2 alongside the core reader/derivation.

**Independent Test**: Call `markSpawnRecordFailed` with an `error`, reload the record via `loadSpawnRecord`, and verify `failureReason` is persisted; verify the schema `version` is unchanged and a record without `failureReason` still loads.

**Acceptance Scenarios**:

1. **Given** a spawn is marked failed with an `error`, **When** the record is persisted, **Then** `failureReason` holds that error string on disk.
2. **Given** the `failureReason` field is added, **When** the schema is inspected, **Then** the persisted `version` is still `1` (no bump) and the field is optional.
3. **Given** an older record without `failureReason`, **When** it is read, **Then** it loads successfully with `failureReason` absent.

### Edge Cases

- A record file is mid-write when `listSpawnRecords()` reads it: the safe-read protocol retries once, then skips-and-warns so `list` never fails.
- A record predates the M2-era `profile` field: it loads without `profile`.
- `derivedStatus` is called with no Docker snapshot: derivation uses the persisted record alone and makes no Docker call.
- A spawn's JSON is present but its container and worktree are gone: `disposed` is derived `true` without persisting a `"disposed"` status (the F3 teardown path leaves the JSON in place by design).
- A record is in a persisted status that is attention-worthy: `needsAttention` is derived without writing `"needs-attention"` to disk.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Read Spawn Records Tolerantly | — | — |
| US2 | Derive the SpawnView Without Persisting New Status | US1 | — |
| US3 | Reconcile Container Liveness From a Caller Snapshot | US1, US2 | — |
| US4 | Surface Why a Spawn Failed | US1 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A new `src/brood-index.ts` module MUST expose `listSpawnRecords()`, `loadSpawnRecord(id)`, and `derivedStatus(record, dockerSnapshot?)`.
- **FR-002**: The reader MUST read the per-spawn record JSON M1 writes to `~/.march/spawns/`, and MUST NOT mutate disk state or Docker state (pure read-and-derive).
- **FR-003**: The reader MUST apply a safe-read protocol — one retry on JSON parse failure, then skip-and-warn — so a concurrent dispatch write cannot fail a `list`.
- **FR-004**: The reader MUST tolerate records both with and without an M2-era `profile` field.
- **FR-005**: The feature MUST define a `SpawnView` derived-view type exposing `needsAttention`, `disposed`, and `containerLive`, computed from the persisted record.
- **FR-006**: `derivedStatus` MUST accept an optional `docker inspect` snapshot and, when supplied, reconcile `containerLive` from it; when omitted, derivation MUST use the persisted record alone and make no Docker call.
- **FR-007**: The persisted `SpawnStatus` enum MUST remain exactly `"created" | "running" | "stopped" | "failed"`; `"needs-attention"` and `"disposed"` MUST be derived only and MUST NEVER be written to disk.
- **FR-008**: The `disposed` condition MUST be derived from the record state (JSON present, container/worktree absent) rather than read from a persisted status value.
- **FR-009**: `SpawnRecord` MUST carry an optional, forward-compatible `failureReason?: string` field with NO schema `version` bump (`version` stays `1`). *(Already satisfied in `src/brood/spawn-record.ts`; recorded here as part of F1's contract surface.)*
- **FR-010**: `markSpawnRecordFailed` MUST persist its `error` argument into the `failureReason` field. *(Already satisfied in `src/brood/spawn-record.ts`.)*
- **FR-011**: Docker-inspect-driven liveness reconciliation MUST be a caller-controlled sub-capability — the caller passes the snapshot in — and MUST NOT be a required Docker call inside the module.
- **FR-012**: This feature MUST NOT change the persisted `SpawnStatus` enum values, bump the schema `version`, add a `profile` field (M2 F5), or implement the CLI surface (F2), teardown logic (F3), concurrent-dispatch audit (F4), tmux integration (F5), or skill content (F6).

### Key Entities

- **SpawnRecord (extended)**: The persisted per-spawn JSON M1 writes to `~/.march/spawns/<id>.json`, gaining one optional `failureReason?: string` field; `version` and the `SpawnStatus` enum are unchanged.
- **SpawnView**: A derived, non-persisted view over a SpawnRecord exposing `needsAttention`, `disposed`, and `containerLive` — realized by `derivedStatus` plus the view's flag fields, not stored on disk.
- **Docker Snapshot**: An optional, caller-supplied `docker inspect` result passed into derivation to reconcile `containerLive`; absent it, derivation uses the record alone.
- **Spawn Index Reader**: The `src/brood-index.ts` module surface (`listSpawnRecords` / `loadSpawnRecord` / `derivedStatus`) with the safe-read protocol and profile-tolerance.

## Assumptions

- M1's per-spawn record JSON under `~/.march/spawns/` and `src/brood/spawn-record.ts` (including `MarkSpawnRecordFailedOptions` and its `error` slot, already wired to `failureReason`) are present and remain the data source the new reader/derive layer builds over.
- The M2-era `profile` field is owned by M2 F5; this feature only tolerates its presence or absence and does not add it.
- The downstream CLI read surface (F2), teardown (F3), concurrent-dispatch audit (F4), tmux attach (F5), and skills (F6) consume this API but are out of scope here.
- Per the feature map's architecture note, Brood may realize this API over the SQLite registry rather than the JSON directory; the `SpawnView` / `derivedStatus` / `failureReason` contract is what this feature pins, and the backing-store mechanism is reconciled at task slicing (SD-001).
- This feature supports `docs/operating-philosophy.md` by giving cleanup/lifecycle verbs one tolerant read API so operators are not pulled into reconciling raw record files.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Backing-store mechanism: Feature 1 as written reads per-spawn JSON under `~/.march/spawns/`, but the feature map's 2026-05 architecture note records Brood shipped as a SQLite registry at `~/.march/brood`. The decomposition (the `SpawnView` / `derivedStatus` / `failureReason` API and tolerance guarantees) holds either way; whether the reader binds to the JSON directory, the registry, or both is left to task slicing. | clarify:Mechanism vs. decomposition | Medium | Medium | open | — |
| SD-002 | Exact `needsAttention` derivation predicate is unpinned. The feature names the flag but not the precise set of conditions (e.g. `failed`, container-dead-while-running, stale) that set it. The view shape is fixed; the predicate is settled at task slicing. | Scope Within the Feature | Low | Medium | open | — |

## Out of Scope

- Any change to the persisted `SpawnStatus` enum (no `needs-attention` or `disposed` values) or a schema `version` bump.
- The Brood CLI read surface — `list` / `inspect` / `logs` (Feature 2).
- Lifecycle teardown and archival (Feature 3).
- The concurrent dispatch audit (Feature 4).
- tmux / interactive attach (Feature 5) and Brood skills (Feature 6).
- Adding a `profile` field to `SpawnRecord` (M2 F5).
- Mutating Docker state or shelling out to Docker as a required step.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every downstream Brood verb can read spawn state through one API — `listSpawnRecords()` / `loadSpawnRecord(id)` / `derivedStatus(record, dockerSnapshot?)` — without re-parsing record JSON itself.
- **SC-002**: A concurrent dispatch write to a record file never fails a `list`; the unreadable record is skipped-and-warned after one retry.
- **SC-003**: The persisted `SpawnStatus` enum and schema `version` are unchanged, and no derived `needs-attention` / `disposed` value is ever written to disk.
- **SC-004**: An operator can recover *why* a spawn failed from the persisted `failureReason`, captured from the `error` passed to `markSpawnRecordFailed`.
- **SC-005**: `derivedStatus` reconciles `containerLive` from a caller-supplied Docker snapshot when given one, and stays pure (no Docker call, no mutation) when not.
