# Tasks: SpawnBackend Interface and Registry

**Source**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.spec.md` — User Story 2
**Data Model**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.data-model.md`
**Contracts**: `specs/2026-05-10-003-multi-backend-execution-interface/multi-backend-execution-interface.contracts.md`
**Story Number**: 02

---

## Slice 1: SpawnBackend Interface and Backend Registry Module

**Goal**: Introduce a new `src/spawn-backend.ts` module that exports the `SpawnBackend` TypeScript interface (exactly four members) and a `createBackendRegistry` factory returning `{ getBackend, listBackends, defaultBackendName }`. The module compiles standalone and is fully unit-tested using fixture backends — no concrete `claudeCodeBackend` or `geminiBackend` is added, and no existing module is modified.

**Justification**: The interface and the registry are inseparable for testability: the registry's types reference `SpawnBackend`, and AS 2.2–2.4 cannot be verified without both. Splitting them across two PRs would leave the interface-only PR with no shippable test surface. One PR delivers the full structural backbone US3 (Claude Code backend), US4 (Gemini backend), and US5 (per-backend dispatch wiring) compile against.

**Addresses**: FR-005, FR-006; Acceptance Scenarios 2.1, 2.2, 2.3, 2.4, 2.5

### Tasks

- [ ] **Define `SpawnBackend` interface in `src/spawn-backend.ts`**

  Create `src/spawn-backend.ts` exporting a `SpawnBackend` interface with the four members specified in the contracts (`name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`) and no others. The `buildEntrypoint` return type is the structural-compatibility commitment AS 2.5 names — it must be assignable to the entrypoint argv shape `launchSpawnContainer` consumes today, without modifying `src/container-launch.ts`.

  _Acceptance criteria:_
  - Interface declares exactly the four members named in AS 2.1; no `validateAuth`, `parseExitCode`, or `cliCommand`.
  - `requiredEnvVars` and `buildEntrypoint`'s return type use the `readonly` array modifier per the contract.
  - `buildEntrypoint`'s return type is structurally assignable to the entrypoint argv shape consumed by `launchSpawnContainer` (AS 2.5) — verified by a type-level assertion in tests, not by modifying `LaunchSpawnContainerInput` (that field is US5's deliverable).
  - A plain object literal satisfying all four members compiles without a cast.
  - File is new; no existing `src/*.ts` file is touched.

- [ ] **Implement `createBackendRegistry` factory with duplicate-name guard**

  Extend `src/spawn-backend.ts` with a `createBackendRegistry` factory function that accepts a list of `SpawnBackend` values and returns an object exposing `getBackend`, `listBackends`, and `defaultBackendName`. Also export `defaultBackendName` as a module-level constant equal to the value specified in the Backend Registry contract section. Tests must drive AS 2.2–2.4 with fixture backends only — no concrete `claudeCodeBackend` or `geminiBackend` imports, and no production module is modified.

  _Acceptance criteria:_
  - `getBackend` returns the registered backend for a known name (AS 2.2); returns `undefined` for an unknown name without throwing (AS 2.3).
  - `listBackends` returns a stable, deterministic list of registered backend names without leaking implementation objects (AS 2.4).
  - `defaultBackendName` is exported as the constant value defined in the Backend Registry contract section.
  - Constructing the registry with two entries sharing the same `name` raises a developer-facing error at construction time (data-model Entity 2 validation rule).
  - Tests use fixture backends (plain object literals satisfying the interface) to exercise lookup and enumeration without depending on US3 or US4.
  - `src/spawn-record.ts`'s `DEFAULT_BACKEND` constant is NOT modified — US7 owns that migration.

**PR Outcome**: `src/spawn-backend.ts` ships with the `SpawnBackend` interface, the `createBackendRegistry` factory, and the `defaultBackendName` constant. Unit tests cover AS 2.1–2.5 with fixture backends. No consumer module imports the new file yet; US3, US4, and US5 are unblocked to do so in their own slices.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: `envWhitelist` field removal vs. retention on `SpawnConfig` interface — FR-012 says drop it entirely, but US3 says "F2 tests pass unchanged." Removing the field will break any F2 unit test that asserts on `SPAWN_CONFIG.envWhitelist` (the existing assertion lives in `src/spawn-config.test.ts`; locate it by searching for `envWhitelist`). The reconciled position is: remove the field and redirect F2 unit assertions to read from `claudeCodeBackend.requiredEnvVars`. End-to-end behavioral preservation holds; literal test-source preservation does not. | Domain & Data Model | High | Medium | inherited | — |
| SD-002 | inherited from spec: Whether F2's existing test suite passes literally unchanged, or whether structural assertions touching `envWhitelist` need redirection to the new backend object. The reconciled plan's "byte-for-byte F2 preservation" likely means *behavioral* preservation only. Needs explicit confirmation before US3 (Claude Code Backend) is decomposed into tasks, since the tasks file scope changes materially based on the answer. | Functional Scope | High | Medium | inherited | — |

_Both inherited items pertain to US3/US5 scope (envWhitelist removal and F2 behavioral preservation). They do not block US2 — US2 does not touch `src/spawn-config.ts`, `SPAWN_CONFIG`, or any F2 test. Carried forward per the cut inheritance rule; will be load-bearing when US3 and US5 are cut._

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | SpawnBackend Interface and Backend Registry Module | — | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 3: Claude Code Backend (Refactor with Behavioral Preservation) | depended upon by | US3 imports `SpawnBackend` from this module to type its `claudeCodeBackend` and registers it through `createBackendRegistry`. |
| User Story 4: Gemini CLI Backend | depended upon by | US4 imports `SpawnBackend` from this module to type its `geminiBackend` and registers it through `createBackendRegistry`. |
| User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline | depended upon by | US5 wires the dispatch action to resolve a backend via `getBackend` and to read `requiredEnvVars` + `buildEntrypoint` + `baseImage` from the resolved instance. |
| User Story 7: SpawnRecord Backend Traceability | depended upon by | US7 migrates `src/spawn-record.ts`'s `DEFAULT_BACKEND` to consume `defaultBackendName` exported here; the constant is intentionally duplicated across US2–US6 until US7 lands. |
