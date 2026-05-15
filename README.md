# March CLI

CLI for the **March** agentic-development workflow. March deploys a small set of Claude Code skills, then takes a worktree of your repo, snapshots it into a Docker image, and dispatches a sandboxed *spawn* for an agent to work inside.

## Installation

You can run March directly via `npx` (recommended):

```bash
npx @balexda/march init
```

Or install it globally:

```bash
npm install -g @balexda/march
march init
```

Requires Node 20 or 22. `march spawn dispatch` additionally requires `git` and `docker` on `PATH`. `march legate init` requires `git`, [`agent-deck`](https://github.com/asheshgoplani/agent-deck), and Python 3.9+ for agent-deck's conductor bridge; `march legate init --with-container` also requires Docker and runs the deterministic Legate loop inside the managed container.

## Supported AI Assistants

- **Claude:** `march init` deploys placeholder skill files into `~/.claude/commands/` and `~/.claude/prompts/` for use within your Claude Code workflows.

## Commands

| Command | Purpose |
| :--- | :--- |
| `march init` | Initialize the March environment (manifest at `~/.march/march-manifest.json` + Claude skills under `~/.claude/`). |
| `march update` | Update an existing March installation; prompts on downgrade unless `--yes`. |
| `march spawn dispatch` | Create a worktree, snapshot it as a Docker build context, build `march-spawn-<id>`, launch the container with hardened security configuration, and transition the SpawnRecord to `"running"`. |
| `march legate init` | Set up a per-repo Legate agent plus paired deterministic loop for the Smithy plan→PR→fix workflow on top of [agent-deck](https://github.com/asheshgoplani/agent-deck). Pass `--with-container` to run the loop in the Hatchery-managed Legate container while the agent-deck loop pane tails its logs. |
| `march version` | Print the installed CLI version. |
| `march help [command]` | Show help for a command. |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing strategy, and pre-release checklist.
