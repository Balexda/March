# Contracts: Spawn Dispatch

> **Architecture note (container-service split, 2026-05).** These contracts
> describe the M1 in-process `march spawn dispatch` flow. Since then: the spawn
> flow runs inside the **Hatchery containerized service** (`march hatchery serve`;
> `march hatchery spawn` is a thin HTTP client); the dispatch **provider** is that
> service, not the CLI binary. Worktree/branch/container **teardown is owned by
> Brood** (exact tracked path, never `git worktree prune`, #155) and is *requested*
> via `march brood teardown` — the in-process "reverse-order cleanup" / "stop and
> remove container, remove worktree, delete branch" stages below are superseded by
> that ownership. The Hatchery **registers each spawn with Brood at launch**, and
> hands the extracted patch to the **Steward** (an interactive `agent-deck` session
> hosted in **Castra**, driven over the Castra HTTP API) — a boundary these
> contracts do not describe. The headless `claude -p` container here is the
> **Spawn**, not the integrator. See the full mapping in the banner in
> `spawn-dispatch.spec.md`.

## Overview

This document defines the interface contracts for the Spawn Dispatch feature: the `march spawn dispatch` CLI command, the spawn dispatch pipeline (worktree creation, snapshot, container launch, prompt handoff, lifecycle), the SpawnRecord output format, and the integration boundaries with Docker, git, and the AI backend CLI. Contracts are expressed as behavioral specifications without prescribing implementation details.

## Interfaces

### march spawn dispatch

**Purpose**: Dispatch a spawn — create an isolated worktree, snapshot it into a Docker container, finalize the prompt, and run a headless AI session.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march spawn dispatch --prompt-file <path> [options]
march spawn dispatch --prompt <string> [options]
cat prompt.txt | march spawn dispatch [options]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--prompt-file` | string (path) | One of `--prompt-file`, `--prompt`, or stdin | Path to a file containing the task prompt. |
| `--prompt` | string | One of `--prompt-file`, `--prompt`, or stdin | Inline prompt string (convenience for short prompts). |
| stdin | stream | One of `--prompt-file`, `--prompt`, or stdin | Piped input used as the prompt when neither flag is provided. |
| `--base` | string | No | Git ref to branch from (default: `HEAD`). |

Prompt source precedence: `--prompt-file` > `--prompt` > stdin. If none is provided, exit with usage error.

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Worktree created | `<repo>/../worktrees/march/<spawn-id>/` | Git worktree with dedicated branch. |
| Branch created | `march/spawn/<spawn-id>` | Dedicated git branch for this spawn. |
| Docker image built | Docker daemon | Tagged image containing the worktree snapshot. |
| Container launched | Docker daemon | Running container executing the backend CLI. |
| SpawnRecord written | `~/.march/spawns/<spawn-id>.json` | JSON file with spawn metadata and outcome. |
| Status printed | stdout | Summary line with spawn ID, status, and exit code. |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| No prompt provided | 2 | Usage error — no `--prompt-file`, `--prompt`, or stdin. |
| Missing dependency (git, docker) or unavailable backend image | 1 | Required host dependency (`git` or `docker`) not found on PATH, or the configured base container image is unavailable. Clear error on stderr. |
| Not in a git repository | 1 | cwd is not inside a git repo. |
| Prompt file not found or not readable | 1 | The file specified by `--prompt-file` does not exist. |
| Worktree creation failure | 1 | Git worktree or branch creation failed. Partial state cleaned up. |
| Docker build failure | 1 | Docker image build failed. Worktree and branch cleaned up. |
| Container launch failure | 1 | Docker run failed. Image, worktree, and branch cleaned up. |
| Container timeout | 1 | Container killed after exceeding execution timeout. SpawnRecord written with `timedOut: true`. |
| Container non-zero exit | 1 | Backend CLI exited with error. SpawnRecord written with actual exit code. |

---

### march spawn (no verb)

**Purpose**: Display help for the spawn subsystem, listing available verbs.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march spawn
march spawn --help
```

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Help text | stdout | Lists available spawn verbs (e.g., `dispatch`) with descriptions. |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| No verb provided | 2 | Prints help and exits with usage error. Replaces Feature 1's "not yet implemented" stub. |

---

### Dispatch Pipeline (internal contract)

**Purpose**: Define the sequential stages of the dispatch pipeline, their ordering constraints, and their cleanup responsibilities.
**Consumers**: The `march spawn dispatch` command implementation.
**Providers**: Internal modules (git operations, Docker operations, prompt finalization, backend invocation).

#### Pipeline Stages

```
1. Validate → 2. Worktree → 3. Snapshot → 4. Launch → 5. Handoff → 6. Wait → 7. Record
```

| Stage | Action | Produces | Cleanup on failure |
|-------|--------|----------|-------------------|
| 1. Validate | Check dependencies (git, docker), verify git repo context, verify base image available | Validation pass | None (no state created yet) |
| 2. Worktree | Create branch `march/spawn/<id>`, create worktree at `<repo>/../worktrees/march/<id>/` | Branch + worktree | Delete branch, remove worktree |
| 3. Snapshot | Generate Dockerfile, build image with worktree files | Docker image | Remove image, delete branch, remove worktree |
| 4. Launch | `docker run` with hardcoded security config | Running container | Stop and remove container, remove image, delete branch, remove worktree |
| 5. Handoff | Write finalized prompt to container, invoke backend CLI | Backend process running inside container | (Contained within stage 4's container) |
| 6. Wait | Block until container exits or timeout | Exit code | Kill container on timeout |
| 7. Record | Write SpawnRecord to `~/.march/spawns/<id>.json` | SpawnRecord file | (Always runs, even on failure) |

Ordering constraints:
- Stages 1-7 execute sequentially. No stage begins until the prior stage completes.
- Stage 7 (Record) runs unconditionally — on success, failure, and timeout. It records whatever state is available.
- Cleanup runs in reverse order: later artifacts are cleaned up before earlier ones.
- Exception: Stage 6 (Wait) does NOT clean up the stopped container. The container must remain for Feature 5 extraction.

---

### Worktree Operations (internal contract)

**Purpose**: Define the git operations for worktree and branch creation.
**Consumers**: Pipeline stage 2.
**Providers**: Git CLI (via `child_process`).

#### Operations

| Operation | Command | Notes |
|-----------|---------|-------|
| Generate SpawnId | (internal) | `YYYYMMDD-<6-char-hex>` from date + `crypto.randomBytes(3)`. |
| Detect repo root | `git rev-parse --show-toplevel` | Fails if not in a git repo. |
| Create branch | `git branch march/spawn/<id> <base-ref>` | `<base-ref>` defaults to `HEAD`. |
| Create worktree | `git worktree add <repo>/../worktrees/march/<id>/ march/spawn/<id>` | Links worktree to the new branch. |
| List tracked files | `git ls-files` (in worktree) | Used for snapshot file list. |

#### Branch Naming Convention

```
march/spawn/<spawn-id>
```

Example: `march/spawn/20260411-a1b2c3`

The `march/spawn/` prefix namespaces all spawn branches, keeping them visually grouped in `git branch` output and avoiding conflicts with other branch naming conventions.

---

### Docker Operations (internal contract)

**Purpose**: Define the Docker operations for image building and container launching.
**Consumers**: Pipeline stages 3 and 4.
**Providers**: Docker CLI (via `child_process`).

#### Image Build

A temporary Dockerfile is generated for each spawn:

```dockerfile
FROM <base-image-tag>
COPY --chown=march:march . /march/workspace
WORKDIR /march/workspace
```

The Docker build context is a temporary directory containing only the files from `git ls-files` minus the exclusion list. The base image is a pre-built image containing the backend CLI and a non-root `march` user.

Build command:
```
docker build -t march-spawn-<spawn-id> -f <temp-dockerfile> <build-context-dir>
```

#### Container Launch

```
docker run \
  --name march-spawn-<spawn-id> \
  --cap-drop=ALL \
  --user march \
  --memory <memory-limit> \
  --cpus <cpu-limit> \
  -e <whitelisted-env-vars> \
  march-spawn-<spawn-id> \
  <backend-entrypoint-command>
```

The backend entrypoint command is constructed by the `SpawnBackend.buildEntrypoint()` method. Because Docker's exec form (`["cmd", "arg", ...]`) does not invoke a shell, the entrypoint must explicitly use `sh -c` when shell expansion is needed. For Claude Code:

```
sh -c 'claude -p "$(cat /march/prompt.txt)" \
  --output-format json \
  --dangerously-skip-permissions \
  --bare \
  --no-session-persistence'
```

#### Snapshot Exclusion List

Files excluded from the Docker build context (in addition to untracked files and files ignored by `.gitignore`):

| Pattern | Reason |
|---------|--------|
| `.env` | Environment secrets |
| `.env.*` | Environment variant files |
| `*.pem` | Private keys |
| `*.key` | Private keys |
| `.secrets/` | Secret directories |
| `credentials.json` | Service account credentials |

This list is hardcoded in Feature 2. Feature 4 may expand it based on threat model evaluation. Hatchery (M2) makes it configurable per profile.

---

### SpawnRecord Output (output contract)

**Purpose**: Define the structure of the SpawnRecord JSON file written by Feature 2, consumed by Features 5 and 6.
**Consumers**: Feature 5 (Output Extraction), Feature 6 (PR Integration), operator (for manual inspection).
**Providers**: Feature 2 (Spawn Dispatch).

#### Schema

```json
{
  "version": 1,
  "id": "20260411-a1b2c3",
  "repoPath": "/home/user/myproject",
  "branch": "march/spawn/20260411-a1b2c3",
  "worktreePath": "/home/user/worktrees/march/20260411-a1b2c3",
  "containerId": "a1b2c3d4e5f6789012345678abcdef0123456789012345678abcdef0123456789",
  "imageId": "march-spawn-20260411-a1b2c3",
  "backend": "claude-code",
  "status": "stopped",
  "exitCode": 0,
  "prompt": "Implement the login page...",
  "createdAt": "2026-04-11T14:30:00.000Z",
  "startedAt": "2026-04-11T14:30:05.000Z",
  "stoppedAt": "2026-04-11T14:35:22.000Z",
  "timedOut": false
}
```

Feature 5 depends on: `containerId` (to extract output), `worktreePath` (to apply patches), `branch` (to identify the spawn's branch), `status` (to verify the spawn is stopped before extraction).

Feature 6 depends on: `branch` (to push), `worktreePath` (to apply patches), `repoPath` (to identify the source repo), `prompt` (for PR metadata).

---

### SpawnBackend Interface (extension contract)

**Purpose**: Define the interface boundary between Feature 2 (dispatch) and Feature 3 (multi-backend execution).
**Consumers**: Feature 2 (dispatch pipeline), Feature 3 (backend implementations).
**Providers**: Feature 2 (defines interface + Claude Code implementation), Feature 3 (adds Gemini implementation + backend selection).

#### Interface

```typescript
interface SpawnBackend {
  /** Backend identifier (e.g., "claude-code", "gemini"). */
  name: string;

  /** Base Docker image tag that has this backend CLI pre-installed. */
  baseImage: string;

  /** Environment variable names the backend requires. */
  requiredEnvVars: string[];

  /**
   * Constructs the container entrypoint command.
   * @param promptFilePath - Path to the finalized prompt file inside the container.
   * @returns Array of command and arguments for the container entrypoint.
   */
  buildEntrypoint(promptFilePath: string): string[];
}
```

#### Claude Code Implementation (Feature 2)

```
name: "claude-code"
cliCommand: "claude"
requiredEnvVars: ["ANTHROPIC_API_KEY"]
buildEntrypoint("/march/prompt.txt"):
  ["sh", "-c",
   "claude -p \"$(cat /march/prompt.txt)\" --output-format json --dangerously-skip-permissions --bare --no-session-persistence"]
```

Feature 3 will:
1. Add a Gemini implementation with its own `buildEntrypoint` and `requiredEnvVars`.
2. Add a backend selection mechanism (CLI flag or configuration).
3. May extend the interface with additional methods (e.g., `parseExitCode`, `validateAuth`).

---

### Command Dispatch Extension (integration contract)

**Purpose**: Define how Feature 2 integrates with the Feature 1 CLI command dispatch.
**Consumers**: Feature 2 implementation.
**Providers**: Feature 1 (CLI Foundation).

#### Changes to Feature 1

Feature 2 replaces the `spawn` stub registered at Feature 1's CLI dispatch. The stub:

```typescript
// Feature 1 stub (to be replaced)
program.command("spawn [subcommand]")
  .allowUnknownOption()
  .action(() => { /* "not yet implemented" */ });
```

Is replaced with a Commander subcommand group:

```typescript
// Feature 2 replacement
const spawn = program.command("spawn")
  .description("Spawn operations");

spawn.command("dispatch")
  .description("Dispatch a spawn")
  .option("--prompt-file <path>", "Path to prompt file")
  .option("--prompt <string>", "Prompt text")
  .action(async (options) => {
    // Enforce "exactly one of --prompt-file, --prompt, or stdin" in validation logic
    /* dispatch logic */
  });
```

The `spawn` subcommand group allows Feature 3-6 to register additional verbs (e.g., `spawn extract`, `spawn push`) without modifying the dispatch code.

## Events / Hooks

No events or hooks are introduced by Feature 2. Herald (the shipped event-sourced **observation** service, not an "event bus") records lifecycle changes as events the legate drains via `GET /events?after=<cursor>`; Brood holds canonical session state. Feature 2's SpawnRecord is the M1 passive state artifact — superseded by the Brood registry, with lifecycle changes observed by Herald rather than downstream features polling a JSON file.

## Integration Boundaries

- **Git CLI**: Feature 2 invokes `git` via `child_process.execFileSync` / `execFile` for worktree operations, branch creation, file listing, and repo root detection. Git must be on PATH. No library dependency on a git binding.
- **Docker CLI**: Feature 2 invokes `docker` via `child_process` for image builds and container management. Docker daemon must be running. No library dependency on a Docker SDK.
- **Backend CLI (Claude Code)**: Feature 2 invokes the backend CLI inside the Docker container as the container's entrypoint. The backend CLI is pre-installed in the base Docker image. Feature 2 does not install the backend CLI — it assumes the base image provides it.
- **Filesystem (`~/.march/spawns/`)**: Feature 2 creates and writes SpawnRecord files here. This directory is separate from the installation manifest at `~/.march/march-manifest.json`. Feature 2 creates the directory if it does not exist.
- **Filesystem (`<repo>/../worktrees/march/`)**: Feature 2 creates worktree directories here. This path is a sibling to the git repository, outside the repo tree. This avoids dot-directory visibility issues on macOS and prevents TUI agents running against the repo from accessing spawn worktrees.
- **Feature 1 (CLI Foundation)**: Feature 2 extends the `spawn` command namespace by replacing the stub with a proper subcommand group. Feature 2 depends on Feature 1's exit code constants, dependency check utilities, and Commander program instance.
- **Feature 3 (Multi-Backend Execution Interface)**: Feature 2 defines the `SpawnBackend` interface that Feature 3 implements. Feature 2 ships a hardcoded Claude Code backend. Feature 3 replaces it with a polymorphic selection mechanism.
- **Feature 4 (Spawn Sandbox Security)**: Feature 2 ships a hardcoded security configuration (SpawnConfig). Feature 4 audits this configuration against the RFC's Appendix A threat model and may tighten it. The Docker network policy (bridge mode in Feature 2) is a known gap that Feature 4 addresses.
- **Feature 5 (Spawn Output Extraction)**: Feature 2 leaves a stopped container and a SpawnRecord. Feature 5 reads the SpawnRecord to locate the container and extract its output. The handoff contract is: Feature 2 guarantees the container is stopped and the SpawnRecord exists with `containerId`, `status`, `worktreePath`, and `branch` fields populated.
