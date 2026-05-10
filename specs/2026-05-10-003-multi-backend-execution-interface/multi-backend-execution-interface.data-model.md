# Data Model: Multi-Backend Execution Interface

## Overview

This model promotes `SpawnBackend` from F2's interface-boundary stub (a forward-looking placeholder in `spawn-dispatch.data-model.md` Entity 3) to a first-class entity owned by F3, with two concrete implementations registered in a name-keyed lookup. It also narrows F2's `SpawnConfig` constant by relocating `envWhitelist` onto `SpawnBackend.requiredEnvVars`, so the dispatch pipeline derives auth env vars from the selected backend rather than from a global. `SpawnRecord`'s shape is unchanged; only the population of its existing `backend` field changes.

## Entities

### 1) SpawnBackend (interface and registered implementations)

Purpose: Defines the polymorphic dispatch contract — every backend implementation provides the four pieces of information the dispatch pipeline needs to launch a container against it (image, auth env vars, entrypoint argv, and the registry key under which it is selected). F3 ships two registered implementations, `claudeCodeBackend` and `geminiBackend`, exposed through the registry described in Entity 2. The interface is deliberately closed at four members in F3; future backends with non-env-var auth or differing exit-code semantics motivate separate features, not in-place extensions.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Registry key under which this backend is registered. Matches the `--backend <name>` flag value and the `MARCH_BACKEND` env-var value. Also used as the `backend` field on `SpawnRecord`. |
| `baseImage` | string | Yes | Docker image tag containing this backend's CLI pre-installed. Consumed by Stage 1 (Validate — dependency check), Stage 3 (Snapshot — Dockerfile `FROM` line), and any per-backend image diagnostics. |
| `requiredEnvVars` | `readonly string[]` | Yes | Names of host environment variables that must be set (and non-empty) before the spawn can run. Consumed by Stage 1.5 (Auth Pre-Flight) for validation against the operator's environment, and Stage 4 (Launch) for the container env-flag composition. |
| `buildEntrypoint` | `(promptFilePath: string) => readonly string[]` | Yes | Pure function returning the `docker run` exec argv that runs this backend's CLI inside the container against the given in-container prompt file path. The argv is the same shape `LaunchSpawnContainerInput.entrypoint` consumes. Implementations are expected to use an `sh -c` wrapper if they rely on shell expansion (e.g., `$(cat ...)`). |

Validation rules:

- `name` must be a non-empty string and unique within the registry (registry rejects duplicate registrations at construction time).
- `baseImage` must be a non-empty Docker image reference (the dispatch pipeline does not parse it; the dependency check passes it to Docker as-is).
- `requiredEnvVars` may be empty (a backend with no auth requirements is permitted in principle), but each entry must be a non-empty string. Both F3 backends populate this with exactly one entry.
- `buildEntrypoint(promptFilePath)` must return a non-empty `string[]`. The first element is the executable; subsequent elements are arguments. Quoting and shell-expansion are the implementation's responsibility, not the dispatch pipeline's.

Concrete implementations registered in F3:

**`claudeCodeBackend`**

| Field | Value |
|-------|-------|
| `name` | `"claude-code"` |
| `baseImage` | `"march-base:latest"` |
| `requiredEnvVars` | `["ANTHROPIC_API_KEY"]` |
| `buildEntrypoint(promptFilePath)` | Returns `["sh", "-c", \`claude -p "$(cat ${promptFilePath})" --output-format json --dangerously-skip-permissions --bare --no-session-persistence\`]` — character-identical to F2's `buildClaudeCodeEntrypoint(promptFilePath)` in `src/container-launch.ts`. |

**`geminiBackend`**

| Field | Value |
|-------|-------|
| `name` | `"gemini"` |
| `baseImage` | `"march-gemini-base:latest"` |
| `requiredEnvVars` | `["GEMINI_API_KEY"]` |
| `buildEntrypoint(promptFilePath)` | Returns `["sh", "-c", \`gemini --prompt "$(cat ${promptFilePath})" --approval-mode=yolo --output-format json\`]`. **Does not** include `--sandbox=docker` — the outer March container provides isolation, settling RFC Appendix B6. |

### 2) Backend Registry

Purpose: A name-keyed lookup of registered `SpawnBackend` instances. The dispatch action calls into the registry to resolve the operator's selection (CLI flag → env var → default) into a concrete backend, and to enumerate registered names for help output and the unknown-backend error message. Internal to F3; not user-extensible at runtime.

| Field/Method | Type | Notes |
|-------------|------|-------|
| `getBackend` | `(name: string) => SpawnBackend \| undefined` | Returns the registered backend for the given name, or `undefined` if the name is not registered. The dispatch action formats the user-facing error when `undefined` is returned (so error wording stays in one place). |
| `listBackends` | `() => readonly string[]` | Returns the registered backend names. Used by `--help` text and the unknown-backend error message. The order is implementation-defined but stable (so help and error output are deterministic across invocations). |
| `defaultBackendName` | `string` (constant) | The name returned when neither `--backend` flag nor `MARCH_BACKEND` env var is set. Value: `"claude-code"`. Replaces F2's `DEFAULT_BACKEND` constant in `spawn-record.ts`. |

