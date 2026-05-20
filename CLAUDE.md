# CLAUDE.md

Claude Code reads this file as repo guidance. **[`AGENTS.md`](AGENTS.md) is the
canonical agent guide** — source ownership, working rules, and verification all
live there; keep edits in one place to avoid drift.

Quick pointers:

- **Why March is shaped this way:** [`docs/vision.md`](docs/vision.md) and
  [`docs/operating-philosophy.md`](docs/operating-philosophy.md). Read before
  proposing new components or non-trivial behavior changes.
- **Contributor setup, testing strategy, release checklist:**
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Observability (OpenTelemetry → `otel-lgtm`):**
  [`docs/Observability.md`](docs/Observability.md). Telemetry (traces, metrics,
  logs) is opt-in (`MARCH_OTEL=1`) and a no-op when off. **Keep it in lock-step
  with the dispatch machinery** — new dispatch path or lifecycle action → emit a
  span; new failure mode → emit an *errored* span; a new process joining a trace
  → reuse the deterministic id helpers kept identical across
  `src/observability/trace-ids.ts`, `src/legate/init.ts`, and
  `src/observability/in-spawn-emitter.ts`; new metrics/labels (low-cardinality
  only) → `src/observability/spawn-metrics.ts` (spawns) or
  `src/observability/hatchery-metrics.ts` (the Hatchery service); new logs → the
  pino logger in `src/observability/logger.ts` (file sink + OTLP, no-op when
  off); then the dashboards under `docker/grafana/`.
- **Hatchery is a containerized service:** `march hatchery serve` (Fastify) under
  `src/hatchery/service/` runs the spawn flow; `march hatchery spawn` is a thin
  HTTP client. Image/compose: `docker/hatchery.Dockerfile`,
  `docker/hatchery.docker-compose.yml`.
- **Brood is a containerized service:** `march brood serve` (Fastify) under
  `src/brood/service/` is the session-state + lifecycle/teardown authority — it
  tracks every spawn/steward/legate in a sqlite registry (`~/.march/brood`) and
  **owns teardown**: it removes the container, asks castra (or agent-deck) to
  remove the steward, then removes the worktree/branch by **exact tracked path —
  never a blanket `git worktree prune`** (issue #155). The Hatchery service
  registers spawns with it; the legate loop **requests** teardown via
  `march brood teardown` instead of pruning. Image/compose:
  `docker/brood.Dockerfile`, `docker/brood.docker-compose.yml`. Set
  `MARCH_BROOD_URL` so producers/consumers reach it.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

Use `npm run` scripts — do not invoke `npx vitest`, `npx tsup`, or ad hoc
equivalents.
