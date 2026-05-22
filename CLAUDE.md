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
  off); then the dashboards under `docker/grafana/`. **Each slice is one trace**
  keyed by its id (`traceIdForDispatch`): `legate.dispatch` (root) →
  `hatchery.spawn`/`spawn.*`/`steward.send` → Herald's `herald.pr.*` /
  `herald.output.changed`. Service-side spans that observe or act on a slice nest
  on the deterministic id as **children** (never claiming root) — Herald via
  `src/observability/herald-trace.ts`, brood via `brood-trace.ts`, Castra via the
  `x-march-slice-id` header. Debugging a stuck task = reading that one trace for
  the absent/errored/wrong-attribute leg; if it can't answer "where did it stall",
  that gap is itself the fix (see the debug + maintenance sections of the guide).
- **Hatchery is a containerized service:** `march hatchery serve` (Fastify) under
  `src/hatchery/service/` runs the spawn flow; `march hatchery spawn` is a thin
  HTTP client. Image/compose: `docker/hatchery.Dockerfile`,
  `docker/hatchery.docker-compose.yml`.
- **Brood is a containerized service:** `march brood serve` (Fastify) under
  `src/brood/service/` is the session-state + lifecycle/teardown authority — it
  tracks every spawn/steward/legate in a sqlite registry (`~/.march/brood`) and
  **owns teardown**: it removes the container, asks castra (or agent-deck) to
  remove the steward, then removes the worktree/branch by **exact tracked path —
  never a blanket `git worktree prune`** (issue #155). The container +
  worktree/branch call-outs are isolated behind a **`TeardownSubstrate` adapter**
  (`src/brood/service/substrate.ts`, issue #169) so the substrate can be swapped
  (host docker socket → orchestrator API; host worktree → ephemeral volume); the
  default `hostTeardownSubstrate` keeps the exact-path / never-prune guarantee,
  and steward removal still routes through the Castra client. The Hatchery
  service registers spawns with it; the legate loop **requests** teardown via
  `march brood teardown` instead of pruning. The registry sits behind a
  swappable `SessionRepository` interface (`src/brood/service/repository.ts`):
  callers (routes/teardown/server) depend on the interface, the sqlite
  `SessionStore` is the default, and `createSessionRepository` selects the
  backend from `MARCH_BROOD_STORE` (`sqlite` default; `postgres` is a typed,
  not-yet-implemented extension point for SaaS — issue #167/#166). Image/compose:
  `docker/brood.Dockerfile`, `docker/brood.docker-compose.yml`. Set
  `MARCH_BROOD_URL` so producers/consumers reach it.
- **Herald is a containerized service:** `march herald serve` (Fastify) under
  `src/herald/service/` is the system-state **observation** service — the
  heartbeat + data collection calved off the legate loop. Each tick it observes
  the world (the shared sense I/O in `src/observe/sense-io.ts`: `gh`/`git`/
  `smithy` + Castra) and records **change events** into an append-only,
  seq-ordered **event log** (`node:sqlite` at `~/.march/herald`). The system
  state is **event-sourced**: current state is the fold of the log (the shared
  taxonomy + reducer live in `src/herald/events.ts`, imported by both services).
  Herald appends *observation* events; the legate appends *transition* events and
  drains the inbox via `GET /events?after=<cursor>`. Since #176 the fold is the
  **sole** source of system state — there is no `state.json`: the legate's working
  state is in-memory, recorded only as transition events, and rebuilt from the
  fold on cold start, and Herald's observer learns slice→branch/session from its
  own projection (`senseObserved`). Herald is the single sequencer (it owns every
  `seq`, including legate `POST /events`). `MARCH_HERALD_SYNC=1` lets Herald own
  the default-branch git sync (the legate no longer syncs, so enable it in
  production); Herald never touches Docker. New event type → add it to the `events.ts` discriminated union
  + reducer (keep `EventType` low-cardinality — it is a metric label) and the
  `POST /events` validator; new metric → `src/observability/herald-metrics.ts`,
  then `docker/grafana/dashboards/march-herald.json`. Image/compose:
  `docker/herald.Dockerfile`, `docker/herald.docker-compose.yml`. Set
  `MARCH_HERALD_URL` so the legate reaches it.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

Use `npm run` scripts — do not invoke `npx vitest`, `npx tsup`, or ad hoc
equivalents.
