# March CLI

**March** is an agentic-development system: it takes a fully decomposed plan
(from [Smithy](docs/vision.md)) and turns it into a queue of reviewable PRs with
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
`docker` on `PATH`. `march up` / `march down` bring the service stack up and down
and need only Docker. Onboarding a repo — `march init <profile>` — additionally
requires [`agent-deck`](https://github.com/asheshgoplani/agent-deck) and Python
3.9+ for agent-deck's conductor bridge. `march init` with no profile does just
the first-run CLI bootstrap (manifest + base skills); pass a `<profile>` to also
bring the stack up and onboard a repo.

The service images (`march-castra`, `march-hatchery`, `march-brood`,
`march-herald`, `march-legate`) are **not yet published to a registry**, so
`march up` / `march init <profile>` currently require them to be built locally
from a source checkout first (`npm run build:images`). `march up` preflights the
images and reports the missing ones rather than starting a partial stack. Making
the stack pullable from a plain `npm i -g` is tracked in
[issue #438](https://github.com/Balexda/March/issues/438).

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
| `march legate recover <sliceId>` | Hand a stuck/escalated slice back to the loop's graduated recovery ladder: it un-escalates and tries to relaunch in place first (preserving the slice's branch/worktree/PR), and only tombstones for a fresh re-dispatch as a last resort — no manual state surgery. |
| `march legate respond <sliceId>` | Answer a steward escalated as `steward_awaiting_input` — deliver a reply into its live session (`--message`), or `--ack` to clear a false-positive escalation back to the normal fix→merge path. |
| `march legate requeue <sliceId>` | Throw away a slice's current attempt and put its work back in the queue: tears down the steward session, worktree and branch, then the loop re-dispatches it fresh. Use when a steward asked a question and then died, or went off the rails. Refuses a slice with an open PR unless `--close-pr`. |
| `march legate merge <sliceId>` | Merge a slice's open PR now (squash), bypassing the review/CI merge gates. The legate re-reads the PR, refuses a closed or conflicting one, and pins the merge to its current head SHA. Use instead of `gh pr merge` so the merge is in the event log. |
| `march legate relaunch <sliceId>` | Replace a wedged steward: remove its session if it is still alive (the worktree is kept) and attach a fresh steward to the existing PR and branch, skipping the self-heal backoff. |
| `march legate resend-threads <sliceId>` | Ask the steward to address review threads again: delivers `/smithy.fix` for the given unresolved threads (`--thread <id>...`, default all), even ones the loop already counts as sent. |
| `march legate tick` | Run a legate tick now instead of waiting for the interval. |
| `march legate pause` / `resume` | Pause fresh dispatch (in-flight work drains; relaunch, babysit, merge and recovery keep running) and resume it. The pause survives restarts. `--profile` narrows to one profile. |

Every one of these goes through the legate's operator API, and each appends an event that records who asked (`--operator`, default `$MARCH_OPERATOR` or your OS username) and why (`--reason`). Set `MARCH_LEGATE_OPERATOR_TOKEN` on the legate and in your shell to require a bearer token for them. `march profile merge-policy set` records its change the same way.

`march version` / `march help [command]` round out the set. `march legate init`
is deprecated — it prints a deprecation warning and then runs the same profile
onboarding flow as `march init [profile]`, which supersedes the old per-profile
conductor flow (a single shared `march-legate` service now drives every profile).

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
