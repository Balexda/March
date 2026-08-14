# Feature Specification: Brood CLI Read Surface

**Spec Folder**: `2026-08-14-012-brood-cli-read-surface`
**Branch**: `feature/smithy/mark/march-orchestration-platform-m3-f2`
**Created**: 2026-08-14
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` - Feature 2: Brood CLI Read Surface, with the source RFC `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` - Feature 2: Brood CLI Read Surface

## Clarifications

### Session 2026-08-14

- This feature delivers the operator-facing read commands for Brood: `march brood list`, `march brood inspect <id>`, and `march brood logs <id>`.
- The 2026-05 architecture note in the feature map supersedes the original local-JSON mechanism. These commands are thin clients of the Brood service and read from the service-owned session registry. They do not parse registry files directly.
- The commands are read-only from the operator CLI surface. They do not register, update, tear down, prune, or delete sessions. `logs` may read Docker logs or an archived log, but it never mutates Docker state.
- `list` defaults to a cheap registry read with reconciliation off. `inspect` defaults to reconciled liveness because it is focused on one session. Both expose `--reconcile` and `--no-reconcile` so callers can choose accuracy or speed explicitly. [Critical Assumption]
- `logs` reads live container logs when the tracked container exists; after teardown, it falls back to the archived `container.log` captured by the teardown feature. Continuous log capture, compression, and retention policy are outside this feature.
- The read surface applies to Brood `SessionRecord` rows, not only legacy spawn JSON. Spawn rows remain the primary operator target for F2, while steward and legate rows are listed and inspected through the same read contract when present.
- This spec cites `docs/vision.md` and `docs/operating-philosophy.md`: Brood removes cleanup and lifecycle intervention, and these read commands are the deliberate CLI intervention surface that lets the operator inspect state without manually reconciling containers, worktrees, or raw registry rows.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: List Tracked Sessions (Priority: P1)

As an operator, I want `march brood list` to show the sessions Brood is tracking so that I can see active, completed, failed, and attention-worthy work without inspecting raw registry data.

**Why this priority**: Listing is the base visibility requirement for the RFC's concurrent-session tracking criterion and is the first command operators run when triaging the system.

**Independent Test**: Seed the Brood service with multiple session records, invoke `march brood list` in table and JSON modes with and without filters, and verify the command returns the expected rows without mutating service state or Docker state.

**Acceptance Scenarios**:

1. **Given** Brood tracks multiple sessions, **When** the operator runs `march brood list`, **Then** the command prints a table containing id, status, age, branch, container, and an attention marker for each matching row.
2. **Given** Brood tracks sessions in different statuses, **When** the operator runs `march brood list --status failed`, **Then** only matching status rows are returned.
3. **Given** Brood tracks sessions of multiple kinds, **When** the operator runs `march brood list --kind spawn`, **Then** only spawn rows are returned.
4. **Given** the operator runs `march brood list --json`, **When** records are returned, **Then** the command prints stable JSON suitable for scripts, including the same derived read fields as the table.
5. **Given** no sessions match the filter, **When** the operator runs `march brood list`, **Then** the command exits successfully with an empty-result presentation.

---

### User Story 2: Inspect One Session (Priority: P1)

As an operator, I want `march brood inspect <id>` to show the complete tracked session and derived read view so that I can understand why a session is failed, stalled, or disposed without querying multiple systems manually.

**Why this priority**: Inspect is the detail view for the same visibility promise as list. It must surface failure context and liveness accurately enough for the operator to decide whether teardown, retry, or escalation is appropriate.

**Independent Test**: Seed one session with branch, worktree, container, failure reason, and timestamps; invoke `march brood inspect <id>` in default and JSON modes; verify full record fields plus derived read fields are present, reconciliation defaults on, and a missing id returns a deterministic non-zero not-found error.

**Acceptance Scenarios**:

1. **Given** a tracked session id, **When** the operator runs `march brood inspect <id>`, **Then** the command prints the full session record plus derived fields including `needsAttention`, `disposed`, `containerLive`, and `failureReason` when present.
2. **Given** the operator runs `march brood inspect <id> --json`, **When** the session exists, **Then** the command prints a stable JSON object containing the complete record and derived read view.
3. **Given** a session has a failed status and failure reason, **When** it is inspected, **Then** the failure reason is visible without reading logs first.
4. **Given** the inspected session's tracked container is gone, **When** reconciliation is enabled, **Then** `containerLive` reflects the missing container without mutating the registry or Docker state.
5. **Given** the id is not tracked by Brood, **When** the operator runs `march brood inspect <id>`, **Then** the command exits non-zero with a deterministic not-found message.

---

### User Story 3: Read Live Or Archived Logs (Priority: P2)

As an operator, I want `march brood logs <id>` to read the relevant log stream for a tracked session so that I can debug a failed or completed session after its container is gone.

**Why this priority**: Logs are essential for diagnosis, but they depend on the tracked container/archive facts delivered by the listing and inspection views. The command remains read-only and does not own teardown or archival.

**Independent Test**: Seed a session with a live container log source and another with an archived `container.log`; invoke `march brood logs <id>` for both cases; verify live logs are read when available, archived logs are used after teardown, and missing logs produce a clear non-zero error.

**Acceptance Scenarios**:

1. **Given** a tracked session has a live container id, **When** the operator runs `march brood logs <id>`, **Then** the command streams or prints the output from the live container log source.
2. **Given** the tracked container has been removed and an archived `container.log` exists, **When** the operator runs `march brood logs <id>`, **Then** the command prints the archived log.
3. **Given** neither live container logs nor an archived log are available, **When** the operator runs `march brood logs <id>`, **Then** the command exits non-zero with a clear message that logs are unavailable.
4. **Given** the operator asks for logs of an untracked id, **When** the command runs, **Then** it exits non-zero with a deterministic not-found message.
5. **Given** logs are read from Docker or the archive, **When** the command completes, **Then** no registry, archive, Docker, worktree, or branch state is mutated.

### Edge Cases

- Brood service is unreachable: every read command exits non-zero with the client error and does not fall back to raw registry parsing or local pruning.
- A status or kind filter is invalid: the command rejects the filter as usage error rather than silently returning an unfiltered list.
- `--reconcile` is requested for list: the command may perform liveness observation for rows, but it still must not update registry or Docker state.
- `--no-reconcile` is requested for inspect: the command uses registry facts only and marks the view as unreconciled.
- A session has no branch or no container id: table and JSON output keep stable fields and use empty/null values rather than shifting columns.
- A session is already torn down: `disposed` is derived true, the persisted status remains Brood's lifecycle status, and logs fall back to the archive when present.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | List Tracked Sessions | — | — |
| US2 | Inspect One Session | US1 | — |
| US3 | Read Live Or Archived Logs | US1, US2 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide `march brood list` as a read-only CLI command over the Brood service's tracked sessions.
- **FR-002**: `march brood list` MUST support table output with id, status, age, branch, container, and attention marker columns.
- **FR-003**: `march brood list --json` MUST output stable JSON containing the same matching rows and derived read fields as table mode.
- **FR-004**: `march brood list` MUST support `--status <status>` filtering.
- **FR-005**: `march brood list` MUST support `--kind <kind>` filtering for tracked session kinds.
- **FR-006**: The list command MUST support `--reconcile` and `--no-reconcile`, defaulting to no reconciliation.
- **FR-007**: The system MUST provide `march brood inspect <id>` as a read-only CLI command for one tracked session.
- **FR-008**: `march brood inspect <id>` MUST print the full tracked session record plus derived read fields.
- **FR-009**: `march brood inspect <id>` MUST surface `failureReason` when present.
- **FR-010**: `march brood inspect <id>` MUST support JSON output.
- **FR-011**: The inspect command MUST support `--reconcile` and `--no-reconcile`, defaulting to reconciliation.
- **FR-012**: The derived read fields MUST include `needsAttention`, `disposed`, `containerLive`, and whether the view was reconciled.
- **FR-013**: The system MUST provide `march brood logs <id>` as a read-only CLI command for a tracked session's logs.
- **FR-014**: `march brood logs <id>` MUST read live container logs when the tracked container exists.
- **FR-015**: `march brood logs <id>` MUST fall back to the archived teardown log when the live container is unavailable and the archive exists.
- **FR-016**: All three read commands MUST fail clearly on an unreachable Brood service and MUST NOT silently fall back to direct local registry parsing.
- **FR-017**: All three read commands MUST NOT register, update, tear down, delete, prune, or otherwise mutate Brood registry, Docker, worktree, branch, or archive state.
- **FR-018**: This feature MUST NOT implement teardown, archive capture, bulk cleanup, watch/follow mode, tmux attach, Hatchery profile editing, Herald event subscription, or spawn launch behavior.

### Key Entities

- **SessionRecord**: The service-owned tracked lifecycle record for a spawn, steward, or legate session.
- **BroodReadView**: A derived, non-persisted view over a SessionRecord used by list and inspect presentations.
- **LogReadSource**: The selected read-only source for `logs`: live container logs or archived teardown log.
- **Reconciliation Mode**: The per-command choice that controls whether liveness evidence is observed during read presentation.

## Assumptions

- F1's reader/derived-view guarantees have landed and are available to Brood's service-backed read surface, even if the backing mechanism is the SQLite session registry rather than legacy spawn JSON.
- `march brood list` and `march brood inspect` are operator-facing CLI clients over the Brood service, not autonomous components that prompt for input. This follows `docs/vision.md` and `docs/operating-philosophy.md`: the CLI is the deliberate intervention surface, while Brood owns lifecycle state and cleanup.
- Reconciliation is observational only. It may read liveness evidence but does not repair, update, or tear down anything during F2 reads.
- `logs` depends on F3 to create the archived teardown `container.log`. Before F3 lands, archive fallback may be specified and tested with fixtures, but production fallback only works once teardown writes the archive.
- Archived logs are uncompressed snapshot files for this feature. Continuous capture, compression, and retention/GC policy are future work.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | Archive availability sequencing: F2 specifies fallback to F3's archived `container.log`, but F3 is a separate feature. The F2 implementation must either land after the archive path exists or ship the fallback path with fixture coverage and a clear unavailable-log error until F3 writes real archives. | clarify:Integration | Medium | Medium | open | — |
| SD-002 | Exact `needsAttention` predicate is inherited from F1's open debt. This feature requires the marker to exist in list/inspect output, but the final predicate set is owned by the derived-view contract F1 exposes. | clarify:Domain & Data Model | Medium | Medium | open | — |

## Out of Scope

- Any write or mutation verb, including teardown and archive creation.
- Launching spawns or registering sessions.
- tmux attach and interactive session enumeration.
- Hatchery profile editing.
- Herald watch/follow/event subscription behavior.
- Bulk filtering beyond status/kind.
- Continuous log capture, log compression, and archive retention policy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can run `march brood list` and see every matching tracked session with status, age, branch, container, and attention-marker information.
- **SC-002**: `march brood list --json`, `march brood inspect <id> --json`, and their table/human modes produce stable, test-covered output shapes.
- **SC-003**: `march brood inspect <id>` shows the complete record plus derived read fields and `failureReason` when present.
- **SC-004**: `march brood logs <id>` reads live logs when available and the archived teardown log when the live container is gone.
- **SC-005**: Reconciliation defaults are test-covered: list defaults off, inspect defaults on, and both commands honor explicit `--reconcile` / `--no-reconcile`.
- **SC-006**: Tests prove all three commands are read-only: they do not mutate Brood registry, Docker, worktree, branch, or archive state.
