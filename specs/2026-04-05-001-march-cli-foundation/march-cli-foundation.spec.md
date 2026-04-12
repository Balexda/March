# Feature Specification: March CLI Foundation

**Spec Folder**: `2026-04-05-001-march-cli-foundation`
**Branch**: `2026-04-05-001-march-cli-foundation`
**Created**: 2026-04-05
**Status**: Draft
**Input**: `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md` — Milestone 1: Spawn
**Source Feature Map**: `docs/rfcs/2026-001-march-orchestration-platform/01-spawn.features.md` — Feature 1: March CLI Foundation

## Clarifications

### Session 2026-04-05

- Q: What skill categories does `march init` deploy at M1? → A: Deploy placeholder skills in categories: spawn dispatch, spawn status, and output handling. These are pseudo-legate instruction documents that give the operator's AI agent context about spawn concepts. Actual content is authored during Features 2-6 implementation, but the deployment mechanism and file slots are established now.
- Q: Does `march init` require being run inside a git repo? → A: No. `march init` installs to `~/.march/` and deploys skills to `~/.claude/`. Git and Docker checks are informational warnings at init time ("git not found — required for spawn"), not hard failures. Hard failure only if the home directory locations are unwritable.
- Q: Does March need an `update`/`upgrade` command separate from `init`? → A: Yes. Follow SmithyCLI pattern — `march init` for first setup, `march update` for upgrades (version-compare, redeploy, stale cleanup). This separates the first-time flow (with prompts/config) from the upgrade flow (preserve existing config).

### Assumptions

- MarchManifest schema mirrors SmithyCLI's structure: `deployLocation` is always `"user"`, `agents` starts as `["claude"]`, `files` maps agent names to arrays of deployed file paths. `marchVersion` tracks the CLI version.
- Skills deploy to `~/.claude/commands/` and `~/.claude/prompts/` following SmithyCLI's user-level Claude deploy conventions.
- `march spawn` (no verb) prints "not yet implemented" and exits code 1.
- Stale file removal: files in manifest but not in new deployment set are deleted; files on disk but not in manifest are left untouched (treated as user customizations).
- The CLI binary name is `march` (the `march` vs `the-march` naming question remains open at the RFC level; this spec uses `march` throughout).

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Initialize March Environment (Priority: P1)

As an operator, I want to run `march init` so that my March environment is bootstrapped with the manifest, configuration, and spawn-interaction skills deployed to my AI agent.

**Why this priority**: This is the foundational action — nothing else works without init. Every other story depends on a working March environment.

**Independent Test**: Run `march init` in a clean environment (no `~/.march/`). Verify that `~/.march/march-manifest.json` is created, skill files are deployed to `~/.claude/commands/` and `~/.claude/prompts/`, and the command exits with code 0.

**Acceptance Scenarios**:

1. **Given** no existing March installation, **When** the operator runs `march init`, **Then** `~/.march/march-manifest.json` is created with the correct schema (version, marchVersion, deployLocation: "user", agents: ["claude"], files mapping), skill files are deployed to `~/.claude/commands/` and `~/.claude/prompts/`, and the command exits with code 0.
2. **Given** git is not installed on the system, **When** the operator runs `march init`, **Then** init completes successfully but prints a warning: "git not found — required for spawn operations."
3. **Given** Docker is not installed on the system, **When** the operator runs `march init`, **Then** init completes successfully but prints a warning: "Docker not found — required for spawn operations."
4. **Given** the home directory locations (`~/.march/`, `~/.claude/`) are not writable, **When** the operator runs `march init`, **Then** init fails with a clear error message and exits with code 1.
5. **Given** an existing March installation (any version), **When** the operator runs `march init`, **Then** init prints a message that March is already installed and directs the user to run `march update`, and exits with code 1.

---

### User Story 2: Deploy Spawn-Interaction Skills (Priority: P1)

