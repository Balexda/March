# Tasks: Claude Code Backend Refactor With Behavioral Preservation

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 3
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 03

---

## Slice 1: Claude Code Backend Registration

**Goal**: Extract the existing Claude Code image, auth env var, and entrypoint into a registered `claudeCodeBackend` while preserving the existing dispatch behavior for the default backend.

**Justification**: The backend object and default registration must land together to make the refactor observable and testable without introducing a partially wired abstraction. This slice proves the real Claude path satisfies the backend contract before later stories route dispatch stages through the selected backend.

**Addresses**: FR-007, FR-017; Acceptance Scenarios 3.1, 3.2, 3.3, 3.5

### Tasks

- [ ] **Define the Claude Code backend**

  Update the spawn backend module (`src/spawn/backends.ts`, or the US2-created backend module if it still has the older path) with a `claudeCodeBackend` that satisfies the live `SpawnBackend` contract. Preserve the existing Claude image tag, auth env var, registry name, and entrypoint argv from the F2 dispatch path, and keep credential-mount auth empty if the live five-member interface from the divergence note is present.

  _Acceptance criteria:_
  - `claudeCodeBackend.name` is `"claude-code"` per AS 3.5.
  - `claudeCodeBackend.baseImage` matches the current F2 default Claude image constant used before this refactor, satisfying AS 3.2 without changing the image tag.
  - `claudeCodeBackend.requiredEnvVars` is exactly `["ANTHROPIC_API_KEY"]` per AS 3.3.
  - `claudeCodeBackend.buildEntrypoint("/march/prompt.txt")` returns the same argv the existing Claude launch path used for AS 3.1.
  - If `SpawnBackend` includes `credentialMounts`, the Claude backend declares an empty readonly list so env-var auth remains the only Claude auth path.

- [ ] **Register Claude as the default backend**

  Wire `claudeCodeBackend` into the backend registry surface from US2 so registry lookup returns it by name and default selection resolves to Claude Code. Keep this registration static; do not introduce plugin loading, dependency injection, or runtime backend mutation.

  _Acceptance criteria:_
  - `getBackend("claude-code")` returns the exported `claudeCodeBackend`.
  - `listBackends()` includes `"claude-code"` in deterministic order without exposing backend objects.
  - `defaultBackendName` is `"claude-code"`.
  - Unknown backend lookup behavior remains unchanged from US2.
  - No dispatch pipeline stage is migrated to consume the selected backend in this slice; US5 owns image/env/entrypoint derivation at call sites.

- [ ] **Preserve F2 behavior with regression tests**

  Extend backend and launch-adjacent unit tests to prove the extracted Claude backend is behaviorally identical to the F2 hardcoded path. Tests should compare observable values and argv composition, not private helper names, so they remain valid whether the old helper is removed or kept during the refactor.

  _Acceptance criteria:_
  - Tests cover AS 3.1 through AS 3.5 for the concrete Claude backend.
  - Existing F2 dispatch, snapshot, and launch tests continue to pass for the default Claude path.
  - Assertions that previously treated Claude's auth env var as global spawn configuration are redirected to `claudeCodeBackend.requiredEnvVars` where this slice touches them, resolving the behavioral-preservation ambiguity without restoring `envWhitelist`.
  - The implementation does not add Gemini, Codex, auth pre-flight validation, CLI `--backend` parsing, SpawnRecord backend population changes, or per-backend dispatch-stage derivation.

**PR Outcome**: The repository has a concrete, registered `claudeCodeBackend` that preserves the current Claude Code launch contract and remains the default backend. Later slices can add additional backends and route dispatch stages through the selected backend without re-opening the Claude extraction.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: `envWhitelist` field removal vs. retention on `SpawnConfig` interface — FR-012 says drop it entirely, but US3 says "F2 tests pass unchanged." Removing the field will break any F2 unit test that asserts on `SPAWN_CONFIG.envWhitelist` (the existing assertion lives in `src/spawn-config.test.ts`; locate it by searching for `envWhitelist`). The reconciled position is: remove the field and redirect F2 unit assertions to read from `claudeCodeBackend.requiredEnvVars`. End-to-end behavioral preservation holds; literal test-source preservation does not. | Domain & Data Model | High | Medium | resolved | Resolved 2026-05-23 — this task plan defines US3 preservation as behavioral preservation and directs touched auth-env assertions to `claudeCodeBackend.requiredEnvVars`. |
| SD-002 | inherited from spec: Whether F2's existing test suite passes literally unchanged, or whether structural assertions touching `envWhitelist` need redirection to the new backend object. The reconciled plan's "byte-for-byte F2 preservation" likely means *behavioral* preservation only. Needs explicit confirmation before US3 (Claude Code Backend) is decomposed into tasks, since the tasks file scope changes materially based on the answer. | Functional Scope | High | Medium | resolved | Resolved 2026-05-23 — this task plan scopes US3 to behavioral preservation and allows structural test assertions touched by the refactor to follow the backend object. |
| SD-003 | inherited from spec: The divergence note says the live backend interface includes credential mounts and the second backend is Codex, but the original US3 acceptance text still describes the pre-divergence four-member interface and Gemini-era registry. | Specification Drift | Medium | High | inherited | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Claude Code Backend Registration | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: SpawnBackend Interface and Registry | depends on | US3 consumes the backend interface and registry surface created by US2. |
| User Story 4: Gemini CLI Backend | depended upon by | US4 follows this slice's concrete-backend registration pattern for the second backend, subject to the spec divergence that Codex replaced Gemini in the shipped implementation. |
| User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline | depended upon by | US5 routes dependency checks, Dockerfile generation, and container launch env/entrypoint composition through the selected backend after Claude is registered. |
| User Story 7: SpawnRecord Backend Traceability | depended upon by | US7 records the selected backend name once dispatch selection is wired. |
