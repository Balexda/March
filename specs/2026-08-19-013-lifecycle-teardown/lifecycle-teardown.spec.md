# Feature Specification: Lifecycle Teardown

**Spec Folder**: `2026-08-19-013-lifecycle-teardown`
**Branch**: `feature/smithy/mark/march-orchestration-platform-m3-f3`
**Created**: 2026-08-19
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` - Feature 3: Lifecycle Teardown, with the source RFC `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`.
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/03-brood.features.md` - Feature 3: Lifecycle Teardown

## Clarifications

### Session 2026-08-19

- This feature hardens Brood's existing service-owned teardown surface: `march brood teardown <id>` remains a thin CLI client over Brood's teardown API, and ordered cleanup lives behind the Brood service.
- The 2026-05 architecture note supersedes the original standalone `src/spawn-disposal.ts` mechanism. The durable contract is service-owned lifecycle teardown over `SessionRecord`, `TeardownSubstrate`, and Castra steward removal.
- Teardown order is fixed: archive, container, steward, worktree, branch, terminal-state update. Worktree and branch cleanup use exact tracked identifiers and never invoke broad pruning.
- `--force` is required for `running` or `created` spawn teardown. The default forced container path should stop gracefully before removal; `--kill` is the explicit immediate-kill path. [Critical Assumption]
- Brood archives only the registry snapshot, container log snapshot when available, and the known structured extraction artifact. It does not recursively copy the worktree.
- A failed or unverified Castra steward removal defers worktree and branch removal and leaves the session retryable rather than marking it torn down over a possibly live steward.
- This spec cites `docs/vision.md` and `docs/operating-philosophy.md`: Brood removes cleanup and lifecycle intervention while still providing a deliberate CLI override surface. Teardown must be non-interactive, bounded, idempotent, and observable.

## Artifact Hierarchy

RFC -> Milestone -> Feature -> User Story -> Slice -> Tasks

## User Scenarios & Testing *(mandatory)*

### User Story 1: Request A Safe Teardown (Priority: P1)

As an operator, I want `march brood teardown <id>` to request cleanup for one tracked session so that I can reclaim runtime artifacts without manually inspecting Docker, Castra, git worktrees, or branches.

**Why this priority**: This is the operator-facing lifecycle verb promised by the RFC and the entry point that keeps cleanup inside Brood instead of distributed across manual commands.

**Independent Test**: Seed a Brood session group with spawn and steward records, invoke teardown through the CLI/API path, and verify the request reaches the service, returns ordered step results, and does not require interactive confirmation.

**Acceptance Scenarios**:

1. **Given** a stopped tracked spawn with a steward row, **When** the operator runs `march brood teardown <id>`, **Then** Brood returns a teardown result with archive, container, steward, worktree, and branch step outcomes.
2. **Given** a running or created spawn, **When** the operator runs teardown without `--force`, **Then** the command exits non-zero with a conflict response and no cleanup steps are executed.
3. **Given** a running or created spawn, **When** the operator runs teardown with `--force`, **Then** Brood proceeds without prompting for confirmation.
4. **Given** a session id is not tracked by Brood, **When** teardown is requested, **Then** the command exits non-zero with a deterministic not-found response.
5. **Given** a teardown request includes a reason, **When** Brood accepts the request, **Then** the reason is recorded as failure context on the session lifecycle record.

---

### User Story 2: Preserve Teardown Evidence (Priority: P1)

As an operator, I want teardown to archive the session record, container logs, and extracted structured output before deletion so that completed work remains inspectable after runtime artifacts are removed.

**Why this priority**: The RFC explicitly requires output preservation. Deleting runtime artifacts before preserving evidence would make teardown unsafe for autonomous cleanup.

**Independent Test**: Seed a stopped spawn with a container log source and extraction result, run teardown, and verify the archive contains `record.json`, `container.log`, and the known structured artifact while the full worktree is not recursively copied.

**Acceptance Scenarios**:

