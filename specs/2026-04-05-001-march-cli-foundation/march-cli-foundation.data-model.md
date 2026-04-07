# Data Model: March CLI Foundation

## Overview

This model supports the March CLI's installation tracking and skill deployment mechanism. It defines the manifest that tracks what is deployed and the skill entity that represents individual deployable files, following the SmithyCLI single-source multi-agent template pattern.

## Entities

### 1) MarchManifest (`march-manifest.json`)

Purpose: Tracks the state of a March installation — which version is installed, which agent backends are configured, and which files have been deployed. Stored at `~/.march/march-manifest.json`. This is the single source of truth for idempotent init and version-aware updates.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `version` | integer | Yes | Manifest schema version. Fixed at `1` for initial release. Used for future schema migrations. |
| `marchVersion` | string | Yes | Semantic version of the March CLI that created or last updated this manifest (e.g., `"0.1.0"`). |
| `deployLocation` | string | Yes | Always `"user"` for March. Included for structural parity with SmithyCLI and potential future extension. |
| `agents` | string[] | Yes | Array of agent backends with deployed files. Initially `["claude"]`. |
| `files` | object | Yes | Map of agent name to array of relative file paths deployed for that agent. E.g., `{ "claude": [".claude/commands/march.spawn-dispatch.md", ...] }`. Paths are relative to the user's home directory. |

Validation rules:
- `version` must be a positive integer.
- `marchVersion` must be a valid semantic version string.
- `deployLocation` must be `"user"`.
- `agents` must be a non-empty array of strings.
- Every agent in `agents` must have a corresponding key in `files`.
- Every path in `files` must use forward slashes and be relative to the user's home directory with no leading `~/` (e.g., `.claude/commands/march.spawn-dispatch.md`).

### 2) MarchSkill (deployed file)

Purpose: Represents a single skill or prompt file deployed from a source template to an agent-specific location. Skills are markdown instruction documents consumed by AI agents (pseudo-legate instructions), not executable code.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `filename` | string | Yes | The deployed filename, prefixed with `march.` to avoid collisions (e.g., `march.spawn-dispatch.md`). |
| `deployTarget` | string | Yes | The agent-specific directory where this file is placed (e.g., `~/.claude/commands/` or `~/.claude/prompts/`). |
| `category` | string | Yes | The skill category: `spawn-dispatch`, `spawn-status`, or `output-handling`. |
| `agent` | string | Yes | The target agent backend (e.g., `"claude"`). |

Validation rules:
- `filename` must start with `march.` and end with `.md`.
- `deployTarget` must be a valid directory path for the specified agent.
- `category` must be one of the defined skill categories for the current milestone.

Note: MarchSkill is not persisted as a separate entity — it is an internal concept. The manifest's `files` mapping is the persisted representation. The skill entity describes the structure and constraints for deployment logic.

## Relationships

- MarchManifest 1:N MarchSkill via the `files` mapping. Each agent key in `files` contains an array of deployed skill paths.

## State Transitions

### MarchManifest lifecycle

1. `absent` → `created`
   - Trigger: `march init` run for the first time
   - Effects: Manifest file created at `~/.march/march-manifest.json` with initial schema, skill files deployed to agent directories.

2. `created` → `updated`
   - Trigger: `march update` run with a newer CLI version
   - Effects: `marchVersion` updated, `files` mapping updated (new files added, stale files removed from disk and manifest), `agents` updated if new backends are added.

3. `created` → `rejected`
   - Trigger: `march init` run when manifest already exists
   - Effects: No changes. User directed to run `march update`.

4. `created` → `unchanged`
   - Trigger: `march update` run with the same version and no changes
   - Effects: No changes to manifest or deployed files.

## Identity & Uniqueness

- The MarchManifest is a singleton — exactly one exists per user at `~/.march/march-manifest.json`.
- MarchSkill files are uniquely identified by their full deployment path (agent directory + filename). The `march.` prefix provides namespace isolation from other tools.
