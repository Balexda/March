# Tasks: Backend Selection at Dispatch Time

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 1
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 01

---

## Slice 1: Wire Backend Selection Into Spawn Dispatch

**Goal**: Extend `march spawn dispatch` so operators can select a registered backend with `--backend <name>` or `MARCH_BACKEND`, see supported backend names in help output, and receive a clean usage error for unknown selections before any spawn-scoped work begins.

**Justification**: Backend selection is one user-facing CLI behavior with one resolution path: flag, env fallback, default, registry lookup, and error formatting. Splitting help text from resolution would leave a discoverability-only PR that cannot prove the selected backend actually drives dispatch, while splitting invalid-selection handling would leave the CLI accepting a new option without its required safety boundary.

**Addresses**: FR-001, FR-002, FR-003, FR-004; Acceptance Scenarios 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7

### Tasks

- [x] **Add backend selection to dispatch CLI**

  Update the `march spawn dispatch` command in `src/cli/program.ts` to expose `--backend <name>` and resolve it through the backend registry before the existing dependency and spawn pipeline stages. Use the live registry values from `src/spawn/backends.ts`; per the spec divergence note, the second supported backend is `codex` rather than the historical `gemini`.

  _Acceptance criteria:_
  - Help output lists the backend option and supported registered backend names (AS 1.1).
  - Missing flag and missing or empty `MARCH_BACKEND` resolve to the default backend (AS 1.2).
  - A valid backend flag selects that backend for the dispatch path (AS 1.3).
  - A valid `MARCH_BACKEND` value is used when the flag is absent (AS 1.4).
  - A backend flag takes precedence over a conflicting env-var value (AS 1.5).

- [x] **Reject unknown backend selections early**

  Extend the dispatch command's selection path so unknown backend names from either source exit through the existing usage-error path before dependency checks, worktree creation, image work, or container launch. Keep the user-facing error scoped to the rejected value, its source, and the supported backend names from the registry.

  _Acceptance criteria:_
  - Unknown flag values exit with `USAGE_ERROR` and identify the flag source (AS 1.6).
  - Unknown env-var values exit with `USAGE_ERROR` and identify the env-var source (AS 1.7).
  - Invalid selection does not create spawn-scoped artifacts or invoke later pipeline stages.
  - Error output enumerates supported backend names without leaking backend implementation objects.
  - Existing default Claude Code dispatch behavior remains backward-compatible when no backend is selected.

**PR Outcome**: `march spawn dispatch` documents backend selection, resolves flag/env/default choices through the registered backend surface, routes valid selections into the spawn pipeline, and rejects unknown selections with a deterministic usage error before any spawn artifacts are created.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: `envWhitelist` field removal vs. retention on `SpawnConfig` interface — FR-012 says drop it entirely, but US3 says "F2 tests pass unchanged." Resolved in the shipped F3 implementation: `envWhitelist` has been removed from `SpawnConfig` (`src/hatchery/spawn-config.ts`) and its test (`src/hatchery/spawn-config.test.ts`) no longer asserts on it — per-backend env forwarding now derives from each backend's `requiredEnvVars` in `src/spawn/backends.ts`. End-to-end behavioral preservation holds; literal test-source preservation does not. | Domain & Data Model | High | Medium | inherited | resolved in shipped US3/US5 — field removed, env forwarding moved to `requiredEnvVars` |
| SD-002 | inherited from spec: Whether F2's existing test suite passes literally unchanged, or whether structural assertions touching `envWhitelist` need redirection to the new backend object. The reconciled plan's "byte-for-byte F2 preservation" likely means *behavioral* preservation only. Needs explicit confirmation before US3 (Claude Code Backend) is decomposed into tasks, since the tasks file scope changes materially based on the answer. | Functional Scope | High | Medium | inherited | — |

_Both inherited items pertain to US3/US5 scope (envWhitelist removal and F2 behavioral preservation). They do not block US1 — US1 reads the backend registry and selected backend but does not narrow `SpawnConfig` or alter F2 structural assertions._

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Wire Backend Selection Into Spawn Dispatch | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline | depends on | US1 assumes dispatch can pass a resolved backend into the image, env, credential-mount, and entrypoint derivation path owned by US5. |
| User Story 6: Per-Backend Auth Pre-Flight Validation | depended upon by | US6 runs after backend selection and validates the selected backend's env vars or credential mounts before worktree creation. |
| User Story 7: SpawnRecord Backend Traceability | depended upon by | US7 records the selected backend name that US1 resolves. |