Validation rules:

- The registry rejects duplicate name registrations at construction time. This is a coding-error guard, surfaced to a developer's local test run, not an operator-facing concern.
- The registry must always contain at least one entry whose name matches `defaultBackendName`. F3 ships `claude-code` and `gemini`, satisfying this trivially.

Note: The registry is a code-level construct, not a persisted entity. It is documented here to formalize the lookup contract that US1, US2, US5, and US6 all read through.

### 3) SpawnConfig (narrowed)

Purpose: F2's compile-time security/resource posture constant, narrowed by F3 to remove `envWhitelist`. The remaining fields define how the spawn container is launched regardless of which backend runs inside it. Hatchery (M2) replaces this constant with declarative per-profile configuration.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `capDrop` | `readonly string[]` | Yes | Linux capabilities to drop. Value: `["ALL"]`. Unchanged from F2. |
| `user` | string | Yes | Non-root user identifier inside the container. Value: `"march"`. Unchanged from F2. |
| `networkMode` | string | Yes | Docker network mode. Value: `"bridge"`. Unchanged from F2; F4 hardens. |
| `memoryLimit` | string | Yes | Container memory limit. Value: `"4g"`. Unchanged from F2; per-backend sizing is Hatchery's job. |
| `cpuLimit` | string | Yes | Container CPU limit. Value: `"2"`. Unchanged from F2. |
| `timeoutSeconds` | integer | Yes | Maximum execution time before the container is killed. Value: `3600`. Unchanged from F2. |

Field removed from F2 by F3:

| Removed Field | Reason | Replacement |
|---------------|--------|-------------|
| `envWhitelist` | F2 hardcoded a single global `["ANTHROPIC_API_KEY"]`. With multiple backends each requiring different env vars, the whitelist becomes backend-derived, not a global posture concern. | `SpawnBackend.requiredEnvVars` on the *selected* backend. The launched container forwards exactly the selected backend's required env vars — no other backend's keys, no static union. |

Validation rules: Same as F2 for the retained fields. No new rules in F3.

### 4) SpawnRecord (unchanged shape)

Purpose: F2 already wires the `backend` field on `SpawnRecord` (the `DEFAULT_BACKEND` constant in `src/spawn-record.ts`). F3 changes only the *population* of that field — from F2's hardcoded `"claude-code"` (via `DEFAULT_BACKEND`) to the actually-selected backend's `name`.

No fields are added. No fields change type. The schema `version` stays at `1`. F2-era records on disk are not retroactively modified.

| Field | F2 Behavior | F3 Behavior |
|-------|-------------|-------------|
| `backend` | Always `"claude-code"` (hardcoded via `DEFAULT_BACKEND`). | Reflects the selected backend's `name` (e.g., `"claude-code"` or `"gemini"`). |
| `version` | `1` | `1` (unchanged). |
| All other fields | (per F2) | (per F2 — unchanged). |

## Relationships

- **SpawnBackend ↔ Backend Registry**: The registry holds N `SpawnBackend` instances keyed by `name`. F3 registers exactly two: `claudeCodeBackend` and `geminiBackend`.
- **SpawnBackend ↔ SpawnConfig**: Disjoint concerns. `SpawnConfig` describes the container's security/resource posture (independent of which backend runs); `SpawnBackend` describes the backend-specific image, env vars, and entrypoint. They are read together by the dispatch pipeline at Stage 4 (Launch) but neither references the other.
- **SpawnBackend ↔ SpawnRecord**: A SpawnRecord references one `SpawnBackend` by name (string identifier in the `backend` field, not a foreign key). The reference is one-way (records reference backends; backends do not know about records).
- **Backend Registry ↔ Dispatch Action**: The dispatch action resolves the operator's selection (flag → env var → default) into a registered `SpawnBackend` via `getBackend(name)`. Resolution failures (unknown name) flow back as user-facing `USAGE_ERROR` exits.

## State Transitions

No new state machines are introduced by F3. The SpawnRecord lifecycle defined in F2 (`absent → created → running → stopped|failed`) is unchanged.

## Identity & Uniqueness

- `SpawnBackend.name` is the unique identifier within the registry. Names are matched case-sensitively (e.g., `"Gemini"` is rejected as unknown — the supported names are `"claude-code"` and `"gemini"`).
- `SpawnRecord.id` continues to be the unique identifier for a spawn (per F2). The `backend` field is descriptive metadata, not part of the identity tuple.
- The registry rejects duplicate `name` registrations at construction time — caught by developer-side tests, not an operator-facing concern.
