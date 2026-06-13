# Tasks: Per-Backend Auth Pre-Flight Validation

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 6
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 06

---

## Slice 1: Selected Backend Auth Pre-Flight

**Goal**: Validate the selected backend's auth requirements after dependency validation and before any spawn-scoped artifacts are created, covering both env-var auth and Codex credential-mount auth without exposing secret values.

**Justification**: US6 is a single dispatch-stage guard: the selected backend is already resolved and its launch metadata is already backend-owned, so the pre-flight can run before worktree creation and fail cleanly. Splitting env-var and credential-mount checks would create a partial state where one registered backend gets early auth failures while the other still fails later inside the container.

**Addresses**: FR-013, FR-014, FR-015; Acceptance Scenarios 6.1, 6.2, 6.3, 6.4, 6.5

### Tasks

- [x] **Validate selected backend auth before worktree creation**

  Add the dispatch auth pre-flight immediately after Stage 1 dependency validation and before Stage 2 worktree creation. The check must read only the selected backend's declared auth surface: `requiredEnvVars` for env-var backends and `credentialMounts` for credential-mount backends. For env vars, unset and empty-string values are both missing. For credential mounts, the backend-resolved host source must exist and be readable. Failures exit with `USAGE_ERROR` before worktree, branch, snapshot image, or container creation; a base image pulled by Stage 1 remains outside this slice's cleanup scope.

  _Acceptance criteria:_
  - Missing selected-backend env vars exit with `USAGE_ERROR`, name the backend and missing variable names, and create no spawn-scoped artifacts, satisfying AS 6.1.
  - Empty-string env vars are treated as missing, satisfying AS 6.2.
  - Present, non-empty env vars pass silently and dispatch continues, satisfying AS 6.3.
  - Codex credential mounts are validated through backend-declared `credentialMounts` and fail before worktree creation when the resolved host directory is absent or unreadable.
  - The pre-flight runs after Stage 1 dependency validation and before Stage 2 worktree creation, satisfying AS 6.4.
  - Error output and logs report only variable or mount names and never include credential values or value prefixes, satisfying AS 6.5.
  - Claude's happy path remains behaviorally preserved when `ANTHROPIC_API_KEY` is set.

**PR Outcome**: Dispatch fails fast for missing selected-backend auth while preserving the Validate-before-auth ordering and preventing any worktree, branch, snapshot image, or container artifacts from being created on auth failure.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec/contracts: User Story 6 and FR-013 through FR-015 were originally phrased around Gemini env-var auth, but the shipped second backend is Codex with credential mounts. This task plan treats env-var auth and credential-mount auth as the live US6 implementation target. | Specification Drift | High | High | resolved | Resolved 2026-06-06 — US6 tasks validate both `requiredEnvVars` and backend-declared `credentialMounts`, matching the divergence note and live `SpawnBackend` contract. |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Selected Backend Auth Pre-Flight | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: SpawnBackend Interface and Registry | depends on | US6 consumes the backend interface and registry surface created by US2. |
| User Story 3: Claude Code Backend (Refactor with Behavioral Preservation) | depends on | US6 validates Claude's env-var auth through `claudeCodeBackend.requiredEnvVars`. |
| User Story 4: Gemini CLI Backend | depends on | US6 consumes the live US4 substitution, `codexBackend`, as the second backend for credential-mount auth validation. |
| User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline | depends on | US6 uses the backend-owned auth fields US5 routes into launch. |
| User Story 1: Backend Selection at Dispatch Time | depends on | US6 validates the backend selected by US1 after dependency validation and before worktree creation. |
| User Story 7: SpawnRecord Backend Traceability | depended upon by | US7 can assume dispatch has already validated selected-backend auth before records are written for successful launches. |
