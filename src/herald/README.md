# Herald — system-state observation as an event-sourced service

Herald is March's **observation** service: the heartbeat + data-collection layer
calved off the legate loop. It is the *afferent* (sensory) half of the system —
it watches what's happening and records it — paired with the legate as the
*efferent* (motor) half that reacts. Like Hatchery / Brood / Castra it is a small
Fastify service (`march herald serve`) with a `node:sqlite` store, a thin HTTP
client, deterministic config, per-service metrics + logger, and a Docker image.

```
            ┌─────────── Herald (afferent) ───────────┐
            │  observe tick (heartbeat):                │
            │   1. read the current projection          │
            │   2. observe the world (gh/git/smithy/    │
            │      Castra) via the shared sense I/O      │
            │   3. diff observed vs projection           │
            │   4. append ONE event per delta  ─────────┼──┐
            └───────────────────────────────────────────┘  │
                                                            ▼
                                       ┌──── unified event log ────┐
                                       │ append-only, seq-ordered    │
                                       │ (node:sqlite, Herald owns)  │
                                       └──────┬───────────────▲──────┘
                                              │ GET /events    │ POST /events
                                              │ ?after=cursor  │ (transitions)
            ┌─────────── Legate (efferent) ───▼───────────────┴──────┐
            │  drain the inbox one event at a time → fold → react →    │
            │  append transition events (PR2 cutover, on MARCH_HERALD_URL) │
            └──────────────────────────────────────────────────────────┘
```

## Why event sourcing

The system state is **event-sourced**: an append-only, monotonically-sequenced
log is the source of truth, and everything else is derived from it.

- **Current state** = the fold of the whole log (`GET /state`).
- **State at a point** = the fold up to a `seq` (`GET /state?at=<seq>`).
- **A delta between two points** = the events between two `seq`s
  (`GET /state/delta?from=&to=`).
- **The inbox** = a consumer keeps a cursor (last-processed `seq`) and drains
  events strictly after it (`GET /events?after=<cursor>`), one at a time — so
  concurrency is handled for free by the single ordered stream.

Herald is the **single sequencer**: it assigns every `seq`, whether the event
came from its own observation or from a legate `POST /events`. That gives one
unambiguous total order across both writers.

## Two kinds of events

The taxonomy and the reducer live in [`events.ts`](./events.ts) — the canonical
contract **both** services import (Herald to serve `/state`, the legate to
rebuild its working state). `EventType` is deliberately low-cardinality (it is a
metrics label).

- **Observation events** (Herald-written, live today): `slice.pr.changed`,
  `slice.output.changed`, `session.changed`, `workers.changed`,
  `smithy.queue.changed`, `state.error` / `state.ok`, `heartbeat`.
- **Transition events** (legate-written, emitted at the cutover): `slice.dispatched`,
  `slice.stage.changed`, `slice.archived`, `slice.recovery.dispatched`,
  `steward.relaunched`, `slice.escalated`, `retry.counted`.

`reduce(state, event)` folds either kind into a `SystemState` (per-slice stage +
PR/output, worker counts, smithy queue, sessions, retry counters). The fold is
what ultimately replaces the legate's `state.json`.

## The closed observe→react loop

The two services form a self-consistent feedback loop:

1. The legate appends `slice.dispatched` (branch X, session Y).
2. Herald's projection now knows slice → branch X / session Y.
3. Herald's next observe tick reads the PR for branch X and the status of session
   Y, and appends `slice.pr.changed` / `session.changed`.
4. The legate drains those, runs its state machine, and appends
   `slice.stage.changed` / `slice.archived` — back to step 2.

Herald emits **facts** ("PR #123 is MERGED"); the legate decides **what to do**
about them.

## Source layout

```
src/herald/
  config.ts            HERALD_SERVICE_NAME, deterministic port (8818), resolveHeraldPort
  events.ts            shared event taxonomy (discriminated union) + reduce/fold + SystemState
  service/
    sqlite.ts          node:sqlite loader (Node >= 22.5; no-throw at import)
    store.ts           EventStore: append-only log + hot projection + snapshots
    server.ts          buildServer (testable) / startServer (bind + observe loop + shutdown)
    routes.ts          /healthz /readyz /events (GET inbox / POST write) /state /state/delta /status
    client.ts          HeraldClient + Unavailable/NotFound errors; resolveHeraldUrl / heraldConfigured
    types.ts           store + HTTP query/response types
  observe/
    observer.ts        runObservation: read projection → senseState → diff → append
    diff.ts            pure diffObserved(prev, loop) → event bodies (emits only deltas)
```

