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
- `--force` is required for `running` or `created` spawn teardown. The default forced container path *should* stop gracefully before removal, with `--kill` as the explicit immediate-kill path. [Critical Assumption] This resolves the feature map's SD-001 **as a target contract only** — the shipped substrate takes no stop mode and always removes immediately, so the distinction is unimplementable until SD-004 is closed.
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
- Teardown is requested for a legate row: Brood removes the ephemeral container that row tracks and skips spawn/steward-only steps. A legate row MUST NOT reach `torndown` while its tracked container is unreclaimed (see FR-012a). The shared compose-managed `march-legate` service container is not session compute and is never a teardown target.
- The archive *sink* fails (directory cannot be created, or `record.json`, `container.log`, or the extraction artifact cannot be written — full or read-only filesystem): teardown ABORTS before any destructive step and leaves the session retryable. Destroying the container and worktree is what makes the evidence unrecoverable, so an unwritable sink is a stop condition, not a warning.
- An *optional archive source* is unavailable (container logs unreadable, extraction artifact absent): teardown records a warning and continues. Only the sink failure above is blocking. Readable logs that fail to write are a sink failure.
- The known extraction artifact is malformed or absent: teardown archives what is available, records a warning, and does not invent an output artifact.
- Worktree path or branch is missing from the registry: the corresponding cleanup step is skipped rather than guessed.
- Branch deletion fails because the branch is checked out elsewhere: teardown reports a failed branch step and warning without pruning other worktrees.
- Castra is reachable but reports no matching steward: absence is verified and teardown may continue.
- Castra is unreachable: absence is not verified, so worktree and branch cleanup are deferred.
- A teardown request races with another teardown request: outcomes remain idempotent and terminal state is not regressed.
- A cleanup call-out hangs (Docker daemon wedged, `git` blocked on a lock, Castra not responding): the step hits its deadline and returns a failed/deferred outcome. Teardown MUST reach a terminal or retryable state rather than blocking the service.
- A failed spawn is torn down with `--reason`: the teardown reason is recorded separately and MUST NOT overwrite the spawn's original `failureReason` diagnostic.
- A running spawn receives `--kill`: immediate kill semantics are explicit and test-covered separately from graceful `--force`. Until the substrate carries the stop mode (SD-004), both paths collapse to immediate removal — the slice MUST NOT claim graceful-stop coverage it does not have.

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| US1 | Request A Safe Teardown | — | specs/2026-08-19-013-lifecycle-teardown/01-request-a-safe-teardown.tasks.md |
| US2 | Preserve Teardown Evidence | US1 | specs/2026-08-19-013-lifecycle-teardown/02-preserve-teardown-evidence.tasks.md |
| US3 | Reclaim Runtime Artifacts By Exact Identity | US1, US2 | specs/2026-08-19-013-lifecycle-teardown/03-reclaim-runtime-artifacts-by-exact-identity.tasks.md |
| US4 | Make Teardown Idempotent And Retryable | US2, US3 | specs/2026-08-19-013-lifecycle-teardown/04-make-teardown-idempotent-and-retryable.tasks.md |
| US5 | Observe Teardown Outcomes | US1 | specs/2026-08-19-013-lifecycle-teardown/05-observe-teardown-outcomes.tasks.md |

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide `march brood teardown <id>` as an operator-facing CLI command over Brood's teardown API.
- **FR-002**: The CLI MUST NOT perform Docker, Castra, git worktree, branch, archive, or registry cleanup directly.
- **FR-003**: Brood MUST reject teardown of a `running` or `created` spawn unless the request includes `force`.
- **FR-003a**: The `force` requirement MUST survive retries. Brood MUST evaluate it against the spawn's preserved pre-teardown status, or against verified container liveness, not against the current registry status alone. A spawn left `tearing-down` by an aborted forced attempt (for example, an archive failure) whose container may still be running MUST still require `force` on retry. Today the guard reads only the live `status`, so a non-forced retry bypasses it (SD-009).
- **FR-004**: Forced teardown SHOULD stop the running container gracefully before removal unless the request includes `kill`. This is a **target contract, not current behavior**: the host substrate removes via `docker rm -f` (immediate SIGKILL) and `TeardownSubstrate.removeSpawn` has no mode parameter, so no graceful path exists today (SD-004).
- **FR-005**: `kill` MUST represent immediate kill semantics and MUST NOT be implied by ordinary `force`. Today `kill` is parsed at the route boundary and never read by the teardown routine — it is **accepted-but-ignored**. A slice MUST either implement the distinction end-to-end or reject `kill` as unsupported; it MUST NOT leave the flag silently inert.
- **FR-005a**: The teardown response MUST NOT report a graceful-stop outcome for a request that was executed as an immediate removal.
- **FR-006**: Teardown MUST execute cleanup in this logical order: archive, container, steward, worktree, branch, terminal-state update.
- **FR-006a**: Under the target graceful-stop path (FR-004), the container step splits around the archive so that output written during the stop is captured. The target sequence is: (1) gracefully stop the running container, skipped when the request includes `kill`; (2) archive `record.json`, `container.log`, and the known structured artifact; (3) remove the container and other runtime artifacts, only after the archive succeeds; then steward, worktree, branch, and terminal-state update. If the archive fails after the stop, the container MUST remain stopped but not removed, the session MUST stay in the retryable non-terminal `tearing-down` state, and every destructive step MUST be blocked. A retry re-runs the archive and MUST NOT require a running container. The archive's pre-stop preflight checks cannot guarantee that the post-stop writes succeed, so FR-007a applies to the post-stop archive.
- **FR-007**: The archive step MUST run before deleting runtime artifacts.
- **FR-007a**: Failure of the archive *sink* MUST abort teardown before any destructive step, return a failed `archive` outcome, and leave the session retryable in a non-terminal state. Every archive write is a sink write: archive directory creation and the writes of `record.json`, `container.log`, and the structured extraction artifact. Unavailability of an *optional source* (container logs unreadable, extraction artifact absent) MUST NOT block cleanup and is recorded as a warning. A source that was read successfully but could not be written is a sink failure, not a missing source. Today `container.log` write failures share a `try` with the log read, so they surface as a warning and container removal still runs (SD-010).
- **FR-008**: The archive MUST include a registry snapshot at `record.json`. It MUST capture **pre-teardown** state only — no `torndownAt` and no teardown-written fields — and MUST be written once: a retry MUST NOT overwrite an existing `record.json`. The preserved snapshot is the pre-teardown status FR-003a evaluates on retry.
- **FR-008a**: Every teardown attempt MUST be recorded in the archive's append-only `teardown.ndjson`: an `attempt-started` entry (attempt number, request `force`/`kill`/`reason`, `startedAt`) written immediately after `record.json`, and an `attempt-finished` entry (ordered steps, warnings, final `status`, `finishedAt`) written as the attempt's last action. A partial teardown is therefore explicitly partial in the record: its last finished entry carries a non-`torndown` status, or its last started entry has no finished entry (the attempt crashed or hit a deadline). Both entries are sink writes under FR-007a, except that a failed `attempt-finished` write after destructive steps already ran MUST be reported as a warning and leave the row `tearing-down` rather than being silently dropped.
- **FR-009**: The archive MUST include `container.log` when container logs are available.
- **FR-010**: The archive MUST include only the known structured extraction artifact when that artifact exists. That artifact is the registry's validated `extractionResult`, archived as `artifacts/extraction-result.json`; for a `succeeded` result Brood also writes `patch.patchText` to `artifacts/spawn.patch` and MUST verify it against `patch.sha256`. Both are sourced from the Brood registry, never from the worktree (TeardownArchive layout in the data model).
- **FR-011**: Teardown MUST NOT recursively copy the session worktree into the archive.
- **FR-012**: Container cleanup MUST target the tracked compute artifact through `TeardownSubstrate`.
- **FR-012b**: The host container removal helper MUST be extended to close its known failure-reporting gaps. Teardown's removal path MUST treat only "no such container" as idempotent success, MUST surface every other `docker rm` failure (daemon unreachable, permission denied, removal in progress, deadline breach) as a failed `container` step, and MUST verify the post-condition that no container with the spawn's derived name exists before reporting `ok`. A failed or unverified `container` step MUST leave the session retryable in `tearing-down`. The never-throws behaviour stays only on the dispatch rollback path, which keeps swallowing failures so it doesn't mask the original dispatch error.
- **FR-012a**: Every ephemeral per-session container MUST support teardown, whatever the session `kind` (`spawn`, `legate`, and any future kind that launches one). Teardown MUST reclaim it through the kind-agnostic `TeardownSubstrate` compute operations keyed by a `ComputeTarget`, not through a spawn-only path. Teardown MUST NOT refuse such a row, and MUST NOT record a skipped `container` step and still mark the row `torndown`, which leaks the container (SD-005). Long-lived compose-managed service containers (`march-legate`, Herald, Brood, Hatchery, Castra) are not session compute and MUST NOT be teardown targets.
- **FR-013**: Steward cleanup MUST ask Castra to remove the steward session and MUST request that Castra not prune the shared worktree.
- **FR-014**: If steward removal cannot be verified, Brood MUST defer worktree and branch removal and leave the session retryable.
- **FR-014a**: A deferred or partial teardown MUST be distinguishable from a completed one by a **single deterministic rule** that every CLI and automation consumer applies: terminal cleanup is signalled **only** by a response `status` of `torndown`. Any other status — `tearing-down` included — MUST be treated as not-yet-torn-down, and consumers MUST NOT infer completion from the HTTP status code alone. A consumer that drops session state on a non-`torndown` response is non-conformant.
- **FR-014b**: The legate MUST be fixed to apply FR-014a. `broodTeardown` (`src/legate/loop/clients/brood.ts`) MUST return `ok: true` only when the response `status` is `torndown`. A `tearing-down` (or any other non-terminal) response MUST return a distinct deferred result that keeps the session in loop state and is retried on a later tick. Every legate caller (`cleanup`, `ghost-cleanup`, `relaunch`) MUST keep the session until `ok`. Brood keeps returning `2xx` for deferred teardown; enforcement lives in the consumer, not in a new status code.
- **FR-015**: Worktree cleanup MUST target the exact tracked worktree path and MUST NOT run broad worktree pruning.
- **FR-016**: Branch cleanup MUST target the exact tracked branch and MUST NOT infer or delete adjacent branches.
- **FR-017**: Teardown MUST be idempotent for already removed containers, already removed worktrees, already deleted branches, absent stewards, and already torn-down session records.
- **FR-018**: A successful teardown MUST mark the applicable session group torn down without deleting the registry record.
- **FR-019**: A partial or unverified teardown MUST surface warnings and step outcomes without pretending terminal cleanup succeeded.
- **FR-020**: The teardown response MUST include the session id, final status, ordered step outcomes, and warnings.
- **FR-020a**: Every teardown call-out — archive I/O, container removal, Castra steward removal, worktree removal, branch deletion — MUST be bounded by an enforced server-side deadline, and MUST convert a deadline breach into a failed or deferred step outcome. Teardown MUST NOT block the Brood service on an unbounded synchronous call-out; the request MUST reach a terminal or retryable state regardless of a wedged Docker daemon, git lock, or unresponsive Castra.
- **FR-020b**: An operator-supplied teardown `reason` MUST be recorded without overwriting the session's pre-existing `failureReason` diagnostic. The reason for *cleanup* and the reason the session *failed* are distinct facts and MUST both survive teardown.
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
| SD-001 | The current host substrate's container removal helper (`removeSpawnContainer`) swallows every `docker rm -f` failure, so the `container` step always reports `ok` ("removal attempted"). | clarify:Non-Functional Quality | High | High | resolved | FR-012b: extend the helper. Teardown gets a verifying, failure-surfacing removal; the never-throws variant is kept only for dispatch rollback. |
| SD-002 | Exact archive layout for the known structured extraction artifact was not settled. | clarify:Domain & Data Model | Medium | High | resolved | FR-010 + data-model TeardownArchive layout: `artifacts/extraction-result.json` (validated registry `extractionResult`) plus `artifacts/spawn.patch` (sha256-verified `patchText`) for succeeded results, sourced from the registry, not the worktree. |
| SD-003 | The current teardown implementation writes `torndownAt` inside the archive snapshot before cleanup has run, so the snapshot mixes pre-teardown state with an unearned terminal timestamp, and nothing records individual attempts or their outcomes. | clarify:Data Model | Medium | High | resolved | FR-008 + FR-008a: `record.json` is a write-once pre-teardown snapshot; each attempt and its final result are appended to `teardown.ndjson`, so a partial teardown is visibly partial. |
| SD-004 | `TeardownSubstrate.removeSpawn(spawnId)` (target: `removeCompute`) takes no stop mode, and the host provider calls `docker rm -f` unconditionally, so FR-004/FR-005's graceful-vs-immediate distinction is unimplementable at the current boundary — `kill` is parsed at the route and never read. The contracts file now targets the split form: a separate `stopCompute` before the archive and `removeCompute` after it, because a single mode-carrying stop-and-remove call leaves no point at which to archive (FR-006a). The slice implements that split. Until then FR-004 is a target contract and `kill` is accepted-but-ignored. This supersedes the feature map's SD-001, which this spec had recorded as resolved on the strength of FR-004/FR-005 alone. | review:Contract-implementation drift | High | High | open | — |
| SD-005 | Compute cleanup was defined only for `spawn` rows (`removeSpawn(spawn.id)`), so a `legate` row with a tracked container could reach `torndown` while leaking its container. | review:Scope gap | High | High | resolved | FR-012a: every ephemeral per-session container supports teardown through kind-agnostic `stopCompute`/`removeCompute` keyed by `ComputeTarget`; shared compose service containers are never targets. |
| SD-006 | The legate seam (`src/legate/loop/clients/brood.ts`) returns `ok: true` for any HTTP 200 and drops the session from loop state, so a `tearing-down` response is read as confirmed cleanup. | review:Consumer contract | High | High | resolved | FR-014b: fix the legate. `broodTeardown` returns `ok` only on `status: torndown` and a distinct deferred result otherwise; legate callers keep the session until `ok`. Brood's deferred response stays `2xx`. |
| SD-007 | No teardown call-out is deadline-bounded. Container removal, log capture, and git worktree/branch operations use synchronous `execFileSync` without a `timeout` (only `docker wait` sets one), so a wedged daemon or git lock blocks Brood's event loop past the HTTP client's timeout and prevents terminal state. FR-020a requires enforced deadlines; the slice must set the concrete per-step values and decide whether synchronous call-outs move off the event loop. | review:Non-Functional Quality | High | High | open | — |
| SD-008 | Teardown writes the operator's `--reason` into `failureReason` on the registry row, overwriting the diagnostic explaining why the spawn failed (the archive snapshot is taken pre-update and retains the original, so the loss is confined to the live row the read surface shows). FR-020b requires both to survive; the slice must choose between a distinct `teardownReason` field and an append/compose convention. | review:Data Model | Medium | High | open | — |
| SD-009 | The force guard in `teardownSession` checks only the spawn's live `status`, but teardown sets that row to `tearing-down` before the archive step. A forced attempt that aborts (archive sink failure) therefore lets a later retry without `force` pass the guard while the container may still be running. FR-003a requires the guard to survive retries; the slice must choose between persisting the pre-teardown status and verifying container liveness through the substrate. | review:Functional Correctness | High | High | open | — |
| SD-010 | The shipped archive step reads container logs and writes `container.log` inside one `try`, which records any failure as a `container logs unavailable` warning while reporting the archive step `ok`. A write failure on readable logs therefore lets container removal destroy unarchived evidence. FR-007a classifies every archive write as a sink write; the slice must separate the source read from the sink write. | review:Data Integrity | High | High | open | — |

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
- **SC-002**: Teardown refuses `running` and `created` spawn cleanup without `--force`. Tests distinguish graceful `--force` from immediate `--kill` **once the substrate carries the stop mode**; until then the suite asserts the honest current behavior (both modes remove immediately) rather than a graceful path that does not exist.
- **SC-003**: Archive tests prove `record.json`, `container.log` when available, and the known structured extraction artifact are preserved before cleanup, with no recursive worktree copy.
- **SC-003b**: A teardown whose steward step fails, followed by a successful retry, leaves one unchanged pre-teardown `record.json` and a `teardown.ndjson` with two started/finished pairs — the first finishing `tearing-down`, the second `torndown`.
- **SC-003a**: A simulated unwritable archive sink (read-only or full filesystem) leaves the container, worktree, and branch intact and the session retryable — no destructive step runs.
- **SC-004**: Exact-identity cleanup tests prove unrelated containers, Castra sessions, worktrees, and branches are not targeted.
- **SC-005**: Idempotency tests prove repeated teardown of already removed artifacts and already torn-down sessions is safe.
- **SC-006**: Steward-removal failure tests prove worktree and branch cleanup are deferred until Castra removal or absence is verified.
- **SC-006a**: A deferred teardown is proven non-terminal at the consumer boundary: the legate seam and the CLI both report it as not-torn-down and retain session state, rather than reading HTTP 200 as confirmed cleanup. A legate test feeds `broodTeardown` a `200` with `status: tearing-down` and asserts the session survives the tick and is retried.
- **SC-006d**: Tearing down a `legate` row with a tracked ephemeral container removes that container and only then reaches `torndown`; a teardown request can never remove a shared compose service container.
- **SC-006b**: Each cleanup call-out is proven deadline-bounded — a stalled Docker, git, or Castra call yields a failed/deferred step within its deadline instead of hanging the service.
- **SC-006c**: Tearing down a `failed` spawn with `--reason` leaves the original `failureReason` readable through the Brood read surface and the archive snapshot.
- **SC-007**: Teardown telemetry tests prove success, partial, and failed/deferred outcomes emit bounded spans, step diagnostics, and low-cardinality metrics.
- **SC-008**: The registry record remains present after teardown, allowing read surfaces to derive disposed state and inspect archived lifecycle evidence.
