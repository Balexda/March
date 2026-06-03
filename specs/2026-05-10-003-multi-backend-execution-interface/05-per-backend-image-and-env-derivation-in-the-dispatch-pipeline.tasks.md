# Tasks: Per-Backend Image and Env Derivation in the Dispatch Pipeline

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 5
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 05

---

## Slice 1: Selected Backend Dispatch Derivation

**Goal**: Route the dispatch pipeline's image, environment, credential-mount, and entrypoint derivation through the already-resolved `SpawnBackend`, and narrow `SpawnConfig` so it only owns shared security/resource posture.

**Justification**: US5's acceptance scenarios all concern the same pipeline handoff: once a backend has been resolved, every stage that used to read global Claude-only constants must read backend-owned data instead. Landing the validate, snapshot, launch, and config narrowing changes together avoids an intermediate state where one stage uses Codex-owned data while another still forces the Claude image or auth surface.

**Addresses**: FR-009, FR-010, FR-011, FR-012; Acceptance Scenarios 5.1, 5.2, 5.3, 5.4, 5.5

### Tasks

- [ ] **Derive Stage 1 and Snapshot images from the selected backend**

  Update the dispatch action and snapshot build boundary so the dependency check and generated Dockerfile consume the resolved backend's `baseImage`. Keep backend selection itself scoped to the already-existing resolution surface; do not add new `--backend` parsing, env-var fallback behavior, or auth pre-flight exits in this slice.

  _Acceptance criteria:_
  - Stage 1 dependency validation checks `selectedBackend.baseImage`, satisfying AS 5.1.
  - Snapshot Dockerfile generation writes `FROM selectedBackend.baseImage`, satisfying AS 5.2.
  - The old global image constant is not imported by dispatch or forced into the snapshot call path.
  - Tests prove Claude and Codex fixture backends drive different dependency-check image tags and Dockerfile `FROM` lines.
  - Missing or unpullable images still use the existing dependency-check failure path; only the image source changes.

- [ ] **Derive Launch env, credential mounts, and entrypoint from the selected backend**

  Update container launch input and launch composition so all backend-specific launch data comes from the selected backend. For env-var backends, emit passthrough flags from `requiredEnvVars`; for credential-mount backends, honor backend-declared credential mounts without adding operator-authored bind-mount exceptions, preserving the minimum-required-access rule from the operating philosophy.

  _Acceptance criteria:_
  - Launch env flags iterate only `selectedBackend.requiredEnvVars`, satisfying AS 5.3.
  - Non-selected backend env vars are not forwarded even when present in the host environment.
  - `LaunchSpawnContainerInput` carries a `SpawnBackend` instead of relying on backend-specific imports or helpers.
  - The entrypoint argv comes from `selectedBackend.buildEntrypoint(...)`.
  - Codex credential mounts are passed through the live `credentialMounts` backend field, while Claude continues to use env-var auth only.

- [ ] **Narrow SpawnConfig and retire forced global image/env coupling**

  Remove `envWhitelist` from `SpawnConfig` and update tests or fixtures that treated Claude auth as global spawn posture to read from the Claude backend instead. Retain shared resource and security fields exactly as posture configuration, and leave any remaining image constant only where it is not a dispatch-stage source of truth.

  _Acceptance criteria:_
  - `SpawnConfig` exposes only `capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, and `timeoutSeconds`, satisfying AS 5.4.
  - Searches for the old `envWhitelist` field find no production references.
  - Searches for the old global image constant find no dispatch dependency-check, snapshot `FROM`, or launch fixture path that forces every spawn through one image, satisfying AS 5.5.
  - Claude behavioral preservation tests continue to assert the same image/env/entrypoint values through `claudeCodeBackend`.
  - The slice does not change SpawnRecord backend population; US7 owns record traceability.

**PR Outcome**: Dispatch stages read image, auth env vars, credential mounts, and entrypoint argv from the resolved backend, while `SpawnConfig` is narrowed to shared posture. Claude remains behaviorally preserved, Codex can flow through the same launch machinery, and backend selection/auth/record stories remain separate.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: `envWhitelist` field removal vs. retention on `SpawnConfig` interface. US5 is the owning story for removing the field and redirecting touched assertions to backend-owned auth metadata. | Domain & Data Model | High | Medium | resolved | Resolved 2026-06-03 — this task plan makes `SpawnConfig` posture-only and routes auth env derivation through `SpawnBackend.requiredEnvVars`. |
| SD-002 | inherited from spec: F2 behavioral preservation means Claude dispatch remains observably identical, not that structural tests keep asserting on global `envWhitelist`. | Functional Scope | High | Medium | resolved | Resolved 2026-06-03 — this task plan preserves Claude behavior while allowing tests to assert backend-owned image/env/entrypoint values. |
| SD-003 | inherited from spec/contracts: the live second backend is Codex with `credentialMounts`, not Gemini with `GEMINI_API_KEY`; US5 launch derivation must route both env-var auth and credential-mount auth through backend-owned fields. | Specification Drift | High | High | resolved | Resolved 2026-06-03 — this task plan includes Codex credential mounts as part of selected-backend launch derivation. |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Selected Backend Dispatch Derivation | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: SpawnBackend Interface and Registry | depends on | US5 consumes the backend interface and registry surface created by US2. |
| User Story 3: Claude Code Backend (Refactor with Behavioral Preservation) | depends on | US5 routes the existing Claude backend through dispatch call sites while preserving F2 behavior. |
| User Story 4: Gemini CLI Backend | depends on | US5 consumes the live US4 substitution, `codexBackend`, as the second backend for image, credential-mount, and entrypoint derivation. |
| User Story 1: Backend Selection at Dispatch Time | depended upon by | US1 exposes backend choice to operators after US5 can route resolved backend data through dispatch stages. |
| User Story 6: Per-Backend Auth Pre-Flight Validation | depended upon by | US6 validates env vars and credential mounts before spawn-scoped artifacts are created, using the same backend-owned auth fields US5 routes into launch. |
| User Story 7: SpawnRecord Backend Traceability | depended upon by | US7 records the selected backend name after dispatch selection and stage derivation are wired. |
