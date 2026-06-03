# Feature Specification: Multi-Backend Execution Interface

**Spec Folder**: `2026-05-10-003-multi-backend-execution-interface`
**Branch**: `feature/smithy/mark/01-spawn-f3` *(orchestrator-staged linked worktree; preserved per Branch Selection Policy because the cwd is a non-default linked worktree)*
**Created**: 2026-05-10
**Status**: Draft  |  **Implementation status (2026-05-16)**: **Done (provisional, diverged).** See [Divergence note](#divergence-note-2026-05-16) immediately below before reading the rest of the spec.

## Divergence note (2026-05-16)

The shipped implementation diverged from this spec in two material ways:

1. **Codex replaces Gemini.** The second registered backend is `codex` (`march-spawn-codex:latest`), not `gemini`. All Gemini-specific user stories, scenarios, and FRs below (US4, FR-008, SC-001, etc.) should be read as *originally specified but not implemented*. Gemini was cut from the RFC on 2026-05-16; see RFC [Accelerated Work & Reordering](../../docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md#accelerated-work--reordering-2026-05). Substitute `codex` / `CODEX_HOME` / `march-spawn-codex:latest` for `gemini` / `GEMINI_API_KEY` / `march-gemini-base:latest` wherever the spec refers to the second backend, **with the auth caveat below**.
2. **Codex uses credential-mount auth, not env-var auth.** This spec assumed both backends share env-var auth (`requiredEnvVars` → `process.env` check). Codex instead requires a `BackendCredentialMountSpec`: the host's `CODEX_HOME` directory is bind-mounted read-only into the container at `/march/codex-auth`, and the entrypoint copies it into the in-container home (`cp -R /march/codex-auth/. /march/codex-home`) before invoking the CLI. This is a first-class backend capability, **not a workaround**.

   Concretely, the `SpawnBackend` contract is broader than US2/FR-005 describe: backends may declare either `requiredEnvVars` (env-var auth, like Claude Code) or a credential-mount spec (like Codex). The auth pre-flight (US6/FR-013) is generalized accordingly — env-var backends are checked against `process.env`; credential-mount backends are checked for the presence and readability of the host source directory. Live shape lives in `src/spawn/backends.ts`.

The structural backbone of this spec — the `SpawnBackend` interface, the registry pattern, the `--backend` / `MARCH_BACKEND` selection, per-backend image and env derivation, SpawnRecord traceability — is **realized as specified**. Only the second backend's identity and auth model diverged.

A Stage B spec ("hatchery declarative profiles") will move per-backend posture (resource limits, network allowlist, credential-mount spec) into Hatchery profiles, at which point this spec's "shared posture across backends" assumption (Assumptions §4) will be revisited.


**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — Milestone 1: Spawn (Decisions: "Multi-backend spawn interface"; Appendices B and C)
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` — Feature 3: Multi-Backend Execution Interface

## Clarifications

### Session 2026-05-10

- Q: Is `validateAuth` a method on the `SpawnBackend` interface, or a derivable check in the dispatch action? → A: Derivable in the dispatch action. The interface stays at 4 members (`name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`); auth pre-flight loops over `requiredEnvVars` against `process.env`. Both F3 backends share an identical check today, so polymorphism would add surface area without per-backend behavioral divergence. Future backends with non-env-var auth (token files, OAuth flows) can lift the check onto the interface as a separate feature.
- Q: Is `parseExitCode` a method on the `SpawnBackend` interface? → A: No. Exit-code interpretation belongs to F5 (Output Extraction); F3 launches and returns. F3's interface stays at 4 members.
- Q: Does Gemini's container entrypoint use `--sandbox=docker` (RFC Appendix B6's open question)? → A: No. The outer March container provides the only isolation layer, mirroring Claude Code's posture. Docker-in-Docker is rejected — it conflicts with F4's threat model and adds operational complexity without security gain.
- Q: Does F3 ship Claude Code OAuth/Claude-Max session auth (RFC Appendix C4)? → A: No. F3 ships API-key auth only for both backends. OAuth involves either mounting `~/.claude/` (host filesystem touch — conflicts with F4's no-host-filesystem posture) or extracting the session-token format (which "may change between releases" per RFC C6). Deferred to a follow-on feature once F4's threat model is settled.
- Q: How is `envWhitelist` derived now that backends differ on which env vars to forward? → A: It moves wholly off `SpawnConfig` onto `SpawnBackend.requiredEnvVars`. `SpawnConfig` retains only security/resource posture (`capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`). The launched container forwards exactly the selected backend's `requiredEnvVars` — no other backend's keys, no static union.
- Q: How is the backend selected at dispatch time? → A: A `--backend <name>` CLI flag with `MARCH_BACKEND` env-var fallback. Default is `claude-code` when both are absent (preserves F2 behavior). Flag wins over env var on conflict; unknown values from either source raise `USAGE_ERROR` (exit 2) and the error message identifies which input was rejected.
- Q: What happens when an operator has both `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` set but selects Gemini? → A: Only the *selected* backend's `requiredEnvVars` are forwarded into the container. Cross-backend keys are never leaked into the sandbox; this is the security guarantee from F2's SC-004 ("only whitelisted env vars") generalized per backend. `[Critical Assumption]`
- Q: What is the Gemini base image tag? → A: `march-gemini-base:latest`, mirroring `march-base:latest`. F3 does not build the image; it assumes external provisioning consistent with F2's contract (the base-image build/publish process is operational, not a feature deliverable).
- Q: What is the exact Gemini entrypoint shape? → A: `["sh", "-c", "gemini --prompt \"$(cat /march/prompt.txt)\" --approval-mode=yolo --output-format json"]`. The `sh -c` wrapper with `$(cat ...)` expansion mirrors Claude Code's pattern, omitting `--sandbox=docker`. `[Critical Assumption]`
- Q: Does F3 retroactively update SpawnRecords written by F2 (which always have `backend: "claude-code"` hardcoded)? → A: No. US7 plumbing is write-only on new dispatches. Existing on-disk records are not back-filled — F2-era records reflect the only backend that existed at the time.

### Assumptions

- The `SpawnBackend` interface promoted in F3 is the canonical dispatch contract going forward. F2's "SpawnBackend Interface (extension contract)" section in `spawn-dispatch.contracts.md` is realized in F3 with no further extensions in this milestone.
- The registry is implemented as a plain `Record<string, SpawnBackend>` constant. No DI, no class-based machinery — two backends do not justify the abstraction tax.
- `cliCommand` is NOT a separate field on the interface. `buildEntrypoint` encapsulates both the bare binary name and its argv composition.
- Resource limits (`memoryLimit`, `cpuLimit`, `timeoutSeconds`) and security posture (`capDrop`, `user`, `networkMode`) remain shared across backends in F3. Per-backend resource sizing is deferred to Hatchery (M2) where it can be expressed declaratively per profile.
- F2's existing `SpawnRecord.backend` field schema (string-typed, no enum constraint) is unchanged. Schema version stays at 1.
- F4 (Spawn Sandbox Security) owns network-policy hardening per backend. F3 introduces the second backend but does not change the network mode (`bridge`); the per-backend network exception list is F4's call.
- Operator-facing error messages name the backend and the failing input by their CLI/env names so a developer can correct without re-reading the spec.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Backend Selection at Dispatch Time (Priority: P1)

As an operator, I want to choose which AI backend runs a spawn so that I can match the backend to the task — using Claude Code for tasks that benefit from its richer JSON envelope and Gemini when its model or cost profile is preferable.

**Why this priority**: Backend selection is the user-facing surface for the entire feature. Without it, the polymorphic interface, registry, and Gemini implementation have no way for an operator to invoke them.

**Independent Test**: Run `march spawn dispatch --help` and verify the output documents a `--backend <name>` option with the supported values. Run `march spawn dispatch --backend gemini --prompt-file <path>` and verify the dispatch proceeds through the Gemini-specific path (image, env, entrypoint).

**Acceptance Scenarios**:

1. **Given** a working March installation, **When** the operator runs `march spawn dispatch --help`, **Then** the help text describes the `--backend <name>` flag and lists the supported backend names.
2. **Given** the operator runs `march spawn dispatch --prompt-file <path>` with no `--backend` flag and no `MARCH_BACKEND` env var set, **Then** dispatch proceeds with the Claude Code backend, preserving F2 behavior byte-for-byte (same image, same env, same entrypoint argv).
3. **Given** the operator runs `march spawn dispatch --backend gemini --prompt-file <path>`, **Then** dispatch proceeds with the Gemini backend (Gemini base image, `GEMINI_API_KEY` whitelist, Gemini entrypoint argv).
4. **Given** the operator sets `MARCH_BACKEND=gemini` and runs `march spawn dispatch --prompt-file <path>` with no `--backend` flag, **Then** dispatch proceeds with the Gemini backend.
5. **Given** the operator sets `MARCH_BACKEND=gemini` and runs `march spawn dispatch --backend claude-code --prompt-file <path>`, **Then** the flag wins and dispatch proceeds with the Claude Code backend.
6. **Given** the operator runs `march spawn dispatch --backend nonexistent --prompt-file <path>`, **Then** the command exits with `USAGE_ERROR` (2), prints a clear error naming the rejected value and the source (`--backend` flag), and lists the supported backend names. No worktree, image, or container is created.
7. **Given** the operator sets `MARCH_BACKEND=nonexistent` and runs `march spawn dispatch --prompt-file <path>`, **Then** the command exits with `USAGE_ERROR` (2) and the error message identifies `MARCH_BACKEND env var` as the source of the rejected value.

---

### User Story 2: SpawnBackend Interface and Registry (Priority: P1)

As a March maintainer, I want a single typed contract that every backend must satisfy — and a registry that maps backend names to implementations — so that adding a third backend is a self-contained change that does not touch the dispatch pipeline.

**Why this priority**: The interface and registry are the structural backbone for US3 and US4. Both backends compile against the interface; the dispatch action looks up the selected backend through the registry; no other story can be tested in its final form until the interface exists.

**Independent Test**: Add a fixture backend to the registry in a unit test and verify the dispatch action looks it up by name through the public registry surface, without modifying any other module. Verify the `SpawnBackend` interface declares exactly four members (`name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`) and no others.

**Acceptance Scenarios**:

1. **Given** the codebase compiles, **When** a developer reads the `SpawnBackend` interface, **Then** it declares exactly four members: `name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`. No `validateAuth`, no `parseExitCode`, no `cliCommand`.
2. **Given** the registry, **When** the dispatch action calls a registry lookup with a known backend name, **Then** the registry returns the corresponding `SpawnBackend` implementation.
3. **Given** the registry, **When** the dispatch action calls the lookup with an unknown name, **Then** the lookup signals "not found" without throwing — leaving the dispatch action free to format the user-facing `USAGE_ERROR` consistently with US1.
4. **Given** the registry, **When** a developer enumerates registered backend names for help output and error messages, **Then** an enumeration surface (e.g., `listBackends()` or equivalent) is available without leaking implementation objects.
5. **Given** a backend's `buildEntrypoint(promptFilePath)` is called, **Then** it returns the argv that `docker run` will exec inside the container, parameterized on the in-container prompt file path. The argv is a `string[]` matching the existing `LaunchSpawnContainerInput` shape.

---

### User Story 3: Claude Code Backend (Refactor with Behavioral Preservation) (Priority: P1)

As a March maintainer, I want the existing hardcoded Claude Code dispatch path to be extracted into a registered `SpawnBackend` implementation without changing observable dispatch behavior, so that the F2 acceptance scenarios remain green and serve as the regression backstop for the refactor.

**Why this priority**: The interface only earns its keep when both backends compile against it. Without US3, US2's interface is speculative — any "polymorphism works" claim must be proven by a real implementation that preserves the F2 contract.

**Independent Test**: Run `march spawn dispatch --backend claude-code --prompt-file <path>` (or with no flag, since `claude-code` is the default) and verify the constructed `docker run` argv, generated Dockerfile `FROM` line, and forwarded environment-variable list match F2's hardcoded behavior exactly. F2's existing acceptance tests (US1–US7 in `spawn-dispatch.spec.md`) pass without modification.

**Acceptance Scenarios**:

1. **Given** the Claude Code backend is registered, **When** the dispatch action invokes `claudeCodeBackend.buildEntrypoint("/march/prompt.txt")`, **Then** it returns `["sh", "-c", "claude -p \"$(cat /march/prompt.txt)\" --output-format json --dangerously-skip-permissions --bare --no-session-persistence"]` — character-identical to F2's `buildClaudeCodeEntrypoint(CONTAINER_PROMPT_PATH)`.
2. **Given** the Claude Code backend is registered, **When** the dispatch pipeline reads `claudeCodeBackend.baseImage`, **Then** the value is `"march-base:latest"`.
3. **Given** the Claude Code backend is registered, **When** the dispatch pipeline reads `claudeCodeBackend.requiredEnvVars`, **Then** the value is `["ANTHROPIC_API_KEY"]`.
4. **Given** the Claude Code backend is registered, **When** the operator runs `march spawn dispatch --prompt-file <path>` (no flag, default backend), **Then** F2's existing acceptance scenarios for US3–US7 (worktree, snapshot, launch, prompt handoff, lifecycle) continue to hold — same image tag, same container name, same env-flag composition, same entrypoint argv.
5. **Given** the registry exposes the Claude Code backend, **When** a developer reads its `name` field, **Then** the value is `"claude-code"` — the same string F2 already writes to `SpawnRecord.backend`.

---

### User Story 4: Gemini CLI Backend (Priority: P1)

As an operator, I want a registered Gemini backend so that I can dispatch a spawn against a Gemini base image and have the dispatch pipeline forward `GEMINI_API_KEY`, build the right Dockerfile `FROM` line, and exec the Gemini CLI with the correct headless flags.

**Why this priority**: Gemini is the second validated backend the RFC commits to. Without US4, the multi-backend story remains theoretical and the interface has only one implementation — single-implementation interfaces routinely leak the implementation's idiosyncrasies.

**Independent Test**: Run `march spawn dispatch --backend gemini --prompt-file <path>` with `GEMINI_API_KEY` set. Verify the Dockerfile `FROM` line uses `march-gemini-base:latest`, the container's env whitelist is `["GEMINI_API_KEY"]`, and the entrypoint argv invokes the Gemini CLI with `--prompt`, `--approval-mode=yolo`, and `--output-format json` (and **no** `--sandbox=docker`).

**Acceptance Scenarios**:

1. **Given** the Gemini backend is registered, **When** the dispatch action invokes `geminiBackend.buildEntrypoint("/march/prompt.txt")`, **Then** it returns `["sh", "-c", "gemini --prompt \"$(cat /march/prompt.txt)\" --approval-mode=yolo --output-format json"]`. No `--sandbox=docker` flag is present.
2. **Given** the Gemini backend is registered, **When** the dispatch pipeline reads `geminiBackend.baseImage`, **Then** the value is `"march-gemini-base:latest"`.
3. **Given** the Gemini backend is registered, **When** the dispatch pipeline reads `geminiBackend.requiredEnvVars`, **Then** the value is `["GEMINI_API_KEY"]`.
4. **Given** the operator runs `march spawn dispatch --backend gemini --prompt-file <path>` with `GEMINI_API_KEY` set and the Gemini base image available, **Then** dispatch proceeds end-to-end: a worktree is created, the Dockerfile uses the Gemini base image, the container is launched with only `GEMINI_API_KEY` in its env whitelist, and the entrypoint exec's the Gemini CLI.
5. **Given** the registry exposes the Gemini backend, **When** a developer reads its `name` field, **Then** the value is `"gemini"`.

---

### User Story 5: Per-Backend Image and Env Derivation in the Dispatch Pipeline (Priority: P1)

As a March maintainer, I want the dispatch pipeline to derive the base image and env-var whitelist from the *selected* backend (not from a global constant), so that the three F2 call sites that hardcode `BASE_IMAGE` and `SPAWN_CONFIG.envWhitelist` collapse to a single backend-driven source of truth.

**Why this priority**: Without US5, US3 and US4 cannot coexist in the dispatch pipeline — the pre-flight image check, the Dockerfile `FROM` line, and the container's env-flag composition would still force every spawn through the Claude Code base image and the Claude Code env whitelist. Closes scout conflicts #1 (`BASE_IMAGE` referenced in three places), #2 (`envWhitelist` hardcoded), #3 (`launchSpawnContainer` has no backend parameter), and #4 (the dependency-check call site in `cli.ts` hardcodes `BASE_IMAGE`).

**Independent Test**: Switching the selected backend changes which image is checked at dispatch start, which `FROM` line appears in the generated Dockerfile, and which `-e` flags are emitted on `docker run` — without any other module needing to change.

**Acceptance Scenarios**:

1. **Given** the dispatch action has resolved a backend, **When** the dependency check runs at the start of `march spawn dispatch`, **Then** the check verifies `selectedBackend.baseImage` is available locally or pullable — not a global `BASE_IMAGE` constant.
2. **Given** the dispatch action has resolved a backend, **When** the Snapshot stage generates the spawn's Dockerfile, **Then** the Dockerfile's `FROM` line is `selectedBackend.baseImage`.
3. **Given** the dispatch action has resolved a backend, **When** the Launch stage composes `docker run` flags, **Then** the env-flag composition iterates `selectedBackend.requiredEnvVars` and emits one `-e <VAR>` passthrough per entry. No other backend's env vars are emitted, even if they happen to be set in the operator's host environment.
4. **Given** the `SpawnConfig` interface, **When** a developer inspects its fields, **Then** `envWhitelist` is no longer present. Only security/resource posture fields remain (`capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`).
5. **Given** the codebase compiles, **When** a developer searches for the `BASE_IMAGE` constant, **Then** no surviving references force every spawn through one image. The dependency-check call site in `cli.ts`, the Dockerfile `FROM` line in `snapshot-build.ts`, and any test fixtures that pinned the literal image tag have been redirected to read from the resolved backend or from the appropriate per-backend test setup.

---

### User Story 6: Per-Backend Auth Pre-Flight Validation (Priority: P1)

As an operator, I want the dispatch action to verify my host environment has the selected backend's required auth env vars before any worktree, image, or container work begins, so that a missing `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` produces a clean, fast error rather than a cryptic in-container failure after a wasted snapshot/build.

**Why this priority**: Gemini's introduction makes per-backend env validation a real requirement. F2 deferred this check to F4 (per the deferred auth pre-flight comment in `container-launch.ts`) because F2 only had one possible env var and the failure mode was discoverable. F3 has two possible env vars, so the same failure now becomes ambiguous to the operator unless caught up-front. F4 still owns network-policy and threat-model hardening; the env-presence check belongs to F3 because F3 introduces the divergence.

**Independent Test**: Unset `GEMINI_API_KEY` and run `march spawn dispatch --backend gemini --prompt-file <path>`. The command exits with `USAGE_ERROR` (2), the error message names the backend (`gemini`) and the missing variable (`GEMINI_API_KEY`), and no spawn-scoped artifacts are produced (no worktree, no branch, no snapshot image, no container). The base image may or may not be present on the host cache depending on Stage 1's outcome; that is independent of the auth pre-flight.

**Acceptance Scenarios**:

1. **Given** the operator runs `march spawn dispatch --backend gemini --prompt-file <path>` with `GEMINI_API_KEY` unset, **When** the dispatch action runs the auth pre-flight, **Then** the command exits with `USAGE_ERROR` (2), prints `"Backend 'gemini' requires GEMINI_API_KEY: missing GEMINI_API_KEY. Set the variable(s) and re-run."` (or equivalently structured), and no spawn-scoped artifacts (worktree, branch, snapshot image, container) have been created.
2. **Given** the auth pre-flight runs, **When** any required env var is present but empty, **Then** the variable is treated as missing (empty-string env vars are not valid auth credentials).
3. **Given** the auth pre-flight runs, **When** all required env vars are present and non-empty, **Then** the check passes silently and dispatch proceeds.
4. **Given** the auth pre-flight runs, **Then** it executes BEFORE Stage 2 (Worktree) of the F2 dispatch pipeline. It runs after Stage 1 (Validate — git/docker/base-image dependency check) so that "missing dependency" and "missing auth env var" produce clearly separated error messages.
5. **Given** the auth pre-flight error message is rendered, **Then** it reports presence/absence by variable name only — the value is never echoed and no prefix of the value appears in any log or error output.

---

### User Story 7: SpawnRecord Backend Traceability (Priority: P2)

As an operator (and Feature 6 — PR Integration — as a downstream consumer), I want `SpawnRecord.backend` to reflect the *actually-selected* backend rather than always being `"claude-code"`, so that on-disk records correctly identify which backend ran each spawn.

**Why this priority**: F2 already wires the `backend` field on `SpawnRecord` (the `DEFAULT_BACKEND` constant in `src/spawn-record.ts`) but always populates it with `"claude-code"` — which is correct as long as Claude Code is the only backend. Once F3 ships Gemini, the field becomes incorrect for any Gemini-backed spawn. P2 because it is a write-only fix on new dispatches; F2-era records on disk are not retroactively corrected.

**Independent Test**: Run `march spawn dispatch --backend gemini --prompt-file <path>`. After the spawn completes, read the SpawnRecord at `~/.march/spawns/<id>.json` and verify `backend: "gemini"`. Run a second dispatch with `--backend claude-code` (or no flag) and verify the resulting record has `backend: "claude-code"`.

**Acceptance Scenarios**:

1. **Given** the operator dispatches a spawn with `--backend gemini`, **When** the initial SpawnRecord is written at dispatch start, **Then** the record's `backend` field is `"gemini"`.
2. **Given** the operator dispatches a spawn with `--backend claude-code` (or no flag, default), **When** the initial SpawnRecord is written, **Then** the record's `backend` field is `"claude-code"`.
3. **Given** existing on-disk SpawnRecords written by F2 (with `backend: "claude-code"` hardcoded), **When** F3 lands, **Then** those records are not back-filled or rewritten. They remain with their original (correct, since F2 only ran Claude Code) `backend` value.
4. **Given** the SpawnRecord schema, **When** F3 lands, **Then** `version` remains `1`. No new fields are added; only the population of the existing `backend` field changes.

### Edge Cases

- Operator has both `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` set and selects Gemini: only `GEMINI_API_KEY` is forwarded into the container; `ANTHROPIC_API_KEY` is never present in the sandbox even as a passthrough.
- Operator selects a backend whose base image is not available locally and not pullable: the Stage 1 dependency check fails with the same error path as F2, except the error message names the per-backend image tag rather than a global `BASE_IMAGE`.
- Operator sets `MARCH_BACKEND=` (empty string) and provides no `--backend` flag: empty string is treated as unset, default backend (`claude-code`) is selected.
- Operator sets `MARCH_BACKEND=Gemini` (uppercase G): exact-string match by registry key. Matching is case-sensitive — `"Gemini"` is rejected as unknown. The error message points the operator at the supported names list (which uses lowercase).
- Help output for `march spawn dispatch --help` enumerates the registered backends so the supported names are discoverable without reading source.
- A future contributor adds a duplicate-named backend to the registry: the registry rejects duplicate names at construction time; this is a coding error caught by the developer's local test run, not an operator-facing concern.
- The operator runs `march spawn dispatch --backend claude-code --prompt-file <path>` after F3 lands, intending to verify the refactor preserved F2 behavior: the constructed `docker run` argv is byte-identical to the F2 invocation; F2 acceptance tests pass unchanged.
- A future Hatchery (M2) profile selects a backend implicitly: M2 will layer profile-driven selection on top of F3's `--backend` primitive. No coexistence design is needed in M1; F3's primitive remains correct under M2's overlay.
- An operator provides `--backend gemini` while running on a host where the Gemini base image was published but the operator has never set `GEMINI_API_KEY`: dispatch fails at the auth pre-flight (US6), not at the dependency check. The error attributes the failure to the missing env var, not the backend image.

## Dependency Order

| ID  | Title                                                          | Depends On | Artifact |
|-----|----------------------------------------------------------------|------------|----------|
| US2 | SpawnBackend Interface and Registry                            | —          | specs/2026-05-10-003-multi-backend-execution-interface/02-spawnbackend-interface-and-registry.tasks.md |
| US3 | Claude Code Backend (Refactor with Behavioral Preservation)    | US2        | specs/2026-05-10-003-multi-backend-execution-interface/03-claude-code-backend-refactor-with-behavioral-preservation.tasks.md |
| US4 | Gemini CLI Backend                                             | US2, US3   | specs/2026-05-10-003-multi-backend-execution-interface/04-codex-cli-backend.tasks.md |
| US5 | Per-Backend Image and Env Derivation in the Dispatch Pipeline  | US3, US4   | specs/2026-05-10-003-multi-backend-execution-interface/05-per-backend-image-and-env-derivation-in-the-dispatch-pipeline.tasks.md |
| US1 | Backend Selection at Dispatch Time                             | US5        | —        |
| US6 | Per-Backend Auth Pre-Flight Validation                         | US1        | —        |
| US7 | SpawnRecord Backend Traceability                               | US1        | —        |

## Requirements

### Functional Requirements

- **FR-001**: `march spawn dispatch` MUST accept a `--backend <name>` option whose value selects the backend implementation used for the dispatch.
- **FR-002**: When `--backend` is not provided, `march spawn dispatch` MUST consult the `MARCH_BACKEND` environment variable; if neither is set or the env var is empty, the default backend MUST be `claude-code`.
- **FR-003**: When both `--backend` and `MARCH_BACKEND` are set with conflicting values, the `--backend` flag MUST win.
- **FR-004**: When the selected backend name (from either source) is not registered, `march spawn dispatch` MUST exit with `USAGE_ERROR` (2). The error message MUST name the rejected value, identify its source (`--backend` flag or `MARCH_BACKEND` env var), and list the supported backend names.
- **FR-005**: A `SpawnBackend` interface MUST be defined with exactly four members: `name: string`, `baseImage: string`, `requiredEnvVars: readonly string[]`, and `buildEntrypoint(promptFilePath: string): readonly string[]`. No `validateAuth`, `parseExitCode`, `cliCommand`, or other members are added in F3.
- **FR-006**: A backend registry MUST expose a lookup-by-name function that returns the `SpawnBackend` implementation or signals "not found", and an enumeration surface that returns the registered backend names for help output and error messages.
- **FR-007**: A `claudeCodeBackend` MUST be registered with `name = "claude-code"`, `baseImage = "march-base:latest"`, `requiredEnvVars = ["ANTHROPIC_API_KEY"]`, and a `buildEntrypoint` that returns argv character-identical to F2's `buildClaudeCodeEntrypoint(CONTAINER_PROMPT_PATH)`.
- **FR-008**: A `geminiBackend` MUST be registered with `name = "gemini"`, `baseImage = "march-gemini-base:latest"`, `requiredEnvVars = ["GEMINI_API_KEY"]`, and a `buildEntrypoint` that returns `["sh", "-c", "gemini --prompt \"$(cat <promptFilePath>)\" --approval-mode=yolo --output-format json"]` (with the placeholder substituted at call time). The entrypoint MUST NOT include `--sandbox=docker`.
- **FR-009**: The dispatch pipeline's Stage 1 (Validate) dependency check MUST verify the *selected* backend's `baseImage` is available, not a global `BASE_IMAGE` constant.
- **FR-010**: The dispatch pipeline's Stage 3 (Snapshot) MUST generate a Dockerfile whose `FROM` line is the selected backend's `baseImage`.
- **FR-011**: The dispatch pipeline's Stage 4 (Launch) MUST compose the `docker run` env-flag list by iterating the selected backend's `requiredEnvVars` and emitting one `-e <VAR>` passthrough per entry. No env vars belonging to non-selected backends MAY be forwarded.
- **FR-012**: The `SpawnConfig` type MUST be narrowed to security/resource posture fields only: `capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`. The `envWhitelist` field MUST be removed; its responsibility moves wholly to `SpawnBackend.requiredEnvVars`.
- **FR-013**: An auth pre-flight check MUST execute in the dispatch action *before* Stage 2 (Worktree), iterating the selected backend's `requiredEnvVars` against `process.env`. Each variable that is unset, or set to an empty string, counts as missing.
- **FR-014**: When the auth pre-flight detects any missing required env var, the command MUST exit with `USAGE_ERROR` (2), print a clear error naming the backend and each missing variable, and produce no spawn-scoped artifacts (worktree, branch, snapshot image, or container). A base image already pulled by the Stage 1 dependency check is a host-level cache entry, not a spawn-scoped artifact, and is intentionally retained.
- **FR-015**: The auth pre-flight error message MUST report missing variables by name only. The value of any present-but-empty variable MUST NOT be echoed, and no prefix of any env-var value MAY appear in any log or error output.
- **FR-016**: `writeInitialSpawnRecord` MUST receive the resolved backend's `name` as the `backend` input; the on-disk SpawnRecord's `backend` field MUST reflect the actually-selected backend.
- **FR-017**: F2 acceptance scenarios for the dispatch pipeline MUST continue to hold under F3 with `--backend claude-code` (or no flag): same image, same env-flag composition, same entrypoint argv, same SpawnRecord shape (modulo the `backend` field, which now reflects the selected name rather than the F2 hardcode).

### Key Entities

- **SpawnBackend**: First-class entity for F3, promoted from the F2 contracts.md interface boundary stub. Defines the four-member contract that every backend implementation must satisfy: `name`, `baseImage`, `requiredEnvVars`, `buildEntrypoint`. Two implementations registered in F3: `claudeCodeBackend` and `geminiBackend`.
- **Backend Registry**: A name-keyed lookup of registered `SpawnBackend` instances. Exposes name-based retrieval and an enumeration surface for help output and error messages. Internal to F3; not user-extensible.
- **SpawnConfig (narrowed)**: F2's compile-time security/resource posture constant, with `envWhitelist` removed. Retains `capDrop`, `user`, `networkMode`, `memoryLimit`, `cpuLimit`, `timeoutSeconds`. Hatchery (M2) replaces this constant with declarative per-profile configuration.
- **SpawnRecord (unchanged shape)**: The existing `backend` field is now meaningfully populated from the selected backend's name. Schema version stays at `1`; no field additions.

## Assumptions

- The `march-gemini-base:latest` image is provisioned externally (operations), mirroring the existing `march-base:latest` contract from F2. F3 references the tag but does not build the image.
- The `SpawnBackend` interface promoted in F3 is the canonical dispatch contract and stays at four members through M1. Any future need for `validateAuth`, `parseExitCode`, or `BackendCapabilities` is a new feature, not an interface extension within this milestone.
- The dispatch pipeline's Stage 1 dependency check (`checkSpawnDependencies(baseImage)`) keeps its existing parametric signature; only the call site in `cli.ts` changes (passes `selectedBackend.baseImage` instead of the imported `BASE_IMAGE` constant).
- The auth pre-flight check is a derivable loop in the dispatch action, not a method on `SpawnBackend`. If a future backend requires non-env-var auth (token files, OAuth flows), lifting the check onto the interface is a separate feature.
- Resource limits remain Claude-Code-sized (`memoryLimit = "4g"`, `cpuLimit = "2"`, `timeoutSeconds = 3600`) and shared across backends in F3. Per-backend resource sizing is Hatchery's (M2) job.
- F4 (Spawn Sandbox Security) owns network-policy hardening per backend, including any per-backend allowlist of API endpoints. F3 leaves the network mode at `bridge` (F2's posture) and does not introduce per-backend network configuration.
- The empty-env-var-treated-as-missing rule (FR-013) applies only at the pre-flight check; if the operator legitimately needs to pass a literal empty string into the container, F3 does not support that — it is not a documented spawn workflow.

## Specification Debt

| ID     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Source Category         | Impact | Confidence | Status | Resolution |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------|--------|------------|--------|------------|
| SD-001 | `envWhitelist` field removal vs. retention on `SpawnConfig` interface — FR-012 says drop it entirely, but US3 says "F2 tests pass unchanged." Removing the field will break any F2 unit test that asserts on `SPAWN_CONFIG.envWhitelist` (the existing assertion lives in `src/spawn-config.test.ts`; locate it by searching for `envWhitelist`). The reconciled position is: remove the field and redirect F2 unit assertions to read from `claudeCodeBackend.requiredEnvVars`. End-to-end behavioral preservation holds; literal test-source preservation does not. | Domain & Data Model     | High   | Medium     | open   | —          |
| SD-002 | Whether F2's existing test suite passes literally unchanged, or whether structural assertions touching `envWhitelist` need redirection to the new backend object. The reconciled plan's "byte-for-byte F2 preservation" likely means *behavioral* preservation only. Needs explicit confirmation before US3 (Claude Code Backend) is decomposed into tasks, since the tasks file scope changes materially based on the answer.                                                                                              | Functional Scope        | High   | Medium     | open   | —          |

## Out of Scope

- **OAuth / Claude-Max session auth** — RFC Appendix C4's flat-rate cost model. Mounting `~/.claude/` read-only conflicts with F4's no-host-filesystem-access posture; extracting the session token format is unstable per RFC C6. Deferred to a follow-on feature once F4's threat model is settled.
- **`parseExitCode` on the `SpawnBackend` interface** — Exit-code interpretation belongs to F5 (Spawn Output Extraction). F3's interface stays at four members.
- **`BackendCapabilities` map** — Capability divergence between backends (streaming-output support, cost tracking, model selection metadata) is not present in F3. Deferred until a future feature actually needs to read or branch on it.
- **Per-backend resource limits / timeouts** — `memoryLimit`, `cpuLimit`, `timeoutSeconds` stay shared across backends in F3. Hatchery (M2) makes them editable per profile.
- **Gemini `--sandbox=docker` (Docker-in-Docker)** — RFC Appendix B6's open question, settled in F3 as: omit. The outer March container provides the only isolation layer.
- **Per-backend network policy / outbound-traffic hardening** — F4 (Spawn Sandbox Security) owns network-policy mitigations, including any per-backend allowlist of API endpoints (Gemini's API, `api.anthropic.com`).
- **Plugin-style runtime backend loading** — Backends are statically registered in F3. Dynamic backend loading from a plugin directory is a security surface that F4 would need to evaluate; not in M1 scope.
- **Local / self-hosted LLM backends (Ollama, etc.)** — Excluded by the RFC at the milestone level; F3 does not relax that exclusion.
- **Agent SDK programmatic backend interface** — Per the RFC and the F3 feature-map scope boundaries, the Agent SDK alternative (RFC Appendix C8) is deferred to M3+.
- **Retroactive correction of F2-era SpawnRecords** — Records on disk written by F2 keep their `backend: "claude-code"` value. F3 fixes forward only.
- **Operator-configurable default backend in `~/.march/config`** — Hatchery (M2) owns persistent operator configuration. F3's defaults are: flag, then env var, then a built-in `claude-code` default.

## Success Criteria

### Measurable Outcomes

- **SC-001**: An operator can run `march spawn dispatch --backend gemini --prompt-file <path>` end-to-end on a host where `march-gemini-base:latest` is available and `GEMINI_API_KEY` is set, producing a Gemini-backed SpawnRecord with `backend: "gemini"`.
- **SC-002**: An operator can run `march spawn dispatch --prompt-file <path>` (no flag) and observe behavior byte-identical to F2: same image (`march-base:latest`), same env-flag composition (`-e ANTHROPIC_API_KEY`), same entrypoint argv. F2's existing acceptance scenarios remain green.
- **SC-003**: With `GEMINI_API_KEY` unset, `march spawn dispatch --backend gemini --prompt-file <path>` exits with `USAGE_ERROR` (2), names the backend and the missing variable, and creates no spawn-scoped artifacts (worktree, branch, snapshot image, or container).
- **SC-004**: With `--backend nonexistent` (or `MARCH_BACKEND=nonexistent`), `march spawn dispatch` exits with `USAGE_ERROR` (2), identifies the source of the rejected value, and lists the supported backend names.
- **SC-005**: The `SpawnBackend` interface declares exactly four members. A grep over `src/backends/` and consumer modules surfaces no `validateAuth`, `parseExitCode`, or `cliCommand` references on the interface.
- **SC-006**: The `BASE_IMAGE` constant is no longer referenced by the dispatch pipeline. The dependency-check call site in `cli.ts`, the Dockerfile `FROM` line in `snapshot-build.ts`, and any test fixtures that pinned the literal image tag have been redirected to read from the resolved backend or per-backend test setup.
- **SC-007**: The `SpawnConfig` type contains only security/resource posture fields. `envWhitelist` does not appear; the env-flag composition reads from `selectedBackend.requiredEnvVars` instead.
- **SC-008**: SpawnRecords written after F3 lands accurately reflect the selected backend in the `backend` field. F2-era records on disk are unchanged.
- **SC-009**: Dispatching a Gemini spawn with `ANTHROPIC_API_KEY` set on the host (but `GEMINI_API_KEY` also set) produces a container whose env contains *only* `GEMINI_API_KEY` — no leakage of the unselected backend's key (verifiable via `docker inspect`).
