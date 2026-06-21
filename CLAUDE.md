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
- **Subsystem contract docs are kept current at edit time, not by a gate.** When a
  change alters a subsystem's public surface, update that subsystem's `contract.md`
  in the same change. The Smithy tools used for most edits already maintain affected
  docs; the mechanically-derivable regions are refreshed by a **deterministic**
  extractor (planned `npm run docs:contracts:extract`, from Fastify endpoints /
  exported TS signatures). There is **no per-PR CI or AI freshness gate** — the
  planned `npm run docs:contracts:check` is an opt-in, advisory local check. This is
  Feature 6's maintenance convention in the contract-documentation track
  ([`docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md`](docs/rfcs/2026-002-layered-testing-framework/02-subsystem-contract-documentation-track.features.md)).
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
  not-yet-implemented extension point for SaaS — issue #167/#166). Brood also runs
  a periodic **reconciler** (`src/brood/service/reconciler.ts`): an always-on
  read-only loop publishing the Castra-live-vs-Brood-tracked divergence to the
  `march_brood_sessions_*` gauges, plus an env-gated **self-heal** loop (two
  independent flags, OFF by default — `MARCH_BROOD_AUTO_REAP` reaps dead orphans
  via `sweepLeakedStewards`, `MARCH_BROOD_AUTO_ADOPT` adopts untracked open-PR
  stewards into Brood so the legate merges them; reuses the same OPEN-PR-protected
  PR gate as `march brood sweep`, emits `march_brood_reaps`). Image/compose:
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
- **Legate is a profile-agnostic containerized service:** `march legate serve`
  (Fastify HTTP + the deterministic two-stage tick) under `src/legate/loop/` runs
  as a **single shared `march-legate` container** (`docker/legate.Dockerfile`,
  `docker/legate.docker-compose.yml`) that drives **every registered profile** —
  not one container per profile. Each tick it lists profiles from **Herald's
  profile registry** (the source of truth: `src/herald/profiles/` —
  store/routes/client, its own `~/.march/herald/profiles.db`, designed to be
  lifted into a standalone profile service later), drains the **single
  multiplexed Herald event stream once** (one cursor, `event.profile` on the
  envelope routes each event to that profile's fold via `reduceMulti`), then runs
  the coordinator per profile against isolated working state — each profile in its
  own try/catch so one bad repo can't stall the others. `march init [profile]
  --repo <path>` is the single entry point for standing up March: on first run it
  bootstraps the CLI installation itself (manifest + base skills — folded in, no
  separate command), and with a `<profile>` it then onboards that profile —
  ensures the full stack is up (the idempotent `march up` path), **registers** the
  profile with Herald (`POST /profiles`), and ensures the shared service is up
  (run with no profile to do just the first-run bootstrap). It supersedes the
  now-deprecated `march legate init` (conductor + registration) and `march profile
  register` (registration only) — both still work for one release but warn and
  forward. `march profile list|remove|merge-policy|priority` manage
  already-registered profiles directly. (Onboarding still needs the `march-*`
  images built locally; making the stack pullable from a registry so a bare `npm
  i -g` → `march init` works with no source/builds is tracked in issue #438.)
  Herald's observer iterates the same registry. The old per-profile
  hatchery-launched container + `legate-loop-meta.json` are retired (the meta
  survives only as a legacy registry seed via `MARCH_HERALD_META`). Set
  `MARCH_HERALD_URL`/`MARCH_BROOD_URL`/`MARCH_HATCHERY_URL`/`CASTRA_URL` so the
  container reaches the services.

## Verification

```bash
npm run typecheck
npm run build
npm test
```

Use `npm run` scripts — do not invoke `npx vitest`, `npx tsup`, or ad hoc
equivalents.
