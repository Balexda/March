# Tasks: Read Live Or Archived Logs

**Source**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.spec.md` — User Story 3
**Data Model**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.data-model.md`
**Contracts**: `specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.contracts.md`
**Story Number**: 03

---

## Slice 1: Serve Container And Archive Logs
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Brood exposes a read-only HTTP log endpoint for container-backed sessions and archived teardown logs.

**Justification**: This delivers a usable service-owned log read path for `spawn` and `legate` records without waiting on the operator CLI or steward-specific Castra behavior. It satisfies the core server-ownership boundary for logs and gives the next slices a stable API to consume.

**Addresses**: FR-013, FR-014, FR-015, FR-016, FR-017, FR-020; Acceptance Scenarios 3.1-3.5

### Tasks

- [ ] **Add Brood log source selection**

  Add a Brood service-owned log read module under `src/brood/service/` that resolves live-container, archive, and unavailable outcomes for `SessionRecord` rows. Keep the module injectable for tests and aligned with the `LogReadSource` data-model section while leaving steward Castra output for Slice 2.

  _Acceptance criteria:_
  - Container-backed records prefer the tracked live container source for AS 3.1
  - Removed or unreadable live containers fall back to archive when available for AS 3.2
  - Missing live and archive sources produce an unavailable outcome for AS 3.3
  - Unknown ids are distinguishable from unavailable logs for AS 3.4
  - Source selection is read-only and performs no registry, Docker, worktree, branch, or archive mutation for AS 3.5

- [ ] **Expose the Brood logs HTTP route**

  Add `GET /sessions/:id/logs` in `src/brood/service/routes.ts` and client support in `src/brood/service/client.ts`. Map source-selection outcomes to the contracts artifact's status codes, headers, and text response while preserving existing session route behavior.

  _Acceptance criteria:_
  - The route returns text log content for live container and archive sources
  - The response identifies the selected `LogReadSource` for tests and callers
  - Unknown ids return the contracted not-found response for AS 3.4
  - Unavailable logs return the contracted non-zero service error for AS 3.3
  - Brood client failures surface clearly without local fallback for FR-016

- [ ] **Keep Brood contract docs aligned**

  Update Brood subsystem contract documentation when the logs HTTP route changes the mapped public service surface. Keep the documentation focused on the read-only endpoint, error envelope, and ownership boundary from the contracts artifact.

  _Acceptance criteria:_
  - The subsystem contract documents the logs route as a Brood-owned read surface
  - The documented route does not imply registry, Docker, archive, worktree, or branch mutation
  - Error conditions cover not-found and unavailable-log outcomes
  - The documentation remains consistent with `brood-cli-read-surface.contracts.md`

**PR Outcome**: Brood can serve live container logs or archived teardown logs over HTTP for tracked container-backed sessions, with a typed client surface and documented read-only contract.

---

## Slice 2: Read Steward Logs Through Castra
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: The Brood logs endpoint returns live steward session output through Castra when a steward row has no container.

**Justification**: Steward logs have a different live source than spawn and legate logs, so this slice extends the service-owned selector without changing the operator CLI surface. It closes the special-case acceptance scenario while preserving archive fallback when Castra output is unavailable.

**Addresses**: FR-015a, FR-017, FR-020; Acceptance Scenarios 3.5-3.6

### Tasks

- [ ] **Add Castra session output as a log source**

  Extend the Brood service log read module to resolve live `steward` rows through `CastraClient.sessionOutput` using the tracked `agentDeckSessionId` and profile. Preserve archive fallback and unavailable-log behavior when Castra output cannot be read.

  _Acceptance criteria:_
  - Live steward rows with an `agentDeckSessionId` read Castra output for AS 3.6
  - A missing steward `containerId` is not treated as a fault for AS 3.6
  - Castra read failure falls back to archive when an archived log exists
  - Castra read failure without archive produces the contracted unavailable-log outcome
  - Castra reads do not mutate Castra session state for AS 3.5

- [ ] **Cover steward log routing in service tests**

  Extend Brood route and log-reader coverage for the steward-specific source path. Use injected dependencies so tests verify source choice, fallback behavior, and read-only interaction without requiring a live Castra process.

  _Acceptance criteria:_
  - Service tests cover successful steward output for AS 3.6
  - Service tests cover steward archive fallback after a live-source failure
  - Service tests cover unavailable steward logs when neither source can be read
  - Tests prove the route does not call mutation APIs while reading logs