As an operator, I want `march init` to deploy spawn-interaction skill files to my AI agent's directories so that my AI agent has context about spawn concepts from the start.

**Why this priority**: Skills are the primary deliverable of the SmithyCLI pattern. Without deployed skills, the CLI is just a binary with no agent integration.

**Independent Test**: After `march init`, verify that skill files exist in `~/.claude/commands/` and/or `~/.claude/prompts/` matching the categories defined in the manifest. Verify each file is valid markdown.

**Acceptance Scenarios**:

1. **Given** a clean environment, **When** the operator runs `march init`, **Then** placeholder skill files are deployed for spawn dispatch, spawn status, and output handling categories to `~/.claude/commands/` and/or `~/.claude/prompts/`.
2. **Given** a completed init, **When** the operator inspects the manifest's `files.claude` array, **Then** every file path listed in the array exists on disk at the expected location.
3. **Given** deployed skill files, **When** the operator opens a Claude Code session, **Then** the deployed skills are discoverable by the AI agent as commands or prompts.

---

### User Story 3: Update March Installation (Priority: P1)

As an operator, I want to run `march update` so that my deployed skills and manifest are upgraded to match a newer CLI version without losing my customizations.

**Why this priority**: The RFC requires each milestone to ship new skills. Without an update mechanism, operators must manually manage file deployments across versions.

**Independent Test**: Install version N, run `march init`. Simulate version N+1 with additional skill files. Run `march update`. Verify new files are added, stale files (in old manifest but not in new set) are removed, and files not tracked by the manifest are preserved.

**Acceptance Scenarios**:

1. **Given** an existing installation at version N, **When** the operator runs `march update` with CLI version N+1, **Then** new skill files are deployed, stale files are removed, the manifest is updated with the new version and file list, and the command exits with code 0.
2. **Given** an existing installation at the same version, **When** the operator runs `march update`, **Then** the operator is informed that the installation is up to date.
3. **Given** an existing installation at a newer version than the CLI, **When** the operator runs `march update`, **Then** the operator is warned about the downgrade before proceeding.
4. **Given** user-created files in `~/.claude/commands/` that are NOT tracked in the manifest, **When** the operator runs `march update`, **Then** those files are preserved (not deleted).

---

### User Story 4: CLI Command Structure and Dispatch (Priority: P1)

As an operator, I want a well-structured CLI with two command tiers so that I have a consistent, discoverable interface for all March operations.

The CLI has two command tiers:
- **Setup commands**: Single-token commands that affect all of March (e.g., `march init`, `march update`, `march help`, `march version`). These are not scoped to a subsystem.
- **System commands**: `march <system> <verb>` commands that target a specific March subsystem (e.g., `march spawn dispatch`, `march brood status`). The system noun identifies which subsystem (spawn, hatchery, brood, herald, legate), and the verb identifies the operation.

**Why this priority**: The CLI is described as a "first-class deliverable, not scaffolding." The command structure is the surface that all subsequent features plug into.

**Independent Test**: Run `march` with no arguments. Verify it prints usage information listing available commands in both tiers. Run `march spawn`. Verify it prints "not yet implemented" and exits with code 1.

**Acceptance Scenarios**:

1. **Given** a working March installation, **When** the operator runs `march` with no arguments, **Then** usage information is printed to stdout listing setup commands (`init`, `update`, `help`, `version`) and system namespaces (`spawn`) and the command exits with code 2.
2. **Given** a working March installation, **When** the operator runs `march spawn`, **Then** a "not yet implemented" message is printed and the command exits with code 1.
3. **Given** any valid command, **When** the operator runs `march <command> --help`, **Then** help text for that specific command is printed to stdout.
4. **Given** an invalid command, **When** the operator runs `march nonexistent`, **Then** an error message is printed suggesting valid commands and the command exits with code 2.

---

### User Story 5: Help and Version Output (Priority: P2)

As an operator, I want `march help` and `march version` commands so that I can discover available commands and verify which version is installed.

