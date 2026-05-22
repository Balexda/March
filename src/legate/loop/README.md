# Legate loop — the efferent control loop

The legate loop is March's **reaction** half: the *efferent* (motor) side that
decides what to do and makes it happen, paired with [Herald](../../herald/) as
the *afferent* (sensory) side that watches and records. Each tick it takes a
snapshot of the world, runs an ordered set of handlers that move the slice state
machine, and drives the interactive sessions doing the work. Like Hatchery /
Brood / Castra / Herald it runs as a small containerized service (`march legate
loop`, a Fastify app) with deterministic config, per-service metrics + logger,
and a Docker image.

```
            ┌─────────────── Legate loop tick (every ~60s) ───────────────┐
            │  Stage 1 — sense (gather ONE LoopState snapshot):            │
            │    drain Herald inbox → fold → LoopState (working state +    │
            │    observed sessions/PRs); smithy ready read locally         │
            │                          │                                   │
            │  Stage 2 — coordinator (ordered; mutates the same snapshot): │
            │    cleanup → ghost-cleanup → relaunch → babysit → dispatch   │
            │       each = pure assess(state) + effecting apply(ctx,state) │
            │                          │                                   │
            │  heartbeat — write the record + events, snapshot for /status │
            └──────────────────────────────────────────────────────────────┘
                  │ spawns           │ teardown         │ sessions   │ events
                  ▼                  ▼                  ▼            ▼
               Hatchery            Brood             Castra        Herald
            (codex spawns)   (teardown authority) (interactive)  (event log)
```

## The two-stage tick

The loop is deliberately split into two stages so the I/O and the logic can be
tested and evolved independently. The split is what made the Herald cutover a
drop-in (see [`state/types.ts`](./state/types.ts)).

- **Stage 1 — sense** ([`state/sense.ts`](./state/sense.ts)) drains the Herald
  inbox into a single, mostly-immutable [`LoopState`](./state/types.ts) snapshot:
  the in-memory working state (`raw`, rebuilt from the fold on cold start), the
  worker sessions, smithy readiness, and the per-slice PR / output (`perSlice`)
  for active slices. The I/O is injected via `SenseDeps`, so the gathering is
  fully unit-testable.
- **Stage 2 — coordinator** ([`coordinator.ts`](./coordinator.ts)) runs the
  handlers in a fixed order, threading the *same* mutating `LoopState` through
  all of them. Each handler is a pure `assess(state) -> Decision[]` plus an
  effecting `apply(decisions, ctx, state)` that performs side effects and
  **mutates the snapshot in place** — so a later handler's `assess` sees the
  current world without re-polling.

### The handler pipeline (order is load-bearing)

`cleanup → ghost-cleanup → relaunch → babysit → dispatch`, awaited in order.
Do **not** parallelize — earlier handlers drop sessions/slices that later ones
must not act on.