**PR Outcome**: Brood's logs endpoint handles every tracked session kind, including live stewards hosted by Castra, without moving log-source ownership into the CLI.

---

## Slice 3: Add The Operator Logs Command
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Operators can run `march brood logs <id>` as a thin client over the Brood service log endpoint.

**Justification**: The CLI command is the user-facing read surface for US3 and can remain small once the service owns source selection. It delivers the requested operator workflow without expanding into list, inspect, teardown, watch, attach, or local archive parsing behavior.

**Addresses**: FR-013, FR-016, FR-017, FR-018, FR-020; Acceptance Scenarios 3.1-3.6

### Tasks

- [ ] **Wire `march brood logs` to Brood**

  Add the `logs <id>` subcommand in `src/cli/program.ts` as a thin `BroodClient` call that writes log content to stdout. Keep all Docker, Castra, archive, and source-selection behavior behind the service endpoint.

  _Acceptance criteria:_
  - The command prints service-returned log content for AS 3.1, AS 3.2, and AS 3.6
  - Unknown ids exit non-zero with the contracted not-found behavior for AS 3.4
  - Unavailable logs exit non-zero with a clear service-derived message for AS 3.3
  - Brood service connection failures exit non-zero without raw registry or archive fallback for FR-016
  - The command introduces no teardown, watch, follow, attach, launch, or cleanup behavior for FR-018

- [ ] **Prove CLI logs are read-only**

  Add focused CLI and client coverage showing `march brood logs <id>` delegates to Brood and only renders the response. Include coverage for successful log output, unavailable logs, unknown ids, and unreachable Brood.

  _Acceptance criteria:_
  - CLI tests cover live, archive, and steward-success paths through the service contract
  - CLI tests cover not-found and unavailable-log failures
  - Tests show the CLI never opens Docker, Castra, archive, worktree, branch, or registry paths directly
  - Existing `brood list`, `brood teardown`, and `brood sweep` behavior is preserved

**PR Outcome**: `march brood logs <id>` is available as the operator-facing read command and delegates all log-source decisions to Brood.

---

## Specification Debt
<!-- audience: reviewer; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Archive availability sequencing: F2 specifies fallback to F3's archived `container.log`, but F3 is a separate feature. The F2 implementation must either land after the archive path exists or ship the fallback path with fixture coverage and a clear unavailable-log error until F3 writes real archives. | clarify:Integration | Medium | Medium | inherited | — |
| SD-002 | inherited from spec: Exact `needsAttention` predicate is inherited from F1's open debt. This feature requires the marker to exist in list/inspect output, but the final predicate set is owned by the derived-view contract F1 exposes. | clarify:Domain & Data Model | Medium | Medium | inherited | — |
| SD-003 | inherited from spec: F1's shipped derivation (`src/brood/spawn-index.ts`) is typed against the legacy `SpawnRecord` and reads `~/.march/spawns/*.json`, while this feature reads the service's `SessionRecord` over `GET /sessions`. FR-019 makes the lift prerequisite work, but the shape of that lift is undecided: generalize `derivedStatus` over both record types, adapt `SessionRecord` → `SpawnView` at the boundary, or retire the legacy reader once F2 lands. Settle at slice time. | plan-review:Assumption-output drift | High | High | inherited | — |
| SD-004 | inherited from spec: The Brood service exposes no reconciliation query parameter and no logs endpoint today. FR-020 places both server-side, so this feature adds routes to a shipped service. Whether reconciliation becomes a query parameter on the existing session routes (as contracted here) or a separate observation endpoint is a service-design decision for the slice. | clarify:Integration Points | High | Medium | inherited | — |
| SD-005 | inherited from spec: Steward log retrieval depends on a Castra session-output read path (FR-015a). Whether Castra already exposes a suitable read endpoint, and whether Brood proxies it or the CLI is told to ask Castra directly, is unverified at spec time and must be confirmed before slicing US3. | clarify:Integration Points | Medium | Low | inherited | — |

---

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: discouraged -->

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Serve Container And Archive Logs | — | — |
| S2 | Read Steward Logs Through Castra | S1 | — |
| S3 | Add The Operator Logs Command | S1, S2 | — |

### Cross-Story Dependencies

None — this story is self-contained.
