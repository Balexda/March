# March CLI

**March** is an agentic-development system: it takes a fully decomposed plan
(from [Smithy](docs/vision.md)) and runs it to a queue of reviewable PRs with
minimum operator intervention. Under the hood it runs as a small stack of
coordinated, containerized services, but you deploy and operate it with a few
high-level commands — `march init`, `march up`, `march down`. The `march` CLI is
your control surface over the stack; you rarely need to touch the individual
services directly.

At the core, a *spawn* is one unit of work: March takes a worktree of your repo,
snapshots it into a Docker image, and dispatches a hardened, sandboxed container
for an agent to work inside. Everything else — deciding what to spawn next,
assembling the patch into a PR, cleaning up, watching for state changes — is what
the surrounding services automate.

## Vision

**Smithy makes the ideas high-quality. March makes the execution low-touch.** Together they let a solo operator ship serious work without becoming the bottleneck — you bring the ideas and the judgment, March takes care of the chaos in between. Spawns run individual steps without babysitting; the Hatchery sets up containers without hand-tuning; Brood handles cleanup; Herald watches for state changes so you don't have to refresh `gh pr view`; Legate orchestrates multiple parallel work items; Stewards assemble each spawn's output into a reviewable PR. You walk away, and come back to either a green PR ready to merge or a clear diagnostic — never a hung session waiting for input it cannot receive.

Full statement: [`docs/vision.md`](docs/vision.md). Implementation-level guidance for contributors: [`docs/operating-philosophy.md`](docs/operating-philosophy.md). The open engine / private value-layer split — what stays open-source and what is the commercial moat — is recorded in [`docs/open-core-boundary.md`](docs/open-core-boundary.md). Building or operating the internals? The per-service breakdown and source ownership live in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

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

Requires Node 20 or 22. `march spawn dispatch` additionally requires `git` and
`docker` on `PATH`. Standing up the full stack — `march init <profile>` and
`march up` — additionally requires Docker, [`agent-deck`](https://github.com/asheshgoplani/agent-deck),
and Python 3.9+ for agent-deck's conductor bridge. `march init` with no profile
does just the first-run CLI bootstrap (manifest + base skills); pass a
`<profile>` to also bring the stack up and onboard a repo.

## Supported AI Assistants

- **Claude:** `march init` deploys placeholder skill files into `~/.claude/commands/` and `~/.claude/prompts/` for use within your Claude Code workflows.

## Commands

Day to day you deploy and operate the stack with a handful of high-level verbs;
the rest are container entrypoints and internals covered in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

**Deploy & operate the stack**

| Command | Purpose |
| :--- | :--- |
| `march init [profile]` | First run bootstraps the CLI install (manifest at `~/.march/march-manifest.json` + base skills under `~/.claude/`); with a `<profile>` it also brings the stack up, registers the profile, and onboards the repo. The single entry point for standing March up. |
| `march up` / `march down` | Bring the March service stack up (in dependency order) / stop it. |
| `march status` | Report stack health: per-service state, HTTP reachability, and token wiring. |
| `march doctor` | Diagnose the local environment and prerequisites. |
| `march self update` | Update the March CLI installation to match the current CLI version (prompts on downgrade unless `--yes`). |

**Handle escalations** — the operator's deliberate intervention surface, for the rare slice that genuinely needs judgment

| Command | Purpose |
| :--- | :--- |
| `march legate recover <sliceId>` | Recover a stuck/escalated slice: the running Legate drops it and re-dispatches the still-ready work fresh — no restart, no manual state surgery. |
| `march legate respond <sliceId>` | Answer a steward escalated as `steward_awaiting_input` — deliver a reply into its live session (`--message`), or `--ack` to clear a false-positive escalation back to the normal fix→merge path. |

`march version` / `march help [command]` round out the set. `march legate init`
is deprecated — it warns and forwards to `march init [profile]`, which supersedes
the old per-profile conductor flow (a single shared `march-legate` service now
drives every profile).

## Observability

March emits OpenTelemetry traces, metrics, and logs — spawn success rate, spawn
runtime, a trace per dispatched unit of work, and Hatchery service health — to a
local, all-in-one Grafana stack. Telemetry is opt-in (`MARCH_OTEL=1`) and a
complete no-op when off; a missing collector never affects a command.

```bash
docker compose -f docker/otel-lgtm.docker-compose.yml up -d
open http://localhost:3000      # Grafana (admin/admin) → "March — Spawn observability" / "March — Hatchery service"
```

Then run March with `MARCH_OTEL=1` set. Full details — enabling it per Legate
deployment, the trace/span/metric/log model, the Hatchery service, the
provisioned dashboards, and how to validate the stack — are in
**[docs/Observability.md](docs/Observability.md)**.

## Testing

March uses a layered testing strategy — an L0–L3 scope ladder (unit → subsystem
→ cross-subsystem → full-loop) crossed with a determinism axis, and a **cassette
pivot** that replays recorded backend exchanges so integration-scope tests run
deterministically on the PR gate at $0 while a separate scheduled suite exercises
live backends. The principles are in
**[docs/testing-strategy.md](docs/testing-strategy.md)**; the milestone plan is
the [layered-testing-framework RFC](docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, day-to-day test commands, and the pre-release checklist.