| Handler | What it does |
|---------|--------------|
| [`cleanup`](./handlers/cleanup.ts) | A slice whose PR is `MERGED`/`CLOSED` is done → request Brood teardown, then archive the slice. On a Brood 404 ([#225](https://github.com/Balexda/March/issues/225)): if the steward is still live in Castra, reconcile it into Brood from the observation (exact worktree/branch path, [#155](https://github.com/Balexda/March/issues/155)) and re-tear-down; if it's genuinely gone, archive idempotently. A real teardown failure defers (never archives over an orphan) and escalates to the operator after `MAX_CLEANUP_ATTEMPTS` instead of retrying forever. |
| [`ghost-cleanup`](./handlers/ghost-cleanup.ts) | A worker session whose worktree isn't tracked by any non-terminal slice (and old enough to not be a launch race) is an orphan → request Brood teardown. |
| [`relaunch`](./handlers/relaunch.ts) | A non-terminal slice with an open PR but a vanished worker → re-attach a fresh opus steward to the existing worktree/branch. Throttled per slice. |
| [`babysit`](./handlers/babysit.ts) | The steward watchdog: login-block recovery, worker-error escalation, stranded-steward nudges, PR discovery, conflict / review-thread / CI handling, post-dispatch re-nudges. |
| [`dispatch`](./handlers/dispatch.ts) | Smithy's layer-0 ready items → Hatchery codex spawns; drains completed spawns; partial-merge / branch-collision recovery. |

The heartbeat ([`heartbeat.ts`](./heartbeat.ts)) folds the tick's results into a
record on disk and a snapshot for `GET /status`.

## Stage 1: the Herald inbox (no state.json, #176)

`sense` is [`senseFromHerald`](./state/sense.ts), bound by the runtime per tick:
it drains Herald's event inbox and folds it into the `LoopState` (sessions /
workers / per-slice PR+output all come from the fold), and the handlers append
**transition events** back to Herald via [`clients/herald.ts`](./clients/herald.ts).

The legate's **working state** (`raw`: slices, archived_slices, retry counters)
is held **in memory** across ticks — the Stage-2 handlers mutate it directly — and
is recorded only as transition events. There is no `state.json`: on a cold start
`senseFromHerald` rebuilds the working state from the fold (`rebuildWorkingState`,
seeded by `GET /state?at=<cursor>` + trailing `/events`). The smithy *ready
records* are still read locally (not event-sourced), without syncing — Herald owns
the default-branch sync (`MARCH_HERALD_SYNC=1`). See the
[Herald README](../../herald/README.md) for the event taxonomy.

## Source layout

```
src/legate/loop/
  index.ts          runLoop entry: env reconciliation (otel/brood/herald),
                    meta/port resolution, telemetry + HTTP + runtime bring-up
  meta.ts           LoopMeta shape + loadMeta + resolveIntervalSeconds
  runtime.ts        the lifted legate-loop.mjs: tick wiring, dispatch/recovery
                    I/O, OTel dispatch spans, the interval scheduler (@ts-nocheck;
                    decomposition tracked in Balexda/March#144)
  coordinator.ts    Stage 2 — sense → ordered handlers → TickResult
  heartbeat.ts      per-tick heartbeat record + events + /status snapshot
  http.ts           Fastify server: GET /healthz, GET /status (read-only today)
  state/
    types.ts        LoopState / HandlerContext / HandlerResult / TickResult
    sense.ts        Stage 1: senseFromHerald (legate inbox fold) +
                    senseObserved (Herald observe) + rebuildWorkingState
    mutations.ts    archiveSlice / dropSlice / dropSession (shared apply mutations)
  handlers/         the ordered Stage-2 handlers (assess + apply), one file each
  clients/
    brood.ts        teardown authority seam (async BroodClient; MARCH_BROOD_URL)
    herald.ts       Herald inbox consumer (persistent cursor + fold) + transition
                    event writer (#175; MARCH_HERALD_URL)
    exec.ts         async execText (execFile) wrapper for git/gh
  pure/
    dispatch-id.ts  deterministic slice id / branch derivation from smithy records
    session.ts      agent-deck session helpers (worker classification, matching)
    slice.ts        slice predicates (terminal, archive collision, in-flight)
    smithy-graph.ts layer-0 ready-item selection from `smithy status`
    messages.ts     worker prompt / nudge builders
    format.ts hash.ts  formatting + hashing helpers
```

## The seams (where the loop reaches other services)

The loop owns *decisions*; the doing is delegated to the other March services,
each behind an injectable seam so the handlers stay unit-testable:

- **Hatchery** — codex spawns for fresh dispatches. The loop POSTs to the
  Hatchery service with the async client (`postSpawn`), records the returned job
  id on the slice, and polls it across ticks (`getJob`) until terminal
  (`runtime.ts`).
- **Brood** — the session-state + **teardown authority** ([#155](https://github.com/Balexda/March/issues/155)).
  The loop *requests* teardown ([`clients/brood.ts`](./clients/brood.ts)); it
  never prunes worktrees itself.
- **Castra** — the interactive-sessions host. Every steward message / launch /
  removal goes through the async `CastraClient`.
- **Herald** — the observation service + unified event log. Source of Stage-1
  sense and sink for transition events when `MARCH_HERALD_URL` is set.

## Recovery machinery

Part of [`runtime.ts`](./runtime.ts) is auto-recovery for the messy realities of
the spawn path, each gated behind a per-slice retry counter so a transient
problem self-heals and only a *persistent* one escalates for operator judgement.
Since #144 the loop only recovers things it can fix **through a service or its own
in-memory state** — it no longer does git/gh worktree+branch surgery of its own:

- ghost-session reclamation (removes the colliding session via Castra),
- wrong-worktree launch-race release and codex patch-error retry (in-memory
  retry-counter releases that re-dispatch the slice),
- stale-job recovery (a Hatchery job that never reaches a terminal state),
- a no-spawn **direct-steward** fallback after repeated codex-spawn failures.

Branch/worktree collisions (`branch already exists`, diverged leftovers) are **no
longer auto-recovered with git surgery** — worktree+branch teardown by exact path
is Brood's authority ([#155](https://github.com/Balexda/March/issues/155)).

**Bounded auto-recovery of recoverable escalations
([#211](https://github.com/Balexda/March/issues/211)).** A spawn that fails at the
dispatch stage escalates with `escalatedReason: hatchery_dispatch_failed` — the
whole family (a bad worker patch, an orphan-branch collision now cleaned up at the
failure site by [#216](https://github.com/Balexda/March/pull/216), a Hatchery
job-lookup 404 after a restart). Rather than stranding the still-ready smithy item
operator-only forever, the dispatch handler re-dispatches it through the **same**
fresh-launch path (`recoverDispatch` → `launchDispatch`), gated two ways:

- an **allowlist** of recoverable reasons (`RECOVERABLE_ESCALATION_REASONS`) — any
  *other* escalation reason stays operator-only, fail-safe;
- a **per-slice budget** (`DISPATCH_RECOVERY_LIMIT`, the durable
  `transient_retry_counts` keyed `dispatch-recovery:<sliceId>`). After the limit
  the slice falls back to the operator-only escalation, so a genuinely-terminal
  failure can't loop.

The recoverable class is selected by the pure `recoverableEscalations`
(`pure/slice.ts`), disjoint from `dispatchableReady` (an escalated slice reads as
in-flight there). `#216` guarantees the re-dispatch is collision-free; teardown
still routes through Brood (#155), never a worktree prune here.

These transitions emit `slice.dispatched` / `slice.recovery.dispatched` /
`slice.escalated` / `retry.counted` events — the durable record the working state
is rebuilt from (#176) — and a `recovery_dispatch` action-log event that re-lights
the (previously replay-only) recovery dispatch span.

## HTTP API ([`http.ts`](./http.ts))

| Method + path  | Purpose |
|----------------|---------|
| `GET /healthz` | liveness |
| `GET /status`  | latest heartbeat snapshot (last tick, queue, workers, counts) |

Read-only today; deterministic action routes (`POST /tick`, …) register the same
way when added.

## Configuration

- **Meta** — `legate-loop-meta.json`, frozen at `march legate init`
  (`loopMetaFor` in [`../init.ts`](../init.ts)) and read by
  [`meta.ts`](./meta.ts). Resolve order: `--meta` flag → `MARCH_LEGATE_LOOP_META`
  → `<cwd>/legate-loop-meta.json`.
- **Interval** — `MARCH_LEGATE_LOOP_INTERVAL_SECONDS` (or
  `MARCH_PROCESSOR_INTERVAL_SECONDS`), default 60s.
- **Port / host** — `MARCH_LEGATE_LOOP_PORT` (default 8787); binds `0.0.0.0` in
  the managed container (`MARCH_LEGATE_CONTAINER=1`), else loopback.
- **Service discovery** — `MARCH_BROOD_URL` and `MARCH_HERALD_URL` reach Brood
  and Herald. Both are also *frozen into meta* at init (`brood_endpoint` /
  `herald_endpoint`) and reconciled into the env at startup (`reconcileBroodEnv`
  / `reconcileHeraldEnv` in [`index.ts`](./index.ts)) so the containerized loop
  finds them without env propagation.
- **Telemetry** — `MARCH_OTEL=1` enables `march.legate.*` metrics + logs and the
  raw-OTLP dispatch spans (a no-op when off). Identity defaults to
  `service_name="march-legate"` for the dashboard. Dispatch spans reuse the
  deterministic id helpers in [`../../observability/trace-ids.ts`](../../observability/trace-ids.ts)
  so they share a trace with the orchestrator's `hatchery.spawn` / `spawn.*`
  spans.

## Why two stages (and where this is going)

`src/legate/loop/state/types.ts` documents the contract; `coordinator.ts` injects
`sense` as a swappable dependency. That seam is what carried the loop through the
Herald rollout: PR1 (#177) stood up the observation service, PR2 (#175) swapped the
poll for the Herald inbox + dual-wrote transition events alongside `state.json`,
and PR3 (#176) retired `state.json` — the Herald fold is now the sole source of
truth and the working state is rebuilt from it on cold start.