**Why this priority**: Important for usability but not blocking for core functionality.

**Independent Test**: Run `march help` and verify it lists all commands with descriptions. Run `march version` and verify it prints the CLI version string.

**Acceptance Scenarios**:

1. **Given** a working March installation, **When** the operator runs `march help`, **Then** a list of all available commands with brief descriptions is printed to stdout.
2. **Given** a working March installation, **When** the operator runs `march version`, **Then** the CLI version string is printed (matching `marchVersion` in the manifest).
3. **Given** a working March installation, **When** the operator runs `march --help`, **Then** the output is identical to `march help`.
4. **Given** a working March installation, **When** the operator runs `march --version`, **Then** the output is identical to `march version`.

---

### User Story 6: Dependency Warnings at Init Time (Priority: P2)

As an operator, I want `march init` to check for git and Docker and warn me if they are missing so that I know what I need to install before using spawn features.

**Why this priority**: Useful for operator experience but does not block init itself. Git and Docker are needed at Feature 2+ (spawn), not Feature 1.

**Independent Test**: Remove git from PATH, run `march init`. Verify init succeeds and prints a git warning. Repeat for Docker.

**Acceptance Scenarios**:

1. **Given** git is on PATH, **When** the operator runs `march init`, **Then** no git warning is printed.
2. **Given** Docker is on PATH, **When** the operator runs `march init`, **Then** no Docker warning is printed.
3. **Given** both git and Docker are missing, **When** the operator runs `march init`, **Then** both warnings are printed but init still completes successfully.
4. **Given** git is missing, **When** the operator later attempts `march spawn`, **Then** the command fails with a clear error about the missing dependency (not a cryptic error from a failed git call).

### Edge Cases

- `march init` is run with `~/.claude/` directory missing entirely — init should create it.
- `march init` is run when `~/.march/march-manifest.json` exists but is corrupted/invalid JSON — init should warn and offer to reinitialize.
- `march update` is run before `march init` — should fail with a clear error directing the user to run `march init` first.
- Concurrent `march init` runs — not expected for a solo operator tool; no concurrency guarantees required.
- Skill files with names that collide with existing SmithyCLI skills in `~/.claude/commands/` — March skills should use a `march.` prefix (e.g., `march.spawn-dispatch.md`) to avoid collisions.

## Story Dependency Order

Recommended implementation sequence:

- [x] **User Story 1: Initialize March Environment** — No dependencies; establishes project skeleton, manifest, and skill deployment that all other stories build on → `specs/2026-04-05-001-march-cli-foundation/01-initialize-march-environment.tasks.md`
- [x] **User Story 2: Deploy Spawn-Interaction Skills** — Depends on Story 1 for deployment mechanism and skill file slots → `specs/2026-04-05-001-march-cli-foundation/02-deploy-spawn-interaction-skills.tasks.md`
- [x] **User Story 3: Update March Installation** — Depends on Story 1 for manifest schema and Story 2 for skill format invariants → `specs/2026-04-05-001-march-cli-foundation/03-update-march-installation.tasks.md`
- [x] **User Story 5: Help and Version Output** — No dependency on Stories 2-3; only needs the CLI entry point from Story 1; can parallelize with Stories 2-3 → `specs/2026-04-05-001-march-cli-foundation/05-help-and-version-output.tasks.md`
- [x] **User Story 4: CLI Command Structure and Dispatch** — Depends on Stories 1, 3, and 5 for full command registration; validates no-args listing includes all commands → `specs/2026-04-05-001-march-cli-foundation/04-cli-command-structure-and-dispatch.tasks.md`
- [x] **User Story 6: Dependency Warnings at Init Time** — Depends on Stories 1 and 4; extends deps.ts and spawn command behavior → `specs/2026-04-05-001-march-cli-foundation/06-dependency-warnings-at-init-time.tasks.md`

## Requirements

### Functional Requirements

