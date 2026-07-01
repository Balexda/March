# Contributing to March CLI

## Development Setup

```bash
npm install
npm run build        # Build with tsup
npm run typecheck    # Type-check without emitting
npm test             # Run all tests
```

Always use `npm run` scripts. Do not use `npx tsx`, `npx vitest`, or similar direct invocations.

## Source Layout

March's source is organized by product subsystem rather than by generic layers:

| Directory | Ownership |
|-----------|-----------|
| `src/cli.ts` | Executable bin entrypoint only; delegates to `src/cli/program.ts`. |
| `src/cli/` | Commander program setup and command dispatch. |
| `src/bootstrap/` | CLI-installation bootstrap (manifest + deployed base skills) — run as the first-run step of `march init` — plus the `march self update` CLI-version updater. |
| `src/stack/` | Stack-lifecycle commands (`march up` / `down` / `upgrade`): the shared service list, compose-file locator, command runner, and token resolution. |
| `src/doctor/` | `march doctor` — the read-only stack-consistency battery (token wiring, session divergence, dispatch health, worktree hygiene, branch-sync lag, tmux server ownership). Talks only to the service HTTP clients + the docker socket; one module per check under `checks/`. |
| `src/spawn/` | Spawn execution pipeline: snapshots, image builds, backend entrypoints, and container launch. |
| `src/hatchery/` | Container/profile policy and the spawn orchestrator (`runHatcherySpawn`). `src/hatchery/service/` is the containerized Fastify service (`march hatchery serve`) plus the thin client `march hatchery spawn` uses. |
| `src/brood/` | Spawn lifecycle state: worktrees, branches, records, and cleanup ownership. |
| `src/sessions/` | The `march sessions` (alias `march ps`) unified in-flight view. Pure gather → join → format layers that join Brood + Castra + Herald purely over their HTTP APIs (no source/compose/filesystem reads at runtime), so it works from a plain `npm i -g march`. The divergence/join helpers are factored to be shared with `march doctor`. |
| `src/herald/` | Deterministic event bus code. Add mini-herald event/log/daemon modules here when that feature lands. |
| `src/legate/` | Legate conductor setup, template rendering, bridge checks, and related orchestration bootstrap. |
| `src/observability/` | OpenTelemetry bootstrap (traces, metrics, logs), deterministic trace/span id helpers, spawn metrics (`spawn-metrics.ts`), Hatchery service metrics (`hatchery-metrics.ts`), the pino+OTLP logger (`logger.ts`), the dispatch-trace helper, and the in-sandbox emitter. Env-gated (`MARCH_OTEL=1`), no-op when off. |
| `src/shared/` | Small cross-cutting primitives with no March-domain ownership, such as dependency checks, exit codes, and version lookup. |
| `src/templates/legate/` | Static Legate runtime template assets packaged with the CLI. Keep these separate from Legate TypeScript implementation. |
| `docker/` | The `otel-lgtm` observability stack compose file and its provisioned Grafana dashboards (`docker/grafana/`), the Hatchery service image + compose (`hatchery.Dockerfile`, `hatchery.docker-compose.yml`), plus spawn image Dockerfiles. |

Tests live next to the modules they cover. When adding a module, place it under the subsystem that should own the behavior long-term, not necessarily the milestone that first needs it.

### Subsystem contract docs

Each subsystem carries a `contract.md` describing its public surface. These docs are kept current **at edit time, not by an enforcement gate**: when a change alters a subsystem's public surface, update that subsystem's `contract.md` in the same change. The Smithy tools used for most edits already maintain affected docs as part of their change, and the mechanically-derivable regions are refreshed by a **deterministic** extractor (the planned `npm run docs:contracts:extract`, from Fastify controller endpoints and exported TypeScript signatures) — there is no AI/LLM step on check-in.

There is **no per-PR CI or AI freshness gate**. The planned `npm run docs:contracts:check` is an opt-in, advisory local check you *may* run to sanity-check a contract; it never blocks a PR, slice, or merge. This convention is Feature 6 of the contract-documentation track — see **[docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md](docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md)**.

## Testing

The strategy — scope tiers (L0 unit / L1 subsystem / L2 cross-subsystem / L3 system), the deterministic-vs-stochastic axis, the cassette pivot, the cost policy, and the framework choice per scope — lives in **[docs/testing-strategy.md](docs/testing-strategy.md)**. Read it once before adding tests in a new layer.

