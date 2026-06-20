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
| `src/bootstrap/` | `march init` / `march update`, manifest handling, and deployed base skills. |
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

Governed legacy L2 tests stay in vitest until a material edit touches the
governed test file itself. A material edit is any semantic change to that file's:

- assertions;
- mocked process behavior;
- fixtures;
- subsystem boundary it drives.

A material edit requires a Cucumber.js port of the affected scenario in the same
change PR. The trigger does not fire for production-code or shared-helper changes
that do not edit the governed test file itself.

These edits are non-material and do not require a port when they preserve the
test contract:

- formatting-only changes;
- comment-only changes;
- import sorting;
- tag-block edits;
- mechanical renames.

When no material trigger is met, the governed tests stay in vitest with no
preemptive port.

This policy defines only the migration trigger. It does not redefine the tag
taxonomy, staged scripts, quarantine routing, or Cucumber.js port mechanics.

Day-to-day commands:

- **`npm test`** — runs the deterministic CI suite. Today that's the full vitest set: L0, L1, and the surviving L2-shaped vitest cases listed in the Test Layer Migration policy below. Cassette-replayed L2/L3 will land here as the [RFC milestones](docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md#milestones) progress. Cost: $0, < 2 minutes. Runs on every push and PR.
- **`npm run typecheck`** — `tsc --noEmit`.

### Test Layer Migration

The governed legacy L2 tests are exactly:

- `src/spawn/container-launch.test.ts`
- `src/spawn/snapshot-build.test.ts`

Only those governed files are subject to the Test Layer Migration trigger; a file outside this set does not trigger migration under this policy. Their starting state is vitest in place: a mocked `node:child_process` boundary and no real Docker execution. They are classified `@l2 @deterministic @ci`; the matching leading tag blocks are applied in place by the tag-taxonomy feature (`specs/2026-05-23-006-tag-taxonomy-and-coverage-lint`) and are not yet present in the files. They remain in vitest until a material change to a governed file triggers the migration policy.

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
missing it aborts before starting anything and points you at `march upgrade`
(until that lands, use the `npm run build:<service>-image` scripts). Re-running
is idempotent.

To turn the stack off and recover the resources it holds, run **`march down`**:
it stops the service containers in reverse dependency order (legate → herald →
brood → hatchery → castra → otel-lgtm) and works even with `CASTRA_API_TOKEN`
unset. State is preserved by default (named volumes, worktrees, branches,
in-flight sessions), so a later bring-up resumes where it left off. Pass
`--volumes` to also remove the named volumes (registries, Herald's event log,
telemetry), or `--drain` to tear down in-flight Brood sessions (spawn containers,
worktrees, branches, stewards) before stopping the services.

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
The remaining stack-lifecycle surface (`march upgrade` / `march init`) is tracked
as follow-ups.

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