- **FR-001**: The `march init` command MUST create `~/.march/march-manifest.json` with the schema defined in the data model.
- **FR-002**: The `march init` command MUST deploy skill files to agent-specific directories (`~/.claude/commands/`, `~/.claude/prompts/`) and record them in the manifest's `files` mapping.
- **FR-003**: The `march init` command MUST detect an existing installation (manifest present) and direct the user to `march update` instead, exiting with code 1.
- **FR-004**: The `march update` command MUST compare the installed version against the CLI version and redeploy files accordingly, removing stale files tracked in the old manifest but absent from the new deployment set.
- **FR-005**: The `march update` command MUST preserve files on disk that are NOT tracked in the manifest (user customizations).
- **FR-006**: The CLI MUST support two command tiers: (a) **setup commands** — single-token commands that affect all of March (`init`, `update`, `help`, `version`), and (b) **system commands** — `march <system> <verb>` commands that target a specific March subsystem (`spawn`, `hatchery`, `brood`, `herald`, `legate`). System commands MUST use the `march <system> <verb>` pattern with a dispatch mechanism that subsequent features can extend.
- **FR-007**: The CLI MUST provide a stub for the `march spawn` system namespace that prints "not yet implemented" and exits with code 1.
- **FR-008**: Every command MUST support a `--help` flag that prints usage information to stdout.
- **FR-009**: The CLI MUST use exit codes consistently: 0 (success), 1 (error), 2 (usage error).
- **FR-010**: The `march init` command MUST check for git and Docker on PATH and print warnings if either is missing, without failing.
- **FR-011**: The `march init` command MUST fail with exit code 1 if `~/.march/` or `~/.claude/` cannot be created or written to.
- **FR-012**: Deployed skill files MUST use a `march.` prefix in their filenames to avoid collisions with other tools (e.g., SmithyCLI).
- **FR-013**: The `march version` command MUST print the CLI version string.

### Key Entities

- **MarchManifest**: User-level configuration tracking deployed files, agent backends, and CLI version. Stored at `~/.march/march-manifest.json`.
- **MarchSkill**: An individual skill/prompt source file with deployment targets per agent backend. Tracked in the manifest's `files` mapping.

## Assumptions

- March is a user-level install only. There is no repo-level deployment mode.
- The initial and only agent backend at M1 is Claude Code (`"claude"`).
- The SmithyCLI pattern (one source markdown, deployed to agent-specific directories, tracked in manifest) is the authoritative deployment model.
- Skill content (the actual markdown instructions) is authored during Features 2-6 implementation. Feature 1 establishes the deployment mechanism and deploys placeholder files.
- The CLI binary name is `march` (pending RFC-level resolution of `march` vs `the-march`).

## Out of Scope

- Spawn execution logic (Feature 2: Spawn Dispatch).
- Container management and Docker interactions beyond existence checking (Features 2, 4).
- Hatchery profile management (Milestone 2).
- Multi-agent backend support beyond the manifest schema accommodating it (Feature 3).
- Skill content authoring — only the deployment mechanism and placeholder files.
- Web UI, plugin/extension system (RFC out of scope).
- Multi-user support (RFC out of scope).

## Success Criteria

### Measurable Outcomes

- **SC-001**: `march init` creates a valid manifest and deploys all expected skill files in under 5 seconds on a standard system.
- **SC-002**: `march init` run on an existing installation exits with code 1 and directs the user to `march update`.
- **SC-003**: `march update` from version N to N+1 adds new files, removes stale files, and preserves untracked files.
- **SC-004**: All CLI commands (`init`, `update`, `spawn`, `help`, `version`) respond to `--help` with usage information.
- **SC-005**: Exit codes are consistent across all commands: 0 for success, 1 for errors, 2 for usage errors.
- **SC-006**: Dependency warnings for missing git/Docker are printed during init without blocking completion.
- **SC-007**: Deployed skill files are discoverable by Claude Code as commands/prompts when the operator opens a session.