The milestone-level execution plan (M1 through M8, success criteria, dependency order, the gap-analysis baseline of today's tests) lives in **[docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md](docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md)**.

### Test Layer Migration

The governed legacy L2 tests are exactly:

- `src/spawn/container-launch.test.ts`
- `src/spawn/snapshot-build.test.ts`

Only those governed files are subject to the Test Layer Migration trigger; a
file outside this set does not trigger migration under this policy. Their
starting state is vitest in place: a mocked `node:child_process` boundary and no
real Docker execution. They are classified `@l2 @deterministic @ci`; the
matching leading tag blocks are applied in place by the tag-taxonomy feature
(`specs/2026-05-23-006-tag-taxonomy-and-coverage-lint`). They remain in vitest
until a material change to a governed file triggers the migration policy.

For each PR that edits one of those governed test files, classify the governed
file diff from the changed test-file hunks only:

1. If any governed-file hunk semantically changes one of the surfaces below,
   classify that governed-file edit as **material**.
2. If every governed-file hunk is limited to one of the non-material classes
   below and preserves the test contract, classify that governed-file edit as
   **non-material**.
3. If the PR changes production code, shared helpers, or other files without
   editing a governed test file itself, the migration trigger is absent.

A material edit is any semantic change to the governed test file's:

- assertions;
- mocked process behavior;
- fixtures;
- subsystem boundary it drives.

A material governed-file edit requires a Cucumber.js port of the affected
scenario in the same change PR. The trigger does not fire for production-code or
shared-helper changes that do not edit the governed test file itself.

These edits are non-material and do not require a port when they preserve the
test contract:

- formatting-only changes;
- comment-only changes;
- import sorting;
- tag-block edits;
- mechanical renames.

When an author and reviewer classify the same governed-file diff, they should
use this decision path and these listed surfaces as the written basis for the
classification. A material classification requires the same-PR Cucumber.js port;
a non-material classification, or an absent trigger, leaves the governed tests in
vitest with no preemptive port.

This policy defines only the migration trigger. It does not redefine the tag
taxonomy, staged scripts, quarantine routing, or Cucumber.js port mechanics.

Day-to-day commands:

- **`npm test`** — runs the deterministic CI suite. Today that's the full vitest set: L0, L1, and the surviving L2-shaped vitest cases listed in the Test Layer Migration policy above. Cassette-replayed L2/L3 will land here as the [RFC milestones](docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md#milestones) progress. Cost: $0, < 2 minutes. Runs on every push and PR.
- **`npm run typecheck`** — `tsc --noEmit`.

### Quarantine Routing

Use the quarantine routing primitive when a known-bad `*.test.ts` file should
stop blocking the staged gate but must remain visible for follow-up. Quarantine
membership is path-based: the canonical location is `tests/quarantine/`, and a
test is quarantined because it lives there, not because of a tag or a skipped
assertion. This is the workflow described by the Quarantine Documentation
contract in
`specs/2026-06-03-007-quarantine-routing-scaffold/quarantine-routing-scaffold.contracts.md`.

To park a test, run the non-interactive command from anywhere inside the
repository:

```bash
march quarantine park <repo-relative-path-to-test.test.ts>
```

When working from an uninstalled source checkout, build first and invoke the
same command through the local bundle:

```bash
npm run build
node dist/cli.js quarantine park <repo-relative-path-to-test.test.ts>
```

The command moves the file to `tests/quarantine/<original-path>`, preserves the
test body unchanged, and records the original path in
`tests/quarantine/.origins.json` so later restore/index work does not have to
guess. Do not create another quarantine path, add `it.skip`, comment out the
failing assertions, or delete the file.

Quarantined tests remain visible in the repository: the parked file stays in
`tests/quarantine/` and its origin is recorded in `.origins.json`. Quarantine is
a temporary visible state, not a way to silence coverage. The staged scripts
exclude `tests/quarantine/` by directory path, while non-quarantined tests with
matching tags continue to run normally. A generated roster surface,
`tests/quarantine/INDEX.md`, is planned to summarize the parked set once the
roster-generation work lands; until then the directory and `.origins.json` are
the visibility surface.

The one-week quarantine SLA, overdue alerts, and weekly-report wiring are M6
work. Until that automation lands, contributors should treat the parked file in
`tests/quarantine/` and its origin record as the review surface for follow-up.

Agent-driven and human tests:

- **Agent tests** (Claude Code session) — end-to-end dispatch lifecycle on a throwaway repo and `failed`-state rollback. Today documented as prose; aspirational target is `L3 / Deterministic / CI` (cassette-replayed) plus `L3 / Stochastic / Scheduled` (weekly live-backend). See **[tests/Agent.tests.md](tests/Agent.tests.md)** (A1–A5).
- **Human tests** (interactive terminal) — TTY-only flows like the `readline` downgrade prompt. See **[tests/Manual.tests.md](tests/Manual.tests.md)** (H1–H2).

## Observability

March emits OpenTelemetry traces, metrics, and logs (spawn success rate, runtime,
per-dispatch lineage, and Hatchery service health) to a local `grafana/otel-lgtm`
stack. Telemetry is opt-in (`MARCH_OTEL=1`) and a no-op when off. The full guide —
bringing the stack up, enabling it per deployment, the trace/span/metric/log
model, the provisioned Grafana dashboards, and validation — is in
**[docs/Observability.md](docs/Observability.md)**.

Hatchery runs as a containerized service. Bring it up after the otel stack:

```bash
docker compose -f docker/otel-lgtm.docker-compose.yml up -d   # creates the `march` network
npm run build:hatchery-image
docker compose -f docker/hatchery.docker-compose.yml up -d
export MARCH_HATCHERY_URL=http://localhost:8080               # the thin client posts here
```

The compose mounts host resources (docker socket, your `HOME` at the **identical
path** so worktree paths resolve, the tmux socket, and the agent-deck binary) —
review/override the host-specific vars at the top of
`docker/hatchery.docker-compose.yml`.

Once the images are built (see below), **`march up`** brings the whole stack up
with one command: it resolves a shared `CASTRA_API_TOKEN` (generated and
persisted to `~/.march/castra-token` on first run, reused thereafter), then
starts the services in dependency order (otel-lgtm → castra → hatchery → brood →
herald → legate). It never builds images — if a locally-built `march-*` image is
missing it aborts before starting anything and points you at `npm run
build:images` (or the per-service `npm run build:<service>-image` scripts).
Re-running is idempotent.

To turn the stack off and recover the resources it holds, run **`march down`**:
it stops the service containers in reverse dependency order (legate → herald →
brood → hatchery → castra → otel-lgtm) and works even with `CASTRA_API_TOKEN`
unset. State is preserved by default (named volumes, worktrees, branches,
in-flight sessions), so a later bring-up resumes where it left off. Pass
`--volumes` to also remove the named volumes (registries, Herald's event log,
telemetry), or `--drain` to tear down in-flight Brood sessions (spawn containers,
worktrees, branches, stewards) before stopping the services.

To roll the stack onto newer images, **`march upgrade`** recreates the service
containers in dependency order with `docker compose up -d --force-recreate
--no-build`, so the latest available `march-*` images take effect. State is
preserved — `--force-recreate` replaces the container but not its named volumes
(registries, Herald's event log, telemetry). Pass `--service <name>` (one of
`otel-lgtm`, `castra`, `hatchery`, `brood`, `herald`, `legate`) to recreate a
single service. A recreate failure marks that service failed while the rest still
upgrade.

`march upgrade` **never builds** and reads no source — it works from a plain
`npm i -g @balexda/march` and operates on whatever `march-*` images are already
present locally (the local image store, "the local registry"). **Producing**
those images is a separate concern:

- With the source tree, rebuild them with **`npm run build:images`** (the
  aggregate of the `build:<service>-image` scripts), then `march upgrade` to roll
  the containers onto them. **`npm run deploy:local`** chains both — build the CLI
  + the five service images, then recreate.
- Pulling prebuilt images from a *hosted* registry — so an npm/brew install with
  no source can fetch fresh images rather than only recreate local ones — is
  tracked in **[issue #438](https://github.com/Balexda/March/issues/438)**.

> **Note:** `march upgrade` recreates the **service container** images. The
> CLI-version updater that deploys the bundled skills lives at **`march self
> update`** (formerly `march update`, which now warns and forwards for one
> release).

To check whether the stack is healthy — the pre-flight gate before `march up`'s
consumers expect a working stack — run **`march status`**. For each service
(otel-lgtm → castra → hatchery → brood → herald → legate) it reports three
independent facts: container state (running/stopped/absent, via `docker
inspect`), HTTP reachability on the service's loopback port (castra 9264,
hatchery 8080, brood 9748, herald 8818, legate 8787, otel-lgtm/Grafana 3000), and
— for the castra `/v1/*` gate — whether the shared `CASTRA_API_TOKEN`
authenticates rather than 401-ing silently. It surfaces the common misconfig
classes (token drift, a depended-on service that is down, a locally-built image
that is absent), prints a per-service table, and **exits non-zero when the stack
is not fully healthy** so it can gate scripts/CI. The command is read-only — it
never starts, stops, or generates anything (unlike `march up`, it reads the
persisted token but never mints one). Pass `--json` for machine-readable output.
The profile-onboarding surface (`march init`) is documented under **Initializing
March and onboarding a profile** below.

**`march sessions`** (alias **`march ps`**) is the single-command answer to "what
is March running right now?". It joins Brood's session registry, Castra's live
sessions, and Herald's folded system state into one table — one row per in-flight
unit of work (spawn / steward / slice) with slice id, profile, state, PR, branch,
container id, Castra session id, Brood status, and age. It talks **only** to the
service HTTP APIs (`MARCH_BROOD_URL` / `CASTRA_URL` / `MARCH_HERALD_URL`, falling
back to the deterministic localhost ports), so it needs no source checkout.
Cross-service divergence is flagged inline: a live Castra session untracked in
Brood is a `leak`, a Brood-tracked record with no live session is an `orphan`, and
a fold slice that expects a live session but has neither is `stale` — the
ghost-session-pins-the-cap incident class made visible at a glance. Filter with
`--profile <p>`, `--state <state>`, or `--orphans` (divergent rows only), and add
`--json` for machine consumption. Each source is best-effort: a service that is
down is footnoted (`! castra (smithy) unavailable: …`) and the rest of the view
still renders, so a partial view is never silently mistaken for "all clear".

Where `march status` answers "are the services up and reachable?",
**`march doctor`** answers "is the system internally *consistent* and unwedged?"
— the read-only deep-diagnostics counterpart that encapsulates the checks an
operator otherwise steps through by hand (the `march.debug` skill). It runs a
battery and prints each finding as pass / warn / fail with the existing remedy
command named beneath it (it diagnoses, it never mutates):

- **Token wiring** — `CASTRA_API_TOKEN` is consistent across the five service
  containers and Castra actually accepts it (no silent 401/403). Remedy: re-run
  `march up`.
- **Session consistency** — Castra-live vs Brood-tracked vs Herald-fold
  divergence (leaked stewards, dead orphans, stale projections). Remedy:
  `march brood sweep` / `march legate recover`.
- **Dispatch health** — spawn-cap saturation, a dispatchable-but-starved
  backlog, and stranded/escalated stewards. Remedy: `march brood sweep` then
  `march legate recover <sliceId>`.
- **Worktree/branch hygiene** — worktrees left on disk with no live session.
  Remedy: `march brood sweep` / `march brood teardown`.
- **Sync health** — a profile's default branch behind origin (the
  `syncDefaultBranch` class, #299/#300), so merged work never surfaces. Remedy:
  `git pull` (or `MARCH_HERALD_SYNC=1`).
- **tmux server ownership** — the default tmux server (which Castra drives over
  the bind-mounted socket) runs on the host, not inside the `march-castra`
  container. If the container won the socket race (e.g. it autostarted ahead of
  `march up`), it owns the server and every session — stewards and operator
  shells — opens *inside* the container. Remedy: `march down && march up`
  (`march up` claims the host tmux server before Castra starts).

It works from a plain `npm i -g march` install — it talks only to the service
HTTP APIs (`CASTRA_URL` / `MARCH_BROOD_URL` / `MARCH_HERALD_URL`) and the docker
socket, never a source checkout. Scope it with `--profile <p>`, get machine
output with `--json`, and rely on the non-zero exit on any `fail` to gate
automation.

To read what the stack is doing, **`march logs [service]`** tails the service
container logs without you having to remember per-service container or compose
names. With no argument it interleaves all six services' recent logs, each line
tagged with its service; pass a name (`otel-lgtm`, `castra`, `hatchery`,
`brood`, `herald`, `legate`) to scope to one. `-f`/`--follow` streams new lines,
`--since <dur>` (e.g. `10m`, `1h`) and `-n`/`--tail <N>` bound the backfill, and
`--errors` keeps only error-level lines. It resolves each service to its running
container by name over the Docker socket (the service→container mapping is baked
into the CLI), so it works from a plain `npm i -g march` install with no source
checkout — it never reads the `docker/*.docker-compose.yml` files.

### Initializing March and onboarding a profile

**`march init [profile] --repo <path>`** is the single entry point for standing up
March. It does two things, in order:

1. **First-run CLI bootstrap.** When the CLI installation isn't yet set up on this
   host (no valid `~/.march/march-manifest.json`), `init` writes the manifest and
   deploys the base skills before doing anything else. It's first-run-gated, so a
   no-op on every subsequent run. This is the bootstrap that used to be a separate
   top-level `init` command — it is now folded in, so a fresh `npm i -g` only ever
   needs `march init`.
2. **Profile onboarding** (when a `<profile>` is given). It ensures the full stack
   is up (the idempotent `march up` path — a no-op when the stack is already
   healthy, aborting with a build hint if a locally-built image is missing), then
   renders and sets up the profile's Legate conductor, registers the repo with
   Herald's profile registry (the source of truth the shared `march-legate`
   service reads each tick), and ensures the legate service.