The world-observing I/O itself is **shared**, not duplicated: it lives in
[`../observe/sense-io.ts`](../observe/sense-io.ts) (`buildSenseIo`) — the same
`gh`/`git`/`smithy`/Castra reads the legate loop uses for its Stage-1 sense — so
there is one tested implementation of the subtle bits (review-thread GraphQL,
branch-variant PR matching, the `--pending` smithy query).

## Store internals ([`service/store.ts`](./service/store.ts))

- `events` table: `seq` (AUTOINCREMENT pk = the cursor), `id` (uuid, UNIQUE),
  `type`, `entity_kind`/`entity_id` (indexed), `source`, `ts`, `payload` (JSON).
- **Idempotent append** via `INSERT OR IGNORE` on `id` — a duplicate returns the
  existing row and does not re-fold.
- A **hot projection** is kept in memory and advanced on each append (so the
  observe diff is cheap), plus periodic **snapshots** so a cold start
  fast-forwards instead of replaying the whole log.
- `~/.march/herald/events.db` on disk; `:memory:` in tests.

## HTTP API ([`service/routes.ts`](./service/routes.ts))

| Method + path                 | Purpose |
|-------------------------------|---------|
| `GET /healthz`                | liveness |
| `GET /readyz`                 | `git`/`gh`/`smithy` on PATH (+ Castra reachability, best-effort) |
| `GET /events?after=&limit=`   | **the inbox** — events strictly after a cursor |
| `POST /events`                | append a transition event (legate write-path; `source` forced to `legate`) |
| `GET /state?at=`              | current projection, or as-of a `seq` |
| `GET /state/delta?from=&to=`  | the events that moved state between two points |
| `GET /status`                 | observe summary (last tick, event count, queue, workers, …) |

Operators get the same views from the CLI: `march herald events` / `march herald
state`.

## Configuration

- **Port** — deterministic **8818** (`heraldPort()`), overridable via
  `MARCH_HERALD_PORT`.
- **Discovery** — consumers set `MARCH_HERALD_URL`; `heraldConfigured(env)` gates
  the legate's inbox consumption so a deployment without Herald is unaffected.
- **Meta** — Herald observes the same deployment as the legate, so it reads the
  legate's meta (`MARCH_HERALD_META`, falling back to `MARCH_LEGATE_LOOP_META`).
- **Read-only by default** — `MARCH_HERALD_SYNC=1` lets Herald own the
  default-branch `git` sync; left **off** so it never fights a still-polling
  legate. Herald never touches Docker.
- **Telemetry** — `MARCH_OTEL=1` enables `march.herald.*` metrics
  ([`../observability/herald-metrics.ts`](../observability/herald-metrics.ts))
  and JSONL/OTLP logs; a no-op when off. Dashboard:
  `docker/grafana/dashboards/march-herald.json`.

Image / compose: `docker/herald.Dockerfile`, `docker/herald.docker-compose.yml`.

## Rollout

Herald is being landed incrementally so the running legate is never at risk:

1. **PR0** — extract the shared sense I/O into `src/observe/sense-io.ts` (pure
   refactor, no behavior change).
2. **PR1 (this service)** — Herald produces observation events; the legate keeps
   polling. Herald is independently deployable and observable.
3. **PR2 (this change)** — the legate drains the inbox + writes transition events
   (cutover), gated on `MARCH_HERALD_URL`. When set, Stage-1 sense is sourced from
   the folded inbox (`senseFromHerald`) instead of self-polling, and handlers
   dual-write transition events alongside `state.json`. Unset = byte-for-byte the
   legacy path. The persistent inbox cursor lives in the legate conductor dir
   (`herald-cursor.json`); the legate seam is `src/legate/loop/clients/herald.ts`.
4. **PR3** — retire `state.json`; the fold becomes the sole source of truth.

The two-stage loop was built for this split: `src/legate/loop/state/types.ts`
documents the Herald cutover and `src/legate/loop/coordinator.ts` already injects
`sense` as a swappable dependency.
