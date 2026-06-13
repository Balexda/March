# Tasks: Codex CLI Backend

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 4
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 04

---

## Slice 1: Codex Backend Registration

**Goal**: Register the live second backend as `codexBackend`, using the shipped Codex credential-mount auth model instead of the original Gemini env-var model. The backend must satisfy the current `SpawnBackend` surface and be available through the static registry without changing dispatch-stage derivation.

**Justification**: The spec's divergence note replaces Gemini with Codex for US4 and treats credential mounts as a first-class backend capability. Landing the backend object, registration, and focused regression tests together gives the interface a real second implementation while keeping selection, auth pre-flight, image derivation, launch derivation, and record traceability in their own stories.

**Addresses**: FR-008 as amended by the 2026-05-16 divergence note; Acceptance Scenarios 4.1, 4.2, 4.3, 4.4, 4.5 as substituted from `gemini` to `codex`

### Tasks

- [x] **Define the Codex backend**

  Update the spawn backend module with a `codexBackend` that satisfies the live `SpawnBackend` contract. Use Codex's base image, registry name, credential mount, entrypoint, and egress-host metadata as backend-owned data. Do not add Gemini, do not reintroduce env-var auth for the second backend, and do not route any dispatch pipeline stage through the selected backend in this slice.

  _Acceptance criteria:_
  - `codexBackend.name` is `"codex"`, the live substitution for AS 4.5.
  - `codexBackend.baseImage` is `"march-spawn-codex:latest"`, the live substitution for AS 4.2.
  - `codexBackend.requiredEnvVars` is an empty readonly list because Codex authenticates via credential mount rather than `GEMINI_API_KEY`.
  - `codexBackend.credentialMounts` declares a read-only Codex credential directory mount resolved from `CODEX_HOME`, with a fallback to the host Codex home under `HOME`, and exposes the in-container `CODEX_HOME` value needed by the entrypoint.
  - `codexBackend.buildEntrypoint("/march/prompt.txt")` returns an argv that copies mounted credentials into the in-container Codex home and runs `codex exec` headlessly against the prompt file. The entrypoint does not use Gemini flags and does not add Docker-in-Docker sandboxing.
  - `codexBackend.allowedEgressHosts` declares the ChatGPT/Codex service host(s). `allowedEgressHosts` is a required field on the live `SpawnBackend` surface (`src/spawn/backends.ts`), so Codex MUST populate it — egress metadata is not optional — without broadening Claude's egress metadata.

- [x] **Register Codex in the backend registry**

  Add `codexBackend` to the static backend registry alongside `claudeCodeBackend`. Keep the registry deterministic and internal; this slice does not introduce plugin loading, runtime backend mutation, profile selection, or any CLI default change.

  _Acceptance criteria:_
  - `getBackend("codex")` returns the exported `codexBackend`.
  - `listBackends()` includes `"codex"` in stable order without exposing backend implementation objects.
  - Unknown backend lookup behavior remains unchanged from US2.
  - `defaultBackendName` remains `"claude-code"`; changing dispatch defaults is outside US4.
  - No dispatch pipeline stage is migrated to consume Codex in this slice; US5 owns image/env/entrypoint derivation at call sites and US1 owns operator-facing selection.

- [x] **Cover Codex backend behavior with focused tests**

  Extend backend unit tests to prove the second registered backend satisfies the live substituted US4 contract. Tests should assert backend-owned values and registry behavior, not dispatch pipeline behavior that later stories own.

  _Acceptance criteria:_
  - Tests cover the Codex substitutions for AS 4.1 through AS 4.5.
  - Tests verify credential mount resolution from `CODEX_HOME` and from the fallback host Codex home.
  - Tests verify missing credential directories are detected without logging or asserting on credential contents.
  - Existing Claude backend tests continue to pass, proving Codex registration does not change the default backend or Claude's env-var auth contract.
  - The implementation does not add Gemini, CLI `--backend` parsing, per-backend dependency checks, snapshot `FROM` derivation, container-launch derivation, auth pre-flight exits, or SpawnRecord backend population changes.

**PR Outcome**: The repository has a concrete, registered `codexBackend` as the live second backend for US4. The backend owns Codex image, credential-mount auth, entrypoint, and egress metadata, while later stories remain responsible for selecting it and routing dispatch stages through the selected backend.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: The original US4 acceptance scenarios name Gemini, `GEMINI_API_KEY`, and `march-gemini-base:latest`, but the 2026-05-16 divergence note replaces the second backend with Codex and credential-mount auth. This task plan treats Codex as the canonical US4 implementation target. | Specification Drift | High | High | resolved | Resolved 2026-06-03 — US4 tasks are cut against `codexBackend`, `CODEX_HOME` credential mounts, and `march-spawn-codex:latest` per the divergence note. |
| SD-002 | inherited from spec/contracts: the live `SpawnBackend` surface includes `allowedEgressHosts` from later sandbox work in addition to the five-member divergence surface documented in the F3 artifacts. | Specification Drift | Medium | High | inherited | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Codex Backend Registration | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 2: SpawnBackend Interface and Registry | depends on | US4 consumes the backend interface and registry surface created by US2. |
| User Story 3: Claude Code Backend (Refactor with Behavioral Preservation) | depends on | US4 follows the concrete-backend registration pattern established by US3 while leaving Claude as the default backend. |
| User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline | depended upon by | US5 routes dependency checks, Dockerfile generation, and container launch composition through the selected backend after Codex is registered. |
| User Story 1: Backend Selection at Dispatch Time | depended upon by | US1 makes the registered Codex backend operator-selectable via `--backend` and `MARCH_BACKEND`. |
| User Story 6: Per-Backend Auth Pre-Flight Validation | depended upon by | US6 validates Codex credential mounts before spawn-scoped artifacts are created. |
| User Story 7: SpawnRecord Backend Traceability | depended upon by | US7 records `codexBackend.name` once dispatch selection is wired. |