1. **Given** a tracked spawn exists, **When** teardown starts, **Then** Brood writes a registry snapshot to the archive before deleting any runtime artifact.
2. **Given** the tracked container still has logs, **When** teardown archives the session, **Then** Brood writes those logs to the archive.
3. **Given** the known structured extraction artifact exists, **When** teardown archives the session, **Then** Brood copies that artifact into the archive's artifact area.
4. **Given** the worktree contains unrelated files, **When** teardown archives the session, **Then** Brood does not recursively copy the worktree contents.
5. **Given** a log or artifact source is unavailable, **When** teardown continues, **Then** Brood records a warning and still attempts later cleanup steps.

---

### User Story 3: Reclaim Runtime Artifacts By Exact Identity (Priority: P1)

As an operator, I want Brood to remove containers, steward sessions, worktrees, and branches by their tracked identities so that cleanup is deterministic and cannot prune unrelated work.

**Why this priority**: Exact-path cleanup is the core safety constraint for Brood and directly addresses the orphaned-worktree failure mode called out in the feature map.

**Independent Test**: Seed adjacent worktrees and branches, run teardown for one tracked session, and verify only the tracked container/session/worktree/branch are targeted while unrelated artifacts remain.

**Acceptance Scenarios**:

1. **Given** a spawn has a tracked container id, **When** teardown reaches the container step, **Then** Brood targets only that spawn's compute artifact through the teardown substrate.
2. **Given** a steward shares the spawn worktree, **When** teardown reaches the steward step, **Then** Brood asks Castra to remove the steward without delegating worktree pruning to Castra.
3. **Given** a tracked worktree path exists, **When** teardown reaches the worktree step, **Then** Brood removes that exact path only.
4. **Given** a tracked branch exists, **When** teardown reaches the branch step, **Then** Brood deletes that exact branch only.
5. **Given** other worktrees or branches exist in the repository, **When** teardown completes, **Then** those unrelated artifacts remain untouched.

---

### User Story 4: Make Teardown Idempotent And Retryable (Priority: P2)

As an operator, I want repeated teardown requests to be safe so that retries after partial failures do not corrupt state or hide unfinished cleanup.

**Why this priority**: Autonomous cleanup must recover from partial failure without requiring the operator to reason through every intermediate state by hand.

**Independent Test**: Run teardown twice against an already torn-down session, and run teardown once with a simulated steward-removal failure followed by a successful retry; verify the second clean run is a no-op and the retry completes deferred steps.

**Acceptance Scenarios**:

1. **Given** a session is already torn down, **When** teardown is requested again, **Then** Brood returns success with no cleanup work.
2. **Given** the container is already gone, **When** teardown reaches the container step, **Then** the missing container is treated as a successful no-op or skipped outcome.
3. **Given** the worktree is already gone, **When** teardown reaches the worktree step, **Then** the missing path is treated as a skipped outcome.
4. **Given** Castra cannot verify steward removal, **When** teardown reaches the steward step, **Then** Brood defers worktree and branch removal and leaves the record retryable.
5. **Given** a later retry can verify steward absence or removal, **When** teardown runs again, **Then** Brood completes worktree and branch cleanup and marks the session group torn down.

---

### User Story 5: Observe Teardown Outcomes (Priority: P2)

As an operator debugging a stuck lifecycle, I want teardown spans, metrics, logs, and returned step outcomes to show where cleanup stopped so that a failed teardown has a concrete next diagnostic.

**Why this priority**: The repository's observability guidance says each lifecycle action and failure mode must be trace-visible. Teardown is destructive and must be diagnosable when partial.

**Independent Test**: Simulate successful, partial, and failed teardown outcomes and verify the returned step list, low-cardinality metrics, errored spans, and request error logs identify the failed or deferred step without per-session metric labels.

**Acceptance Scenarios**:

1. **Given** teardown succeeds, **When** the request completes, **Then** Brood emits a teardown span and success metric with low-cardinality labels.
2. **Given** any cleanup step fails, **When** the request completes, **Then** the teardown trace is errored and includes the failed step name and bounded diagnostic detail.
3. **Given** steward removal is unverified, **When** Brood defers later steps, **Then** the returned result and trace identify the steward failure and deferred worktree/branch steps.
4. **Given** teardown is invoked with inbound trace context, **When** Brood handles the request, **Then** service-side teardown work nests under the caller's trace instead of starting an unrelated root.
5. **Given** teardown emits metrics, **When** labels are recorded, **Then** they do not include concrete spawn ids, session ids, request paths, worktree paths, or branch names.

