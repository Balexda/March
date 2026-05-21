# Contracts: March CLI Foundation

## Overview

This document defines the interface contracts for the March CLI Foundation: the command dispatch surface, the `march init` and `march update` behaviors, and the skill deployment mechanism. Contracts are expressed as behavioral specifications (inputs, outputs, exit codes, filesystem effects) without prescribing implementation language or framework.

## Interfaces

### march init

**Purpose**: Bootstrap a new March installation at user level.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march init [--yes]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--yes` | flag | No | Skip confirmation prompts and use defaults. For non-interactive/scripted usage. |

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Manifest created | `~/.march/march-manifest.json` | JSON file tracking installation state. |
| Skills deployed | `~/.claude/commands/march.*.md`, `~/.claude/prompts/march.*.md` | Markdown skill files for the Claude agent backend. |
| Warnings printed | stderr | Informational warnings if git or Docker are not found on PATH. |
| Success message | stdout | Confirmation of what was created/deployed. |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| Home directory not writable | 1 | `~/.march/` or `~/.claude/` cannot be created. |
| Manifest already exists | 1 | March is already installed. Prints message directing the user to run `march update` instead. |
| Invalid environment | 1 | Unexpected filesystem errors during file creation. |

---

### march update

**Purpose**: Upgrade an existing March installation to match the current CLI version.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march update [--yes]
```

#### Inputs

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `--yes` | flag | No | Skip confirmation prompts (e.g., downgrade warning). |

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Manifest updated | `~/.march/march-manifest.json` | `marchVersion` and `files` mapping updated. |
| New skills deployed | `~/.claude/commands/`, `~/.claude/prompts/` | Files in the new version but not in the old manifest are added. |
| Stale skills removed | `~/.claude/commands/`, `~/.claude/prompts/` | Files in the old manifest but not in the new version are deleted. |
| Untracked files preserved | — | Files on disk not tracked by the manifest are left untouched. |
| Summary printed | stdout | List of added, removed, and unchanged files. |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| No existing installation | 1 | No manifest found at `~/.march/march-manifest.json`. Error message directs user to run `march init`. |
| Already up to date | 0 | Same version installed. Informational message printed. |
| Downgrade detected | 0 (with warning) | CLI version is older than installed version. Warning printed; proceeds if `--yes` or user confirms. |
| File deletion failure | 1 | Cannot remove a stale file (permissions issue). |

---

### march spawn (stub)

**Purpose**: Placeholder for the spawn command namespace. Prints a "not yet implemented" message.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march spawn [<subcommand>] [options]
```

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Message printed | stdout | "march spawn is not yet implemented. It will be available after Feature 2: Spawn Dispatch." |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| Any invocation | 1 | Always exits with code 1 (not implemented). |

---

### march help

**Purpose**: Display help and usage information.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march help [<command>]
march --help
march <command> --help
```

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Help text | stdout | Plain text listing available commands (no arguments) or detailed help for a specific command. |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| No arguments | 0 | Prints general help listing all commands. |
| Valid command | 0 | Prints help for the specified command. |
| Invalid command | 2 | Prints error message with suggestions. |

---

### march version

**Purpose**: Display the installed CLI version.
**Consumers**: The operator (via terminal).
**Providers**: The March CLI binary.

#### Signature

```
march version
march --version
```

#### Outputs

| Effect | Location | Description |
|--------|----------|-------------|
| Version string | stdout | The CLI version (e.g., `march 0.1.0`). |

#### Error Conditions

| Condition | Exit Code | Description |
|-----------|-----------|-------------|
| Any invocation | 0 | Always succeeds. |

---

### Command Dispatch (extension contract)

**Purpose**: Define how subsequent features register their subcommands with the CLI.
**Consumers**: Features 2-6 (and future milestones).
**Providers**: Feature 1 (CLI Foundation).

#### Contract

Feature 1 owns the top-level command dispatch table. The CLI has two command tiers:

**Setup commands** — Single-token commands that affect all of March, not scoped to a subsystem. Pattern: `march <command> [options]`.

