# March CLI

CLI for the **March** agentic-development workflow. March deploys a small set of Claude Code skills, then takes a worktree of your repo, snapshots it into a Docker image, and dispatches a sandboxed *spawn* for an agent to work inside.

## Vision

**Smithy makes the ideas high-quality. March makes the execution low-touch.** Together they let a solo operator ship serious work without becoming the bottleneck — you bring the ideas and the judgment, March takes care of the chaos in between. Spawns run individual steps without babysitting; the Hatchery sets up containers without hand-tuning; Brood handles cleanup; Herald watches for state changes so you don't have to refresh `gh pr view`; Legate orchestrates multiple parallel work items; Stewards assemble each spawn's output into a reviewable PR. You walk away, and come back to either a green PR ready to merge or a clear diagnostic — never a hung session waiting for input it cannot receive.

Full statement: [`docs/vision.md`](docs/vision.md). Implementation-level guidance for contributors: [`docs/operating-philosophy.md`](docs/operating-philosophy.md).

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

## Observability

March emits OpenTelemetry traces and metrics — spawn success rate, spawn
runtime, and a trace per dispatched unit of work — to a local, all-in-one
Grafana stack. Telemetry is opt-in (`MARCH_OTEL=1`) and a complete no-op when
off; a missing collector never affects a command.

```bash
docker compose -f docker/otel-lgtm.docker-compose.yml up -d
open http://localhost:3000      # Grafana (admin/admin) → "March — Spawn observability"
```

Then run March with `MARCH_OTEL=1` set. Full details — enabling it per Legate
deployment, the trace/span and metric model, the provisioned dashboard, and how
to validate the stack — are in **[docs/Observability.md](docs/Observability.md)**.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing strategy, and pre-release checklist.
