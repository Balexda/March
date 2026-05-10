# Contracts: Multi-Backend Execution Interface

## Overview

This document defines the interface contracts F3 introduces or modifies: the `SpawnBackend` interface (promoted from F2's stub), the backend registry, the `--backend` CLI surface and its env-var fallback, the per-backend auth pre-flight, and the dispatch-pipeline integration points (Stage 1 image check, Stage 3 Dockerfile `FROM`, Stage 4 env-flag composition, Stage 7 record population). Existing F2 contracts that F3 supersedes are noted explicitly so the F2 contracts file's forward-pointers (the SpawnBackend Interface (extension contract) section of `spawn-dispatch.contracts.md`) resolve correctly.

## Interfaces

### march spawn dispatch (extended)

**Purpose**: Extend F2's dispatch CLI surface with backend selection.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march spawn dispatch [--backend <name>] --prompt-file <path> [options]
march spawn dispatch [--backend <name>] --prompt <string> [options]
cat prompt.txt | march spawn dispatch [--backend <name>] [options]
```

`MARCH_BACKEND=<name>` may be set in the operator's environment as a fallback when `--backend` is not provided.

#### Inputs (F3 additions)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--backend` | string | No | Backend identifier; must match a registered backend name. Wins over `MARCH_BACKEND`. |
| `MARCH_BACKEND` (env) | string | No | Fallback backend identifier. Used only when `--backend` is absent or unset. Empty string is treated as unset. |

Inputs from F2 (`--prompt-file`, `--prompt`, stdin, `--base`) are unchanged.

Resolution order: `--backend` flag > `MARCH_BACKEND` env var > `defaultBackendName` constant (`"claude-code"`).

#### Outputs (F3 additions)

| Effect | Location | Description |
|--------|----------|-------------|
| Backend recorded | `~/.march/spawns/<spawn-id>.json` | The `backend` field on the SpawnRecord reflects the resolved backend's `name`. |

All other F2 outputs (worktree, branch, image, container, status print) are unchanged.

#### Error Conditions (F3 additions)

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| Unknown backend (from `--backend` flag) | 2 (USAGE_ERROR) | Error names the rejected value, identifies `--backend` flag as the source, and lists registered backend names. |
| Unknown backend (from `MARCH_BACKEND` env var) | 2 (USAGE_ERROR) | As above, but the source attribution is `MARCH_BACKEND env var`. |
| Selected backend's `requiredEnvVars` not all set in operator's environment | 2 (USAGE_ERROR) | Auth pre-flight failure. Error names the backend and each missing variable. Runs BEFORE Stage 2 (Worktree); no worktree, branch, image, or container is created. |
| Selected backend's `baseImage` not available | 1 | Stage 1 dependency check (existing F2 contract); error message names the per-backend image rather than a global `BASE_IMAGE`. |

All other F2 error conditions are unchanged.

---

### SpawnBackend (formalized contract)

**Purpose**: Promote F2's interface-boundary stub into the canonical, polymorphic dispatch contract every backend implementation satisfies.
**Consumers**: The dispatch action and its pipeline stages (Validate, Snapshot, Launch); the auth pre-flight check; the SpawnRecord write step.
**Providers**: F3 ships two implementations: `claudeCodeBackend` and `geminiBackend`. Future features may add more implementations behind the same interface.

#### Interface (closed at four members in F3)

```typescript
interface SpawnBackend {
  /** Registry key. Matches the `--backend` flag value, the
   *  `MARCH_BACKEND` env-var value, and the `backend` field on
   *  SpawnRecord. */
  readonly name: string;

  /** Docker image tag containing this backend's CLI pre-installed. */
  readonly baseImage: string;

  /** Names of host environment variables that must be set (and
   *  non-empty) before the spawn can run. Forwarded into the
   *  container as `-e <VAR>` passthroughs. */
  readonly requiredEnvVars: readonly string[];

  /** Returns the `docker run` exec argv that runs this backend's
   *  CLI inside the container against the given in-container
   *  prompt-file path. Implementations are expected to use an
   *  `sh -c` wrapper if shell expansion is needed. */
  buildEntrypoint(promptFilePath: string): readonly string[];
}
```

No `validateAuth`, no `parseExitCode`, no `cliCommand`. The interface is deliberately closed at these four members; backends with non-env-var auth or differing exit-code semantics motivate a separate feature, not an in-place extension.

#### Concrete Implementations

**`claudeCodeBackend`**

| Member | Value |
|--------|-------|
| `name` | `"claude-code"` |
| `baseImage` | `"march-base:latest"` |
| `requiredEnvVars` | `["ANTHROPIC_API_KEY"]` |
| `buildEntrypoint(p)` | `["sh", "-c", \`claude -p "$(cat ${p})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence\`]` |

The entrypoint argv is character-identical to F2's `buildClaudeCodeEntrypoint(p)` in `src/container-launch.ts`. Behavioral preservation is part of US3's acceptance contract.

**`geminiBackend`**

| Member | Value |
|--------|-------|
| `name` | `"gemini"` |
| `baseImage` | `"march-gemini-base:latest"` |
| `requiredEnvVars` | `["GEMINI_API_KEY"]` |
| `buildEntrypoint(p)` | `["sh", "-c", \`gemini --prompt "$(cat ${p})" --approval-mode=yolo --output-format json\`]` |

The entrypoint **does not** include `--sandbox=docker` — settling RFC Appendix B6's open question. The outer March container provides the only isolation layer.

---

### Backend Registry (internal contract)

**Purpose**: Resolve operator selection (CLI flag → env var → default) into a registered `SpawnBackend`, and enumerate registered names for help output and error messages.
**Consumers**: The dispatch action (`cli.ts`).
**Providers**: A registry module under `src/backends/` (or an analogous location consistent with the codebase's modular pattern).

#### Operations

| Operation | Signature | Notes |
|-----------|-----------|-------|
| Lookup by name | `getBackend(name: string): SpawnBackend \| undefined` | Returns the registered backend or `undefined`. The dispatch action formats the user-facing error when `undefined` is returned (so all error wording stays in one place). |
| Enumerate names | `listBackends(): readonly string[]` | Stable, deterministic order. Used by `--help` text and the unknown-backend error message. |
| Default name | `defaultBackendName: string` | Constant. Value: `"claude-code"`. Replaces F2's `DEFAULT_BACKEND` in `spawn-record.ts`. |

#### Registration

Backends are registered statically (compile-time map) in F3. No runtime registration mechanism is exposed; F3's two backends are the entire registry contents.

The registry construction rejects duplicate `name` entries — a coding-error guard surfaced via developer-side tests, not an operator-facing path.

---

### Auth Pre-Flight (internal contract)

**Purpose**: Verify the selected backend's required env vars are set on the host before any worktree, image, or container work begins.
**Consumers**: The dispatch action (`cli.ts`), runs after Stage 1 (Validate) and before Stage 2 (Worktree).
**Providers**: A small derivable function in the dispatch action; not a method on `SpawnBackend`.

#### Algorithm

```
for each var in selectedBackend.requiredEnvVars:
  if process.env[var] is undefined or "":
    record `var` as missing
if any missing:
  print "Backend '<name>' requires <vars>: missing <missing-list>. Set the variable(s) and re-run."
  exit USAGE_ERROR (2)
```

#### Error message format

```
Backend '<name>' requires <comma-separated requiredEnvVars>: missing <comma-separated missing>. Set the variable(s) and re-run.
```

The values of present-but-empty env vars are never echoed; no prefix of any value appears in any log or error output.

---

### Dispatch Pipeline Integration (modified contract)

**Purpose**: Define how F3 changes F2's `Validate → Worktree → Snapshot → Launch → Handoff → Wait → Record` pipeline.
**Consumers**: The `march spawn dispatch` command implementation.
**Providers**: Internal modules under `src/`.

#### Stage-by-stage F3 changes

| Stage | F2 Behavior | F3 Change |
|-------|-------------|-----------|
| 0. Resolve backend (new sub-stage before Stage 1) | (n/a) | Read `--backend` flag and `MARCH_BACKEND` env var, fall back to `defaultBackendName`. Look up via `getBackend(name)`. Unknown name → `USAGE_ERROR` (2). |
| 1. Validate | `checkSpawnDependencies(BASE_IMAGE)` — global constant. | `checkSpawnDependencies(selectedBackend.baseImage)`. Same function signature; only the call site in `cli.ts` changes. |
| 1.5. Auth Pre-Flight (new) | (n/a) | Iterate `selectedBackend.requiredEnvVars` against `process.env`. Missing or empty → `USAGE_ERROR` (2). |
| 2. Worktree | (per F2) | Unchanged. |
| 3. Snapshot | Generated Dockerfile's `FROM` line is `BASE_IMAGE`. | `FROM` line is `selectedBackend.baseImage`. |
| 4. Launch | Env-flag composition iterates `SPAWN_CONFIG.envWhitelist` (`["ANTHROPIC_API_KEY"]`). Entrypoint is `buildClaudeCodeEntrypoint(CONTAINER_PROMPT_PATH)`. | Env-flag composition iterates `selectedBackend.requiredEnvVars`. Entrypoint is `selectedBackend.buildEntrypoint(CONTAINER_PROMPT_PATH)`. `LaunchSpawnContainerInput` gains a `backend: SpawnBackend` field. |
| 5. Handoff | (per F2) | Unchanged — the prompt file write to `CONTAINER_PROMPT_PATH` is backend-independent. |
| 6. Wait | (per F2) | Unchanged. |
| 7. Record | `writeInitialSpawnRecord({..., backend: DEFAULT_BACKEND})` always writes `"claude-code"`. | `writeInitialSpawnRecord({..., backend: selectedBackend.name})` — reflects the actually-selected backend. |

#### Cleanup ordering

Unchanged from F2. Cleanup runs in reverse order (container → image → worktree+branch). Auth pre-flight failures (Stage 1.5) produce no artifacts; nothing to clean up.

---

### LaunchSpawnContainerInput (modified contract)

**Purpose**: Define how the dispatch action communicates per-spawn launch parameters to `launchSpawnContainer`.
**Consumers**: `launchSpawnContainer` in `src/container-launch.ts`.
**Providers**: The dispatch action.

#### Shape change

| Field | F2 | F3 |
|-------|----|----|
| `spawnId` | `string` (required) | `string` (required, unchanged). |
| `backend` | (n/a) | `SpawnBackend` (required, new). The function reads `backend.requiredEnvVars` for env-flag composition and `backend.buildEntrypoint(...)` for the container entrypoint argv, replacing the hardcoded references to `SPAWN_CONFIG.envWhitelist` and `buildClaudeCodeEntrypoint(...)`. |

#### Behavioral guarantee

`launchSpawnContainer` MUST NOT reference any backend-specific module directly. All per-backend behavior flows through the `backend` parameter. This is the structural test for US2's polymorphism claim: a fixture `SpawnBackend` registered at test time can drive `launchSpawnContainer` end-to-end.

---

### F2 Contract Resolutions

F2's `spawn-dispatch.contracts.md` contains forward-pointers F3 resolves:

| F2 Section | F2 Forward-Pointer | F3 Resolution |
|------------|--------------------|---------------|
| SpawnBackend Interface (extension contract) section | "Feature 3 will: 1. Add Gemini implementation … 2. Add backend selection … 3. May extend the interface with additional methods (e.g., `parseExitCode`, `validateAuth`)." | Items 1 and 2: implemented as US4 and US1 respectively. Item 3: rejected. The interface stays at four members. `parseExitCode` deferred to F5; `validateAuth` is a derivable check in the dispatch action, not a method. |
| Snapshot Exclusion List section | "This list is hardcoded in Feature 2. Feature 4 may expand it based on threat model evaluation. Hatchery (M2) makes it configurable per profile." | Unchanged by F3. F3 does not touch the exclusion list. |
| `spawn-dispatch.data-model.md` Entity 3 ("SpawnBackend interface boundary") | "Feature 2 ships with a single hardcoded implementation (Claude Code CLI). Feature 3 replaces the hardcoded implementation with a polymorphic interface supporting multiple backends." | Implemented per Entity 1 of `multi-backend-execution-interface.data-model.md`. |
| Container Launch template section | `<backend-entrypoint-command>` constructed by `SpawnBackend.buildEntrypoint()`. | Realized: the template's `<backend-entrypoint-command>` is now literally `selectedBackend.buildEntrypoint(CONTAINER_PROMPT_PATH)`. The `--user`, `--cap-drop=ALL`, `--memory`, `--cpus`, and `--network` flags continue to come from `SpawnConfig`. The `-e <VAR>` passthrough flags now come from `selectedBackend.requiredEnvVars` rather than `SPAWN_CONFIG.envWhitelist`. |
| `container-launch.ts` (the deferred auth pre-flight comment) | F4 was assigned the env-presence check ("Feature 4 may add a pre-flight check that the operator has `ANTHROPIC_API_KEY` set"). | Pulled forward into F3 as US6 — F3 is the first feature whose happy path requires per-backend env validation (Gemini introduces a second possible env var). F4 still owns network-policy hardening and threat-model evaluation. |

## Events / Hooks

No events or hooks are introduced by F3. The Herald event bus (Milestone 4) defines the event system. F3's modifications stay within the dispatch action and the SpawnRecord shape.

## Integration Boundaries

- **Feature 2 (Spawn Dispatch)**: F3 is a refactor + extension of F2. The dispatch pipeline stages, branch/worktree naming, snapshot exclusion list, container launch template, and SpawnRecord schema are all F2's; F3 changes how individual stages source their per-backend inputs. F2's acceptance scenarios remain green under F3 with `--backend claude-code` (or no flag), serving as the regression backstop for the refactor.
- **Feature 4 (Spawn Sandbox Security)**: F4 owns network-policy hardening per backend, threat-model evaluation against RFC Appendix A, and any per-backend allowlist of API endpoints (Gemini's API, `api.anthropic.com`). F3 leaves `networkMode = "bridge"` (F2's posture) and does not introduce per-backend network configuration. The auth pre-flight (US6) was originally allocated to F4 by F2's comment block but is pulled forward into F3 because Gemini introduces the multi-key ambiguity that motivates it. F4's scope adjustment is noted explicitly here so F4's spec owner can refine accordingly.
- **Feature 5 (Spawn Output Extraction)**: F5 owns exit-code interpretation (which is why `parseExitCode` is not a F3 interface method). F5 reads `SpawnRecord.backend` to know which backend produced the JSON envelope and adapts its parsing accordingly. F3 guarantees `SpawnRecord.backend` accurately reflects the actual backend (US7).
- **Feature 6 (PR Integration)**: F6 reads `SpawnRecord.backend` for PR metadata (e.g., "Spawn ran on Gemini"). F3's US7 makes this read meaningful for non-Claude-Code spawns.
- **Milestone 2 (Hatchery)**: M2 layers declarative per-profile configuration on top of F3's primitives. The `--backend` flag and `MARCH_BACKEND` env var continue to work; M2 may add a `--profile` flag whose resolution can override or constrain backend selection. No coexistence design is needed in M1.
- **Milestone 3 (Brood)**: Brood's session-management code reads `SpawnRecord.backend` for status reporting and rate-limit handling per RFC Appendix C6. F3's US7 guarantees the field reflects the actual backend.
- **Docker CLI**: Unchanged — F3 does not change how the dispatch action invokes Docker, only which image tag, env-flag list, and entrypoint argv are passed.
- **External base image provisioning**: `march-gemini-base:latest` is operationally provisioned (mirroring F2's `march-base:latest` contract). F3 references the tag but does not build the image; the image build/publish process is not part of this feature.
