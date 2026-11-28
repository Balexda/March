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

`requeue → cleanup → ghost-cleanup → castra-recover → relaunch → babysit →
recovery → adopt-from-fold → dispatch → dependency-merge → pr-labels`, awaited in
order. Do **not** parallelize — earlier handlers drop sessions/slices that later
ones must not act on. `requeue` runs **first** so no later handler touches a
slice the operator has discarded (cleanup archiving its just-closed PR, relaunch
re-attaching to its just-killed steward). `recovery` runs **after** `castra-recover`/`relaunch` (it
*prepares* a stuck slice — un-escalates it — for the gentle owner to heal next
tick, and descends a rung once that owner's budget is spent) and **before**
`dispatch` (so its last-resort rung-3 nuke frees the still-ready item for a fresh
re-dispatch this same tick).

| Handler | What it does |
|---------|--------------|
| [`requeue`](./handlers/requeue.ts) | **Runs first.** Operator requeue ([#588](https://github.com/Balexda/March/issues/588)/[#593](https://github.com/Balexda/March/issues/593)): for each slice whose fold carries a pending `requeueRequested`, tear down its incarnation through Brood by exact path (registering an untracked/dead session's worktree+branch first), close its open PR only when `closePr` was requested, delete a pushed remote branch, then drop it and append the rung-3 tombstone so `dispatch` re-launches the item fresh on the same tick. Bypasses the recovery ladder, including its `awaiting_input` refusal. Refuses an open PR without `closePr`, a merged PR, or a `hatchery-pending` slice (`slice.requeue.refused`); a failing teardown retries for 3 ticks, then gives up and rings the operator. |
| [`merge-now`](./handlers/merge-now.ts) | Operator merge now ([#593](https://github.com/Balexda/March/issues/593)): for a folded `slice.merge.requested`, re-read the PR from GitHub, refuse a closed/conflicting one, and squash-merge pinned to the live head SHA — bypassing the review/CI gates. Success → `merged`; any failure → `slice.operator.refused {action:"merge"}` (no retry). Runs right after requeue. |
| [`cleanup`](./handlers/cleanup.ts) | A slice whose PR is `MERGED`/`CLOSED` is done → request Brood teardown, then archive the slice. On a Brood 404 ([#225](https://github.com/Balexda/March/issues/225)): if the steward is still live in Castra, reconcile it into Brood from the observation (exact worktree/branch path, [#155](https://github.com/Balexda/March/issues/155)) and re-tear-down; if it's genuinely gone, archive idempotently. A real teardown failure defers (never archives over an orphan) and escalates to the operator after `MAX_CLEANUP_ATTEMPTS` instead of retrying forever. |
| [`ghost-cleanup`](./handlers/ghost-cleanup.ts) | A worker session whose worktree isn't tracked by any non-terminal slice (and old enough to not be a launch race) is an orphan → request Brood teardown. |
| [`relaunch`](./handlers/relaunch.ts) | A non-terminal slice with an open PR but a vanished worker → re-attach a fresh opus steward to the existing worktree/branch. Throttled per slice. An operator `slice.relaunch.requested` (#593) gets an unthrottled `operator` decision that also replaces a still-live steward; failures settle with `slice.operator.refused`. |
| [`babysit`](./handlers/babysit.ts) | The steward watchdog: login-block recovery, worker-error escalation, stranded-steward nudges, PR discovery, conflict / review-thread / CI handling, post-dispatch re-nudges. |
| [`recovery`](./handlers/recovery.ts) | Graduated recovery ladder ([#413](https://github.com/Balexda/March/issues/413), fixes [#409](https://github.com/Balexda/March/issues/409); supersedes the [#238](https://github.com/Balexda/March/issues/238) drop-only path). An operator `slice.recovery.requested` (or a slice already carrying `recovery_rung`) walks least-destructive-first: **0b** steward `awaiting_input` → refuse; **0a** errored session → un-escalate and let `castra-recover` restart it in place (descend by dropping the wedged session when its budget is spent); **1** vanished session → un-escalate to the working stage so `relaunch` re-attaches a steward to the **preserved** worktree; **2** relaunch budget spent → hold one tick to confirm; **3** last resort → tombstone + fresh re-dispatch (the old #238 behavior). Each descent is recorded durably (`slice.recovery.requested {rung}`) so a cold-start resumes mid-ladder; the walk completes the moment the slice is un-escalated with a live steward. Acting on the *drained* request is what reaches the warm loop — the fold edit alone never does (warm-loop invisibility). |
| [`dispatch`](./handlers/dispatch.ts) | Smithy's layer-0 ready items → Hatchery codex spawns; drains completed spawns; bounded auto-recovery of recoverable escalations (#211). While an operator has paused dispatch (fold `dispatchPaused`, #593) it only drains in-flight spawns. |
| [`pr-labels`](./handlers/pr-labels.ts) | **Runs last**, independent of slice work. Reconciles the two PR labels the legate owns on every open PR of the profile repo (see [Owned PR labels](#owned-pr-labels)). Lists open PRs at most every ~2 min per profile (one `gh pr list`), writes only non-empty diffs. Actions `pr-label-added` / `pr-label-removed` / `pr-label-failed`; each PR is isolated so one failure never blocks the rest. Kill switch: `MARCH_LEGATE_PR_LABELS=0`. |

### Owned PR labels

The legate owns exactly two labels and never touches any other: `march:opened`
(this PR is March's) and `march:needs-human` (a human must act). PRs without
`march:opened` are fair game to touch by hand. Rules, per open PR:

- **`march:opened`**: present when a slice in legate state links to the PR, or
  the head branch matches March's naming (`smithy/…`, `feature/smithy/…`,
  `march/spawn/…`; the branch fallback stops flapping when the fold briefly
  loses a slice→PR link). Otherwise removed.
- **`march:needs-human`** on a slice-linked PR: present when the slice is
  `escalated`, or its `merge_gate` is `waiting-approval` or
  `blocked-merge-state`; otherwise removed. Dependabot PRs are skipped
  (`dependency-merge` owns the label there). Non-slice PRs have it removed.

Observability: `pr_label` / `pr_label_failure` events, a `legate.pr-label` span
(on the slice trace when linked), and the `march.legate.pr_labels{label,op,outcome}`
counter. Set `MARCH_LEGATE_PR_LABELS=0` to disable the handler (default on).

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
the default-branch sync for every active profile. See the
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
  http.ts           Fastify server: status/escalation reads + operator actions (respond, requeue)
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
- the **launch-failure class** (launch-failure recovery step 2): Hatchery reports
  `error.failure = {class, retry, evidence}` on the job and the legate folds it onto
  `slice.escalated`. Only `retry: auto` keeps the backoff; `operator` (unpushed work
  in the way) and `adopt` (an open PR) are never re-dispatched, and
  `until_input_changes` (`agent_declined`) re-dispatches once when the task file or
  parent spec changes on the default branch (`rearmDeclinedHolds`).

The recoverable class is selected by the pure `recoverableEscalations`
(`pure/slice.ts`), disjoint from `dispatchableReady` (an escalated slice reads as
in-flight there). `#216` guarantees the re-dispatch is collision-free; teardown
still routes through Brood (#155), never a worktree prune here.

These transitions emit `slice.dispatched` / `slice.recovery.dispatched` /
`slice.escalated` / `retry.counted` events — the durable record the working state
is rebuilt from (#176); the two dispatch events carry the slice's action key
(command, arguments, artifact path, #653) so the rebuilt slices keep it — and a `recovery_dispatch` action-log event that re-lights
the (previously replay-only) recovery dispatch span.

**Operator recovery of a spent-budget escalation
([#238](https://github.com/Balexda/March/issues/238)).** Bounded auto-recovery
deliberately stops once the per-slice budget is exhausted: the slice stays
`escalated` and operator-only, and — because an escalated slice reads as in-flight
— it keeps de-duping the still-ready smithy work, with no internal path back. The
[`recovery`](./handlers/recovery.ts) handler is that path: an operator appends
`slice.recovery.requested` (via `march legate recover <sliceId>` — the legate's
attributed `POST /slices/:sliceId/recover` operator lever, #593 — or the
`legate.unwedge` skill); the handler drains it from the inbox and drops the slice
from the in-memory working state + clears its budget, so `dispatchableReady`
re-selects the item and `dispatch` re-launches it **fresh** the same tick. Acting
during the drain is required: the request's reducer drops the slice from the
durable fold (so a cold-start rebuild is also clean), but the warm loop's `raw` is
threaded in memory and only rebuilt from the fold on a cold start, so a fold edit
alone never reaches the running loop. No transition event is emitted by the
handler — the `slice.recovery.requested` (operator) and the ensuing fresh
`slice.dispatched` are the durable record.

## HTTP API ([`http.ts`](./http.ts))

| Method + path | Purpose |
|---------------|---------|
| `GET /healthz` | liveness + `build` stamp (service, version, describe, commit, built_at, started_at; unset values are `null`) |
| `GET /status` | latest heartbeat snapshot (last tick, queue, workers, counts) plus the same `build` stamp; `?profile=` for one profile |
| `GET /escalations` | escalated slices needing an operator (reason, PR, session, worktree, and the launch `failure` class/retry/evidence); `?profile=` for one profile |
| `POST /escalations/:sliceId/respond` | answer (`message`) or acknowledge (`ack:true`) a `steward_awaiting_input` escalation on a live steward |
| `POST /slices/:sliceId/requeue` | discard the slice's attempt (session, worktree, branch; open PR only with `closePr:true`) and re-dispatch it fresh — works on dead sessions and pending questions ([#588](https://github.com/Balexda/March/issues/588)); 202 + the [`requeue`](./handlers/requeue.ts) handler acts next tick |

Operator actions only append Herald events; the tick's handlers do the work, so
nothing mutates the in-memory working state outside a tick.

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