### Edge Cases

- Brood service is unreachable: the CLI exits non-zero and does not perform local cleanup directly.
- Teardown is requested for a steward id: Brood resolves the owning spawn group and applies the same cleanup contract.
- Teardown is requested for a legate row: Brood removes only artifacts that row owns and skips spawn/steward-only steps.
- Archive capture fails before cleanup: Brood records the archive failure and still attempts cleanup unless a later safety guard prevents it.
- Container log capture fails: teardown records a warning and continues; archive absence does not block artifact reclamation.
- The known extraction artifact is malformed or absent: teardown archives what is available, records a warning, and does not invent an output artifact.
- Worktree path or branch is missing from the registry: the corresponding cleanup step is skipped rather than guessed.
- Branch deletion fails because the branch is checked out elsewhere: teardown reports a failed branch step and warning without pruning other worktrees.
- Castra is reachable but reports no matching steward: absence is verified and teardown may continue.
- Castra is unreachable: absence is not verified, so worktree and branch cleanup are deferred.
- A teardown request races with another teardown request: outcomes remain idempotent and terminal state is not regressed.
- A running spawn receives `--kill`: immediate kill semantics are explicit and test-covered separately from graceful `--force`.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Request A Safe Teardown | — | — |
| US2 | Preserve Teardown Evidence | US1 | — |
| US3 | Reclaim Runtime Artifacts By Exact Identity | US1 | — |
| US4 | Make Teardown Idempotent And Retryable | US2, US3 | — |
| US5 | Observe Teardown Outcomes | US1 | — |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide `march brood teardown <id>` as an operator-facing CLI command over Brood's teardown API.
- **FR-002**: The CLI MUST NOT perform Docker, Castra, git worktree, branch, archive, or registry cleanup directly.
- **FR-003**: Brood MUST reject teardown of a `running` or `created` spawn unless the request includes `force`.
- **FR-004**: Forced teardown SHOULD stop the running container gracefully before removal unless the request includes `kill`.
- **FR-005**: `kill` MUST represent immediate kill semantics and MUST NOT be implied by ordinary `force`.
- **FR-006**: Teardown MUST execute cleanup in this logical order: archive, container, steward, worktree, branch, terminal-state update.
- **FR-007**: The archive step MUST run before deleting runtime artifacts.
- **FR-008**: The archive MUST include a registry snapshot at `record.json`.
- **FR-009**: The archive MUST include `container.log` when container logs are available.
- **FR-010**: The archive MUST include only the known structured extraction artifact when that artifact exists.
- **FR-011**: Teardown MUST NOT recursively copy the session worktree into the archive.
- **FR-012**: Container cleanup MUST target the tracked compute artifact through `TeardownSubstrate`.
- **FR-013**: Steward cleanup MUST ask Castra to remove the steward session and MUST request that Castra not prune the shared worktree.
- **FR-014**: If steward removal cannot be verified, Brood MUST defer worktree and branch removal and leave the session retryable.
- **FR-015**: Worktree cleanup MUST target the exact tracked worktree path and MUST NOT run broad worktree pruning.
- **FR-016**: Branch cleanup MUST target the exact tracked branch and MUST NOT infer or delete adjacent branches.
- **FR-017**: Teardown MUST be idempotent for already removed containers, already removed worktrees, already deleted branches, absent stewards, and already torn-down session records.
- **FR-018**: A successful teardown MUST mark the applicable session group torn down without deleting the registry record.
- **FR-019**: A partial or unverified teardown MUST surface warnings and step outcomes without pretending terminal cleanup succeeded.
- **FR-020**: The teardown response MUST include the session id, final status, ordered step outcomes, and warnings.
- **FR-021**: Teardown MUST record lifecycle telemetry: a service-side teardown span, child spans or step events for cleanup steps, errored span state for failed/deferred outcomes, and low-cardinality teardown metrics.
- **FR-022**: Teardown MUST preserve inbound trace context so service-side work nests under the caller's trace.
- **FR-023**: Teardown MUST NOT introduce interactive prompts or confirmation surfaces inside Brood.
- **FR-024**: This feature MUST NOT implement bulk teardown, archive retention or garbage collection, automatic teardown triggers, full-worktree archiving, PR/merge lifecycle behavior, or tmux attach.

