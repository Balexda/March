# Feature Specification: Spawn Dispatch

**Spec Folder**: `2026-04-11-002-spawn-dispatch`
**Branch**: `2026-04-11-002-spawn-dispatch`
**Created**: 2026-04-11
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — Milestone 1: Spawn
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` — Feature 2: Spawn Dispatch

## Clarifications

### Session 2026-04-11

- Q: How is the prompt delivered to the backend CLI inside the container? → A: Via the backend CLI's prompt flag (`-p` for Claude Code, `--prompt` for Gemini). The `-p` flag is required to activate headless mode in Claude Code. The finalized prompt is written to a file inside the container, and the entrypoint uses an explicit shell (`sh -c`) to expand `$(cat /march/prompt.txt)` into the `-p` argument. `[Critical Assumption]`
- Q: What Docker network policy does Feature 2 use? → A: Feature 2 ships with the default Docker bridge network. This allows the container to reach the LLM API endpoint but does not restrict outbound traffic to only that endpoint. Feature 4 (Spawn Sandbox Security) is responsible for hardening the network policy. The spec documents this as a known security gap.
- Q: Does Feature 2 persist spawn state? → A: Yes. A SpawnRecord is created at dispatch start at `~/.march/spawns/<spawn-id>.json` with initial status `"created"`, then updated as the spawn progresses through its lifecycle and finalized after the container exits. Feature 5 (Output Extraction) needs the final record to include the container ID, worktree path, and branch name.
- Q: Does `march spawn dispatch` require a git repo? → A: Yes. The command detects the repo root by walking up from cwd and fails with a clear error if not inside a git repository. This is a hard precondition, not a soft warning.
- Q: What gets included in the worktree snapshot? → A: Only git-tracked files (via `git ls-files`), minus a hardcoded exclusion list (`.env`, `.env.*`, credential files). Untracked files and files ignored by `.gitignore` are excluded. The worktree is created from the current HEAD — uncommitted changes in the operator's working tree are not included.

### Assumptions

- Feature 2 hardcodes Claude Code CLI as the sole backend. The `SpawnBackend` interface is defined as a contract boundary; Feature 3 adds Gemini and polymorphic selection.
- The `march spawn` command with no verb prints help listing available spawn verbs, replacing the Feature 1 "not yet implemented" stub.
- SpawnRecord schema is deliberately minimal and versioned. Downstream features (5, 6) may extend it.
- The base Docker image with the backend CLI pre-installed is provided as a tagged image. Feature 2's generated Dockerfile `FROM`s this base and `COPY`s the worktree snapshot.
- Resource limits (memory, CPU, timeout) use hardcoded defaults. Hatchery (M2) later makes them configurable via profiles.
- Worktrees are created as siblings to the repo (`<repo>/../worktrees/march/<spawn-id>/`), not inside it. This avoids dot-directory visibility issues on macOS and prevents TUI agents running against the repo from reading/editing spawn worktrees.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Spawn Dispatch CLI Surface (Priority: P1)

As an operator, I want `march spawn dispatch` to be a registered CLI command with proper argument parsing so that I have a discoverable, well-structured entry point for dispatching spawns.

**Why this priority**: This is the entry point for the entire dispatch pipeline. No other story can be tested without a working CLI command.

**Independent Test**: Run `march spawn dispatch --help` and verify it prints usage information. Run `march spawn` with no verb and verify it prints help listing `dispatch`. Verify the old "not yet implemented" stub is replaced.

**Acceptance Scenarios**:

1. **Given** a working March installation, **When** the operator runs `march spawn dispatch --help`, **Then** usage information is printed describing the dispatch command's arguments and options.
2. **Given** a working March installation, **When** the operator runs `march spawn` with no verb, **Then** help text is printed listing available spawn verbs (including `dispatch`) and the command exits with code 2.
3. **Given** a working March installation, **When** the operator runs `march spawn nonexistent`, **Then** an error message is printed indicating the unknown verb, and the command exits with code 2.
4. **Given** a working March installation, **When** the operator runs `march spawn dispatch` without a required prompt argument, **Then** a usage error is printed and the command exits with code 2.

---

### User Story 2: Dependency Validation at Dispatch Time (Priority: P1)

As an operator, I want `march spawn dispatch` to verify that git and Docker are available and the base container image is accessible before attempting any operations so that I get a clear, actionable error instead of a cryptic failure mid-dispatch.

**Why this priority**: Failing fast with clear errors prevents wasted time and partial state. Dependencies are the first gate in the dispatch pipeline.

**Independent Test**: Remove `docker` from PATH, run `march spawn dispatch`. Verify it fails with a clear "Docker not found" error before creating any worktrees or containers.

**Acceptance Scenarios**:

1. **Given** `git` is not on PATH, **When** the operator runs `march spawn dispatch`, **Then** the command exits with code 1 and prints "git not found — required for spawn operations" to stderr.
2. **Given** `docker` is not on PATH, **When** the operator runs `march spawn dispatch`, **Then** the command exits with code 1 and prints "Docker not found — required for spawn operations" to stderr.
3. **Given** the configured base container image is not available locally or pullable, **When** the operator runs `march spawn dispatch`, **Then** the command exits with code 1 and prints a message identifying the unavailable image.
4. **Given** the current working directory is not inside a git repository, **When** the operator runs `march spawn dispatch`, **Then** the command exits with code 1 and prints "Not inside a git repository — march spawn must be run from within a git repo."
5. **Given** all dependencies are available and the operator is inside a git repo, **When** the operator runs `march spawn dispatch`, **Then** the dependency check passes silently and dispatch proceeds.

---

### User Story 3: Create Isolated Worktree and Branch per Spawn (Priority: P1)

As an operator, I want each spawn to get its own git worktree and dedicated branch so that the spawn's work is isolated from my main working tree and other concurrent spawns.

**Why this priority**: Worktree isolation is a prerequisite for the snapshot step and for preventing branch race conditions between concurrent spawns.

**Independent Test**: Run `march spawn dispatch` from a git repo. Verify that a new branch `march/spawn/<spawn-id>` exists and a worktree directory exists at `<repo>/../worktrees/march/<spawn-id>/`.

**Acceptance Scenarios**:

1. **Given** a git repository, **When** the operator dispatches a spawn, **Then** a new branch `march/spawn/<spawn-id>` is created from the current HEAD.
2. **Given** a git repository, **When** the operator dispatches a spawn, **Then** a worktree is created at `<repo>/../worktrees/march/<spawn-id>/` linked to the new branch.
3. **Given** a git repository, **When** the operator dispatches a spawn, **Then** the spawn ID follows the format `YYYYMMDD-<6-char-hex>` (e.g., `20260411-a1b2c3`).
5. **Given** a branch `march/spawn/<spawn-id>` already exists (collision), **When** the operator dispatches a spawn, **Then** a new spawn ID is generated to avoid the collision.
6. **Given** worktree creation fails (e.g., filesystem permissions), **When** the operator dispatches a spawn, **Then** the error is reported clearly, any partially created branch is cleaned up, and the command exits with code 1.

---

### User Story 4: Snapshot Worktree into Docker Image (Priority: P1)

As an operator, I want the spawn's worktree to be copied into a Docker image so that the AI session works on an immutable snapshot that cannot modify my local files.

**Why this priority**: The snapshot is the core isolation mechanism. Without it, the container would need a bind mount, which violates the RFC's security model.

**Independent Test**: After dispatch, inspect the Docker image layers. Verify that the worktree files are baked into the image (not bind-mounted). Verify that `.env` files and other excluded patterns are not present in the image.

**Acceptance Scenarios**:

1. **Given** a worktree with git-tracked files, **When** the snapshot step runs, **Then** a Docker image is built containing only git-tracked files from the worktree (as reported by `git ls-files`).
2. **Given** a worktree containing `.env` files or files matching the exclusion list, **When** the snapshot step runs, **Then** those files are excluded from the Docker image.
3. **Given** a worktree, **When** the snapshot step runs, **Then** the resulting Docker container has no bind mounts to host paths.
4. **Given** a worktree, **When** the snapshot step runs, **Then** a generated Dockerfile uses a base image with the backend CLI pre-installed and `COPY`s the worktree files into the container's working directory.
5. **Given** a Docker build failure (e.g., Docker daemon not running), **When** the snapshot step runs, **Then** the error is reported clearly, the worktree and branch are cleaned up, and the command exits with code 1.

---

### User Story 5: Launch Container with Hardcoded Security Configuration (Priority: P1)

As an operator, I want the spawn container to launch with restrictive security defaults so that the AI session cannot escape the sandbox or consume unbounded resources.

**Why this priority**: Security is the RFC's highest priority. Every container must run with restricted capabilities from the first dispatch.

**Independent Test**: After dispatch, inspect the running container's configuration. Verify `--cap-drop=ALL`, non-root user, memory/CPU limits, and environment variable whitelist.

**Acceptance Scenarios**:

1. **Given** a built Docker image, **When** the container launches, **Then** it runs with `--cap-drop=ALL`.
2. **Given** a built Docker image, **When** the container launches, **Then** it runs as a non-root user inside the container.
3. **Given** a built Docker image, **When** the container launches, **Then** memory and CPU limits are applied (hardcoded defaults).
4. **Given** a built Docker image, **When** the container launches, **Then** only whitelisted environment variables are passed to the container (the backend's API key or auth token, and no others).
5. **Given** a built Docker image, **When** the container launches, **Then** the container uses the default Docker bridge network (with documentation that Feature 4 will harden the network policy).
6. **Given** a container launch failure, **When** dispatch is attempted, **Then** the error is reported, the Docker image, worktree, and branch are cleaned up, and the command exits with code 1.

---

### User Story 6: Finalize Prompt and Hand Off to Backend (Priority: P1)

As an operator, I want my task prompt to be finalized with spawn context and delivered to the AI session inside the container so that the headless session has all the information it needs to begin work.

**Why this priority**: Prompt finalization is the bridge between the operator's intent and the backend's execution. Without it, the backend cannot produce structured output.

**Independent Test**: Dispatch a spawn with a known prompt. Inspect the finalized prompt delivered to the backend (via container logs or process arguments). Verify it includes the original prompt and spawn context metadata.

**Acceptance Scenarios**:

1. **Given** a prompt provided via `--prompt-file <path>`, **When** dispatch runs, **Then** the prompt file contents are read and used as the raw prompt.
2. **Given** a prompt provided via stdin (piped input), **When** dispatch runs, **Then** stdin contents are read and used as the raw prompt.
3. **Given** a raw prompt, **When** the finalization step runs, **Then** the finalized prompt includes the original prompt plus spawn context (spawn ID, working directory path inside the container).
4. **Given** a finalized prompt, **When** the backend handoff runs, **Then** the backend CLI is invoked inside the container with the finalized prompt via the `-p` flag (activating headless mode).
5. **Given** the Claude Code backend, **When** the backend is invoked, **Then** the CLI flags include `--output-format json`, `--dangerously-skip-permissions`, `--bare`, and `--no-session-persistence`.

---

### User Story 7: Container Lifecycle: Wait for Exit (Priority: P2)

As an operator, I want `march spawn dispatch` to wait for the container to finish and report whether the spawn succeeded or failed so that I know the outcome without manually inspecting the container.

**Why this priority**: Lifecycle management completes the dispatch loop but is lower priority than the core pipeline stages. The container must be launched (P1 stories) before this story is meaningful.

**Independent Test**: Dispatch a spawn with a simple prompt. Verify that the CLI blocks until the container exits and prints the exit status. Verify a SpawnRecord is written to `~/.march/spawns/<id>.json`.

**Acceptance Scenarios**:

1. **Given** a running spawn container, **When** the container process exits with code 0, **Then** `march spawn dispatch` reports success and exits with code 0.
2. **Given** a running spawn container, **When** the container process exits with a non-zero code, **Then** `march spawn dispatch` reports the failure with the container's exit code and exits with code 1.
3. **Given** a running spawn container, **When** the container exceeds the maximum execution time (hardcoded timeout), **Then** the container is killed, a timeout is reported, and the command exits with code 1.
4. **Given** a spawn that completes (success or failure), **When** the lifecycle step finishes, **Then** the SpawnRecord at `~/.march/spawns/<spawn-id>.json` is updated with the spawn's final status, exit code, and `stoppedAt` timestamp.
5. **Given** a spawn that completes, **When** the lifecycle step finishes, **Then** the stopped container is left in place (not removed) so that Feature 5 can extract its output.

### Edge Cases

- Dispatch from a shallow clone or a repo with detached HEAD — worktree creation should still work; the branch is created from whatever commit HEAD points to.
- Dispatch when Docker daemon is not running (vs. Docker CLI not on PATH) — different error message ("Docker daemon not reachable" vs. "Docker not found").
- Dispatch from a submodule — should detect the parent repo root and create the worktree there, or fail with a clear error.
- Dispatch when `~/.march/spawns/` directory does not exist — create it on first write.
- Very large repositories — snapshot via `git ls-files` may produce a large Docker build context. No mitigation in Feature 2; documented as a known limitation.
- Concurrent dispatches from the same repo — each gets a unique spawn ID, branch, and worktree. No coordination or locking is required because git worktree operations are atomic at the branch level.
- Prompt file does not exist or is not readable — fail with a clear error before any git or Docker operations.
- Container exits before the backend CLI starts (e.g., entrypoint failure) — report the container exit code and include container logs in the error output.

## Story Dependency Order

Recommended implementation sequence:

- [x] **User Story 1: Spawn Dispatch CLI Surface** — No dependencies beyond Feature 1; establishes the subcommand group that all other stories plug into → `specs/2026-04-11-002-spawn-dispatch/01-spawn-dispatch-cli-surface.tasks.md`
- [x] **User Story 2: Dependency Validation at Dispatch Time** — Depends on Story 1 for the dispatch action; adds full dependency checks (git, docker, base image, repo context) → `specs/2026-04-11-002-spawn-dispatch/02-dependency-validation.tasks.md`
- [ ] **User Story 3: Create Isolated Worktree and Branch per Spawn** — Depends on Story 2 for validated repo context; creates the worktree that Story 4 snapshots
- [ ] **User Story 4: Snapshot Worktree into Docker Image** — Depends on Story 3 for worktree; builds the Docker image that Story 5 launches
- [ ] **User Story 5: Launch Container with Hardcoded Security Configuration** — Depends on Story 4 for Docker image; starts the container that Story 6 hands off to
- [ ] **User Story 6: Finalize Prompt and Hand Off to Backend** — Depends on Stories 1 and 5; implements prompt reading and passes it to the running container
- [ ] **User Story 7: Container Lifecycle: Wait for Exit** — Depends on Story 5 for container launch; monitors the container and collects exit status

## Requirements

### Functional Requirements

- **FR-001**: The `march spawn dispatch` command MUST be registered as a verb under the `spawn` system namespace, following the `march <system> <verb>` pattern established in the Feature 1 extension contract.
- **FR-002**: The `march spawn` command with no verb MUST print help text listing available spawn verbs and exit with code 2.
- **FR-003**: The `march spawn dispatch` command MUST validate that `git` and `docker` are available on PATH and that the configured base container image is accessible before performing any operations. Missing dependencies or an unavailable image MUST produce clear error messages on stderr and exit with code 1.
- **FR-004**: The `march spawn dispatch` command MUST validate that the current working directory is inside a git repository. If not, it MUST exit with code 1 and print a clear error.
- **FR-005**: Each spawn MUST be assigned a unique SpawnId in the format `YYYYMMDD-<6-char-hex>`.
- **FR-006**: Each spawn MUST create a dedicated git branch named `march/spawn/<spawn-id>` from the current HEAD and a git worktree at `<repo>/../worktrees/march/<spawn-id>/`.
- **FR-007**: The worktree parent directory (`<repo>/../worktrees/march/`) MUST be created if it does not exist.
- **FR-008**: The worktree snapshot MUST include only git-tracked files (via `git ls-files`) minus a hardcoded exclusion list. Untracked files and files ignored by `.gitignore` MUST be excluded.
- **FR-009**: The exclusion list MUST exclude at minimum: `.env`, `.env.*`, and files matching common credential patterns.
- **FR-010**: The worktree snapshot MUST be baked into a Docker image via a generated Dockerfile (using `COPY`), not mounted via a bind mount.
- **FR-011**: The Docker container MUST run with `--cap-drop=ALL` and as a non-root user.
- **FR-012**: The Docker container MUST have memory and CPU resource limits applied (hardcoded defaults).
- **FR-013**: The Docker container MUST pass only whitelisted environment variables (the backend's authentication credential and no others).
- **FR-014**: The finalized prompt MUST include the operator's raw prompt plus spawn context metadata (spawn ID, container working directory).
- **FR-015**: The finalized prompt MUST be delivered to the backend CLI via its headless flag (`-p` for Claude Code).
- **FR-016**: The backend CLI MUST be invoked with structured JSON output enabled (`--output-format json`).
- **FR-017**: The `march spawn dispatch` command MUST block until the container process exits.
- **FR-018**: A maximum execution timeout MUST be enforced. If the container exceeds it, the container MUST be killed.
- **FR-019**: A SpawnRecord MUST be created at `~/.march/spawns/<spawn-id>.json` at dispatch start and updated as the spawn progresses through its lifecycle. The record MUST be finalized upon spawn completion (success or failure).
- **FR-020**: The stopped container MUST NOT be removed after the spawn completes. It MUST remain available for Feature 5 (Output Extraction).
- **FR-021**: If any step in the dispatch pipeline fails, all prior artifacts (branch, worktree, Docker image) MUST be cleaned up before the command exits.
- **FR-022**: The command MUST use exit codes consistently: 0 (success), 1 (error), 2 (usage error).

### Key Entities

- **SpawnRecord**: A JSON file tracking the metadata and outcome of a single spawn dispatch. Stored at `~/.march/spawns/<spawn-id>.json`. Consumed by Feature 5 (Output Extraction) and Feature 6 (PR Integration).
- **SpawnConfig**: An internal typed constant defining the hardcoded container security configuration (capabilities, user, network mode, resource limits, env var whitelist). Replaced by Hatchery profiles in M2.
- **SpawnBackend**: An interface boundary defining how Feature 2 invokes the AI backend (prompt in, exit result out). Feature 2 ships a single hardcoded implementation (Claude Code CLI). Feature 3 adds polymorphic backend support.

## Assumptions

- The operator has Docker installed and the Docker daemon running. Feature 2 checks for the `docker` CLI on PATH but does not verify daemon connectivity until the first Docker operation.
- The base Docker image with the backend CLI pre-installed is managed outside this feature's scope. Feature 2 references the image by tag in its generated Dockerfile. The image build/publish process is an operational concern.
- Worktrees are created from the current HEAD. Uncommitted changes in the operator's working tree are not included in the snapshot.
- The SpawnRecord schema is version 1 and deliberately minimal. Downstream features may add fields; backward compatibility is managed via the version field.
- March operates as a single-operator tool. No locking or coordination is needed for concurrent dispatches beyond git's own branch-level atomicity.

## Out of Scope

- Output extraction from the stopped container (Feature 5: Spawn Output Extraction).
- Patch application, branch push, and PR creation (Feature 6: PR Integration).
- Multi-backend selection and polymorphic backend interface (Feature 3: Multi-Backend Execution Interface).
- Formal threat model evaluation and security hardening (Feature 4: Spawn Sandbox Security).
- Declarative container profile configuration (Milestone 2: Hatchery).
- Worktree and container cleanup after merge (Milestone 3: Brood).
- Streaming or real-time output observation during spawn execution.
- Customizable resource limits (hardcoded defaults only in Feature 2).

## Success Criteria

### Measurable Outcomes

- **SC-001**: `march spawn dispatch --prompt-file <path>` from inside a git repo creates a worktree, builds a Docker image, launches a container, waits for exit, and writes a SpawnRecord — all within a single CLI invocation.
- **SC-002**: The spawned container has no bind mounts to the host filesystem (verified via `docker inspect`).
- **SC-003**: The spawned container runs with `--cap-drop=ALL` and as a non-root user (verified via `docker inspect`).
- **SC-004**: The spawned container receives only whitelisted environment variables (verified via `docker inspect`).
- **SC-005**: Missing dependencies (git, docker, backend CLI) are detected before any filesystem or Docker operations, with clear error messages.
- **SC-006**: The SpawnRecord at `~/.march/spawns/<spawn-id>.json` contains all fields needed by Feature 5 (container ID, worktree path, branch name, status, exit code).
- **SC-007**: The stopped container remains available after dispatch completes (not auto-removed), ready for Feature 5 extraction.
- **SC-008**: Concurrent dispatches from the same repo each get unique spawn IDs, branches, and worktrees with no conflicts.
