# Agent Guide

This repo is the March CLI. Keep changes aligned with the product subsystem boundaries; do not put new runtime code directly under `src/` unless it is the executable entrypoint.

## Read these before designing anything new

Two long-lived repo docs anchor *why* March is shaped the way it is. Read them before proposing a new component, a new spec, or a non-trivial behavior change. They are short and load-bearing.

- [`docs/vision.md`](docs/vision.md) — March's thesis: **Smithy decomposes ideas into high-quality plans; March executes those plans with minimum operator intervention.** The "ideas in, quality out" framing.
- [`docs/operating-philosophy.md`](docs/operating-philosophy.md) — the per-component intervention-avoidance table (which component eliminates which intervention) and three rules of thumb every spec is held to:
  1. **No interactive surfaces inside an autonomous component** — no permission prompts, no "are you sure?", no blocking on input the spawn can't receive. Escalations are events, not blocks.
  2. **Minimum required access, not zero access** — sandboxes start tight and peel back through typed interfaces (e.g., `SpawnBackend.credentialMounts`), never through operator-authored exceptions.
  3. **Failures are clean exits, not hangs** — timeouts kill containers; pre-flights fail fast; terminal-state events fire so consumers don't wait forever.

When you write a spec or a piece of code that makes the operator/automation trade-off (and most non-trivial March changes do), cite these docs rather than restating the philosophy. If a change would violate one of the rules of thumb, surface the trade-off explicitly — either resolve it in the spec and revise the philosophy doc with the new rule, or push back on the change.

## Source Ownership

- `src/cli.ts`: bin wrapper only. It should import `runCli` and do no command work itself.
- `src/cli/`: Commander setup and command dispatch. Keep command handlers thin; move subsystem behavior into the owning domain directory.
- `src/bootstrap/`: install/update/manifest/skill deployment for `march init` and `march update`.
- `src/spawn/`: one-shot spawn execution: snapshot, Dockerfile/image build, backend entrypoint, container launch, prompt handoff, output extraction.
- `src/hatchery/`: container/profile policy and the spawn orchestrator (`runHatcherySpawn`). `src/hatchery/service/` is the containerized Fastify service (`march hatchery serve`): routes, in-memory job store, the worker that runs `runHatcherySpawn`, and the thin HTTP client `march hatchery spawn` uses. Image/compose live in `docker/hatchery.Dockerfile` and `docker/hatchery.docker-compose.yml`.
- `src/brood/`: lifecycle state and cleanup: spawn records, worktrees, branches, running/stopped session tracking.
- `src/herald/`: deterministic event bus and mini-herald modules. PR event schema, snapshots, event log, cursor handling, and daemon code belong here.
- `src/legate/`: Legate conductor setup and orchestration bootstrap. Static deployed assets stay in `src/templates/legate/`.
- `src/observability/`: OpenTelemetry bootstrap (traces, metrics, **logs**), deterministic trace/span id helpers, spawn metrics (`spawn-metrics.ts`), Hatchery service metrics (`hatchery-metrics.ts`), the pino+OTLP logger (`logger.ts`), the dispatch-trace helper, and the in-sandbox emitter. Telemetry is env-gated (`MARCH_OTEL=1`) and a no-op when off (the log file is still written). Grafana/stack assets live under `docker/` (`otel-lgtm.docker-compose.yml`, `grafana/`).
- `src/shared/`: small infrastructure utilities with no durable domain owner.

When a feature spans multiple subsystems, split code by ownership. For example, a future dispatch option may add CLI parsing in `src/cli/`, profile resolution in `src/hatchery/`, lifecycle updates in `src/brood/`, and execution changes in `src/spawn/`.

## Working Rules

- Prefer behavior-preserving moves before behavior changes. Move tests with their modules.
- Keep `src/templates/legate/` packaged as static assets; do not merge template files into `src/legate/`.
- Preserve the public CLI contract unless the task explicitly changes it.
- Keep generated `dist/` out of commits unless the release process asks for it.
- Use `npm run` scripts for verification. Do not invoke `npx vitest`, `npx tsup`, or ad hoc equivalents.
- Be aware that git-heavy tests may need permissions outside the default sandbox because they create temporary repositories and linked worktrees.
- **Keep observability in lock-step with the dispatch machinery.** When you add a loop lifecycle action or a new dispatch path, emit a span for it (`maybeEmitLoopSpan` in `src/legate/init.ts`); when you add a failure mode, emit an *errored* span so it surfaces in traces; when a new process joins a trace, reuse the deterministic id helpers (kept byte-for-byte identical across `src/observability/trace-ids.ts`, `src/legate/init.ts`, and `src/observability/in-spawn-emitter.ts`). New metrics/labels go in `src/observability/spawn-metrics.ts` (spawns) or `src/observability/hatchery-metrics.ts` (the Hatchery service) — low-cardinality only, never per-spawn/slice ids or concrete request paths; new logs go through the pino logger in `src/observability/logger.ts`; then update `docker/grafana/dashboards/` to match. The full guide is [`docs/Observability.md`](docs/Observability.md).

## Verification

Run these after structural or runtime changes:

```bash
npm run typecheck
npm run build
npm test
```

For CLI-entrypoint changes, also spot-check:

```bash
node dist/cli.js version
node dist/cli.js help
node dist/cli.js spawn
node dist/cli.js legate init --help
```
