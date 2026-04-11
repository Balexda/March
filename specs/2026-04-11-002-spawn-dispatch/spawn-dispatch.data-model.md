# Data Model: Spawn Dispatch

## Overview

This model supports the spawn dispatch pipeline: tracking the state and metadata of individual spawn dispatches, defining the hardcoded container security configuration, and establishing the backend execution interface boundary. It extends the March data model (Feature 1's MarchManifest and MarchSkill) with spawn-specific entities that live in a separate state space from the installation manifest.

## Entities

### 1) SpawnRecord (`~/.march/spawns/<spawn-id>.json`)

Purpose: Tracks the metadata and outcome of a single spawn dispatch. This is the primary state artifact produced by Feature 2 and consumed by downstream features (Feature 5 for output extraction, Feature 6 for PR integration). Each spawn gets its own JSON file, keyed by spawn ID.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | Yes | Record schema version. Fixed at `1` for Feature 2. Used for forward-compatible schema evolution. |
| `id` | string | Yes | The SpawnId. Format: `YYYYMMDD-<6-char-hex>` (e.g., `20260411-a1b2c3`). |
| `repoPath` | string | Yes | Absolute path to the source git repository root. |
| `branch` | string | Yes | Git branch name created for this spawn (e.g., `march/spawn/20260411-a1b2c3`). |
| `worktreePath` | string | Yes | Absolute path to the spawn's worktree directory. |
| `containerId` | string | Yes | Docker container ID (full SHA). |
| `imageId` | string | Yes | Docker image ID or tag used for this spawn. |
| `backend` | string | Yes | Backend identifier (e.g., `"claude-code"`). Hardcoded in Feature 2; Feature 3 adds selection. |
| `status` | string | Yes | Current spawn status: `"created"`, `"running"`, `"stopped"`, `"failed"`. |
| `exitCode` | integer | No | Container exit code. Present only when `status` is `"stopped"` or `"failed"`. |
| `prompt` | string | Yes | The operator's raw prompt (before finalization). Stored for traceability. |
| `createdAt` | string | Yes | ISO 8601 timestamp of when the spawn was created. |
| `startedAt` | string | No | ISO 8601 timestamp of when the container started running. |
| `stoppedAt` | string | No | ISO 8601 timestamp of when the container stopped. Present when `status` is `"stopped"` or `"failed"`. |
| `timedOut` | boolean | No | `true` if the container was killed due to exceeding the execution timeout. Defaults to `false`. |

Validation rules:
- `version` must be a positive integer.
- `id` must match the pattern `^\d{8}-[0-9a-f]{6}$`.
- `status` must be one of: `"created"`, `"running"`, `"stopped"`, `"failed"`.
- `exitCode` must be present when `status` is `"stopped"` or `"failed"`.
- `createdAt`, `startedAt`, and `stoppedAt` must be valid ISO 8601 timestamps when present.
- `repoPath` and `worktreePath` must be absolute paths.

### 2) SpawnConfig (internal constant)

Purpose: Defines the hardcoded container security and resource configuration used by Feature 2. This is an internal typed constant — not persisted to disk, not user-facing. It serves as a single, auditable source of truth for the container's security posture. Hatchery (M2) replaces this with declarative, editable profiles.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `capDrop` | string[] | Yes | Linux capabilities to drop. Value: `["ALL"]`. |
| `user` | string | Yes | Non-root user identifier inside the container (e.g., `"march"` or `"1000:1000"`). |
| `networkMode` | string | Yes | Docker network mode. Value: `"bridge"` for Feature 2 (Feature 4 hardens). |
| `memoryLimit` | string | Yes | Container memory limit (e.g., `"4g"`). |
| `cpuLimit` | string | Yes | Container CPU limit (e.g., `"2"`). |
| `timeoutSeconds` | integer | Yes | Maximum execution time before the container is killed (e.g., `3600` for 1 hour). |
| `envWhitelist` | string[] | Yes | Environment variable names allowed to pass into the container. Value: backend-specific auth key only (e.g., `["ANTHROPIC_API_KEY"]`). |

Validation rules:
- `capDrop` must contain `"ALL"`.
- `memoryLimit` must match Docker's memory format (e.g., `"4g"`, `"512m"`).
- `cpuLimit` must be a positive number as a string.
- `timeoutSeconds` must be a positive integer.
- `envWhitelist` must be a non-empty array of strings.

Note: SpawnConfig is not persisted as a separate file. It is a compile-time constant in the codebase. Its values are documented here for auditability and for Feature 4's threat model evaluation.

### 3) SpawnBackend (interface boundary)

Purpose: Defines the contract between Feature 2 (dispatch) and the backend execution layer. Feature 2 ships with a single hardcoded implementation (Claude Code CLI). Feature 3 replaces the hardcoded implementation with a polymorphic interface supporting multiple backends.

| Field/Method | Type | Notes |
|-------------|------|-------|
| `name` | string | Backend identifier (e.g., `"claude-code"`, `"gemini"`). |
| `cliCommand` | string | CLI binary name to check during dependency validation (e.g., `"claude"`). |
| `buildEntrypoint` | `(promptFilePath: string) => string[]` | Constructs the container entrypoint command with the prompt file path. Returns the command and arguments array. |
| `requiredEnvVars` | string[] | Environment variable names the backend requires (e.g., `["ANTHROPIC_API_KEY"]`). |

Note: SpawnBackend is a code-level interface, not a persisted entity. It is documented here to establish the contract boundary between Features 2 and 3. The interface is deliberately minimal — Feature 3 may extend it with additional methods (e.g., `parseOutput`, `validateAuth`).

## Relationships

- SpawnRecord is a standalone entity — it does not reference or depend on MarchManifest. Spawn state and installation state are separate concerns.
- SpawnConfig is consumed by the dispatch pipeline to configure each container launch. One SpawnConfig applies to all spawns in Feature 2 (hardcoded).
- SpawnBackend is consumed by the dispatch pipeline to determine the container entrypoint and required environment. One SpawnBackend is active per spawn (hardcoded to Claude Code in Feature 2).
- SpawnRecord references one SpawnBackend by the `backend` field (string identifier, not a foreign key).

## State Transitions

### SpawnRecord lifecycle

1. `absent` → `created`
   - Trigger: `march spawn dispatch` begins, worktree and branch are created.
   - Effects: SpawnRecord file is created at `~/.march/spawns/<spawn-id>.json` with status `"created"` and `createdAt` timestamp.

2. `created` → `running`
   - Trigger: Docker container starts successfully.
   - Effects: `status` updated to `"running"`, `containerId` and `startedAt` populated.

3. `running` → `stopped`
   - Trigger: Container process exits normally (any exit code).
   - Effects: `status` updated to `"stopped"`, `exitCode` and `stoppedAt` populated.

4. `running` → `failed`
   - Trigger: Container is killed due to timeout, or an infrastructure error prevents normal exit.
   - Effects: `status` updated to `"failed"`, `exitCode` populated (if available), `stoppedAt` populated, `timedOut` set to `true` if timeout was the cause.

5. `created` → `failed`
   - Trigger: Container launch fails (Docker error, image build failure).
   - Effects: `status` updated to `"failed"`, worktree and branch are cleaned up.

Note: Feature 2 does not define transitions beyond `stopped`/`failed`. Feature 5 may add an `"extracted"` status when it retrieves output from the container.

## Identity & Uniqueness

- SpawnRecords are uniquely identified by their SpawnId (`YYYYMMDD-<6-char-hex>`). The ID is generated from the current date plus 6 random hex characters (from `crypto.randomBytes(3)`).
- The SpawnId is used as the key across all spawn artifacts: the file name (`<spawn-id>.json`), the branch name (`march/spawn/<spawn-id>`), the worktree directory name, and the Docker container/image name prefix.
- Collision avoidance: if a branch `march/spawn/<spawn-id>` already exists, a new SpawnId is generated. The 6-hex-char suffix provides ~16 million combinations per day, making collisions negligible in practice.
- The `~/.march/spawns/` directory is created on first spawn dispatch if it does not exist. It is a flat directory — no subdirectories per repo. The `repoPath` field in SpawnRecord identifies which repo a spawn belongs to.