| Command | Owner | Description |
|---------|-------|-------------|
| `init` | Feature 1 | Bootstrap installation. |
| `update` | Feature 1 | Upgrade installation. |
| `help` | Feature 1 | Display help. |
| `version` | Feature 1 | Display version. |

**System commands** — Commands that target a specific March subsystem. Pattern: `march <system> <verb> [options]`. Each subsystem owns its verb namespace.

| System | Owner | Description |
|--------|-------|-------------|
| `spawn` | Features 2-6 | Spawn operations (dispatch, status, output). Stub in Feature 1. |
| `hatchery` | Milestone 2 | Containerized spawn-flow service. `serve` runs the flow; `spawn` is a thin HTTP client driving the steward via Castra and registering with Brood. **Shipped.** |
| `brood` | Milestone 3 | Session-state + teardown authority (container service; `serve`, `teardown`, `list`). **Shipped.** |
| `herald` | Milestone 4 | System-state observation, event-sourced log (container service; `serve`, `events`, `state`). **Shipped.** |
| `castra` | Castra (#153) | Interactive-sessions host fronting agent-deck over HTTP (`serve`). **Shipped.** |
| `legate` | Milestone 5 | Instrumented dispatch loop (container service; `init`, `loop`). **Shipped (provisional).** |

Verbs within a system namespace are owned by the feature that implements them (e.g., `march spawn dispatch` is owned by Feature 2). Each containerized service additionally exposes a long-running `serve` verb (the Fastify container entrypoint) and thin HTTP-client verbs for cross-service requests (e.g. `march brood teardown`). The dispatch mechanism must support adding new systems and verbs without modifying the core dispatch logic (implementation decision — not prescribed here).

---

### Skill Deployment (deployment contract)

**Purpose**: Define how skill source templates are deployed to agent-specific directories.
**Consumers**: `march init`, `march update`.
**Providers**: The skill source templates bundled with the CLI.

#### Contract

The SmithyCLI pattern for March:

1. **Source**: Skill templates are bundled with the March CLI binary (packaging mechanism is an implementation decision).
2. **Deployment targets per agent**:

| Agent | Commands Directory | Prompts Directory | Agents Directory |
|-------|--------------------|-------------------|------------------|
| `claude` | `~/.claude/commands/` | `~/.claude/prompts/` | `~/.claude/agents/` |

3. **File naming**: All deployed files use the prefix `march.` (e.g., `march.spawn-dispatch.md`). This prevents collisions with SmithyCLI or other tools sharing the same agent directories.
4. **Tracking**: Every deployed file path is recorded in the manifest's `files.<agent>` array, relative to the user's home directory with no leading `~/` (e.g., `.claude/commands/march.spawn-dispatch.md`).
5. **Removal**: During `march update`, files present in the old manifest's `files` but absent from the new deployment set are deleted. Files on disk not tracked by any manifest are never touched.

#### M1 Skill Categories

| Category | Purpose | Deploy Target |
|----------|---------|---------------|
| `spawn-dispatch` | Instructions for dispatching spawn tasks | `~/.claude/commands/` |
| `spawn-status` | Instructions for checking spawn status | `~/.claude/commands/` |
| `output-handling` | Instructions for working with spawn output | `~/.claude/prompts/` |

Skill content is authored during Features 2-6 implementation. Feature 1 deploys placeholder files that establish the file slots and deployment mechanism.

## Events / Hooks

No events or hooks are introduced by Feature 1. Herald (the shipped event-sourced observation service) defines the system event log — an append-only, seq-ordered log the legate drains via `GET /events?after=<cursor>`; it is the single sequencer, read-only by default, and never touches Docker (not an "event bus").

## Integration Boundaries

- **Claude Code agent directories** (`~/.claude/`): March deploys skill files here. March does not own this directory — it coexists with SmithyCLI and any other tools that deploy to the same locations. The `march.` filename prefix provides namespace isolation.
- **Filesystem**: March reads and writes to `~/.march/` (owned) and `~/.claude/` (shared). No other filesystem locations are touched.
- **PATH dependencies**: `march init` checks for `git` and `docker` on PATH as informational warnings. No programmatic integration with these tools occurs in Feature 1.