### Key Entities

- **SessionRecord**: The service-owned lifecycle row for a spawn, steward, or legate session.
- **TeardownRequest**: The operator or automation request that carries `force`, `kill`, and an optional reason.
- **TeardownResult**: The ordered result returned after a teardown attempt, including final status, step outcomes, and warnings.
- **TeardownStep**: One cleanup step outcome in the ordered teardown contract.
- **TeardownSubstrate**: The swappable adapter Brood uses to reclaim compute and workspace artifacts.
- **TeardownArchive**: The preserved evidence directory for the session's record snapshot, container log snapshot, and known structured extraction artifact.
- **StewardRemovalResult**: The verified Castra removal outcome that decides whether worktree and branch cleanup may proceed.

## Assumptions

- F1's derived disposed state remains a read-view concern. This feature may mark registry rows `torndown`, but it does not add a persisted `disposed` status.
- The current Brood service implementation is the source of truth for this feature's shape. The original feature-map phrase `src/spawn-disposal.ts` is treated as superseded by the service-owned teardown module and `TeardownSubstrate`.
- The known structured extraction artifact is the validated spawn extraction result already tracked by Brood; future spawn features that add output paths must update this archive contract.
- Archive snapshots remain local files for this feature. Object storage, compression, continuous log capture, retention, and garbage collection are future work.
- `docs/vision.md` and `docs/operating-philosophy.md` govern the operator/automation trade-off: teardown is a deliberate command surface, while cleanup itself is non-interactive and produces clean terminal or retryable states.

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | The current host substrate's container removal helper may not expose Docker removal failures as failed step outcomes. The slice must decide whether to change the helper contract, wrap it with verification, or document host-substrate "attempted" semantics while preserving the post-condition check required by the feature map. | clarify:Non-Functional Quality | High | Medium | open | — |
| SD-002 | Exact archive layout for the known structured extraction artifact is not fully settled. The spec requires copying the single known structured artifact into an artifact area, but slice work must bind this to the persisted extraction-result path or encoded registry result without recursively copying the worktree. | clarify:Domain & Data Model | Medium | Medium | open | — |
| SD-003 | The current teardown implementation writes `torndownAt` inside the archive snapshot and updates registry state later. The slice must confirm whether the archived snapshot should capture pre-teardown state only, the intended terminal timestamp, or both. | clarify:Data Model | Medium | Medium | open | — |

## Out of Scope

- Bulk teardown such as `--all` or `--older-than`.
- Archive retention, archive garbage collection, compression, continuous log capture, or object-storage migration.
- Automatic teardown triggers from Herald or Legate.
- A persisted `disposed` status.
- Archiving full worktree contents.
- Spawn launch behavior, PR creation, merge lifecycle, and steward review logic.
- tmux attach and interactive session enumeration.
- A new runtime implementation outside Brood's service-owned lifecycle boundary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can run `march brood teardown <id>` for a stopped tracked spawn and receive ordered archive/container/steward/worktree/branch outcomes.
- **SC-002**: Teardown refuses `running` and `created` spawn cleanup without `--force`, and tests distinguish graceful `--force` from immediate `--kill`.
- **SC-003**: Archive tests prove `record.json`, `container.log` when available, and the known structured extraction artifact are preserved before cleanup, with no recursive worktree copy.
- **SC-004**: Exact-identity cleanup tests prove unrelated containers, Castra sessions, worktrees, and branches are not targeted.
- **SC-005**: Idempotency tests prove repeated teardown of already removed artifacts and already torn-down sessions is safe.
- **SC-006**: Steward-removal failure tests prove worktree and branch cleanup are deferred until Castra removal or absence is verified.
- **SC-007**: Teardown telemetry tests prove success, partial, and failed/deferred outcomes emit bounded spans, step diagnostics, and low-cardinality metrics.
- **SC-008**: The registry record remains present after teardown, allowing read surfaces to derive disposed state and inspect archived lifecycle evidence.