Run `march init` with **no profile** to do just the first-run bootstrap.
Re-running with a profile is idempotent. `--repo` defaults to the current git
repo. Onboarding options carry over from the commands it replaces:
`--worker-group`, `--model`, `--effort`, `--toolchain`, `--priority`,
`--conductor`, `--description`, `--heartbeat-interval`, plus `--no-setup` /
`--no-loop` / `--no-bridge-check`.

`march init <profile>` **supersedes** the previously split `march legate init`
(conductor + registration) and `march profile register` (registration only). Both
still work but print a deprecation warning pointing at `march init`, and will be
removed in a future release. The `march profile` group (`list`, `remove`,
`merge-policy`, `priority`) remains the way to manage already-registered profiles.

> **No-build installs are not there yet.** The profile-onboarding step still
> requires the `march-*` service images to exist locally (built from the source
> tree via `npm run build:images`); a bare `npm i -g` has no way to obtain them and
> `init` aborts with a build hint. Making the stack pullable from a hosted registry
> — so `npm i -g` → `march init` works with no source and no local builds — is
> tracked in **[#438](https://github.com/Balexda/March/issues/438)**.

**Keep telemetry in lock-step with the dispatch machinery.** When you add a loop
lifecycle action or a new dispatch path, emit a span for it; when you add a
failure mode, emit an *errored* span so it surfaces in traces; when a new process
joins a trace, reuse the deterministic id helpers (kept identical across
`src/observability/trace-ids.ts`, `src/legate/init.ts`, and
`src/observability/in-spawn-emitter.ts`). New metrics/labels go in
`src/observability/spawn-metrics.ts` (spawns) or
`src/observability/hatchery-metrics.ts` (the Hatchery service) — low-cardinality
only, never per-spawn/slice ids or concrete request paths; new logs go through
`src/observability/logger.ts` — and update `docker/grafana/dashboards/` to match.
See [docs/Observability.md § Keeping observability current](docs/Observability.md#keeping-observability-current).

## Automated Dependency Updates

This repo runs Dependabot on a monthly schedule (plus immediate security advisories) and pings GitHub Copilot Coding Agent to fix CI failures on Dependabot PRs. See **[docs/automated-dependency-updates.md](docs/automated-dependency-updates.md)** for the day-to-day flow and the one-time repo settings required.

## Pre-Release Checklist

Before publishing a new version:

1. All automated tests pass: `npm test`
2. Agent tests (A1–A5) verified in a Claude Code session
3. Human tests (H1–H2) verified in an interactive terminal
4. Trigger the **Publish to npm** workflow with both test gate checkboxes checked

See **[docs/testing-strategy.md § Cost policy](docs/testing-strategy.md#6-cost-policy)** for the principles, and the [RFC milestones](docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md#milestones) for the sequencing — scheduled stochastic runs and cassette refresh interact with the release flow once those milestones land.
