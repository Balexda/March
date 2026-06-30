# Legate Contract

Legate owns March's autonomous loop: it observes Smithy and service state, projects slice state, dispatches runnable work, babysits running workers and stewards, and records terminal outcomes. This contract documents the Legate-owned behavior that L2 tests and operators can assert without scraping terminal logs or re-authoring Herald, Hatchery, Brood, Castra, or Steward contracts.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Legate is started through the `march legate` command group. Profile onboarding now lives at the top-level `march init <profile> --repo <path>`, which ensures the full service stack is up (the idempotent `march up` path) and then registers a deployment profile for a repository and manager context, including the repository path and name, profile name, worker group, paired Legate steward/conductor metadata, local March CLI path, mode, and the carried-over worker toolchain and dispatch priority. `march legate init` and `march profile register` remain as deprecation shims that forward to the same registration for one release. Merge policy is configured separately through `march profile merge-policy set` rather than at onboarding, and service endpoints are environment configuration (and legacy-meta seed) rather than registered profile fields; the loop reads any merge policy present on the profile record from Herald's registry each tick. `march legate serve` starts the profile-agnostic service process; the back-compat `march legate loop` alias reaches the same serve entrypoint. `march legate recover <sliceId>` is an operator-visible recovery request path that appends an event for the running service to consume on its next tick.

The service process exported by `src/legate/loop/index.ts` is the loop startup surface. `runLoop(opts)` reconciles telemetry identity, configures the loop runtime, starts the Fastify status server, starts the periodic runtime, and resolves only during graceful shutdown. `RunLoopOptions` accepts an optional port and environment. `DEFAULT_LOOP_PORT` names the default HTTP port, and `LEGATE_SERVICE_NAME` names the telemetry service identity. `reconcileOtelEnv(env)` is the exported configuration helper that ensures the service has a stable OTel name. `getActiveOtel` remains exported for callers and tests that need the live telemetry handle.

The runtime exported by `src/legate/loop/runtime.ts` is the orchestration entrypoint surface. `configureLoopRuntime({ profileClient, intervalSeconds, homeDir, env })` supplies the profile registry client, tick cadence, filesystem root, and environment. `startLoopRuntime()` starts the periodic scheduler and returns a stop handle. `runTickOnce()` runs one immediate tick for tests or future explicit tick triggers. `getLoopSnapshot()` returns the latest per-profile heartbeat snapshot consumed by the HTTP status endpoint. The HTTP surface exported by `src/legate/loop/http.ts` consists of `buildLoopServer(ctx)`, `startLoopHttpServer(ctx, port, host)`, `buildStatus(ctx, profile?)`, and `statusForRecord(record, tick)`, which expose `/healthz` and `/status` diagnostics without making the HTTP route contract the source of Legate behavior.

Legate's required public inputs are:

- Repository context: the profile registry's repository path and name, plus local Smithy artifacts discovered from that path.
- Profile or manager context: profile name, worker group, paired Legate steward/conductor metadata, configured March CLI path, merge policy, and backend/toolchain context passed to dispatch.
- Herald cursor: the single multiplexed event cursor and per-profile folded projection that the loop drains and replays.
- Projected slice state: planned or runnable Smithy work, running slice records, archived records, PR observations, steward attachments, recovery requests, and terminal facts folded from events.
- Service readiness: Herald for events and profiles, Hatchery for dispatch jobs, Brood for lifecycle and teardown authority, Castra for hosted session observation and prompts, plus local git, Smithy, `gh`, and filesystem dependencies.
- Steward attachment metadata: session id, profile, worker group, slice id, trace key, status, and worktree or PR metadata observed through Herald/Castra boundaries.

Legate's public outputs are:

- Hatchery dispatch request metadata: prompt, backend, repository path, agent-deck profile, manager group, title, branch, deployment profile, task type, task name, optional toolchain, and slice id correlation.
- Event cursor: the post-drain cursor and per-profile event fold used to rebuild working state after restart.
- Slice decision: dispatch, wait, relaunch, babysit, recover, adopt, cleanup, merge, archive, terminal failure, or no-op.
- Terminal outcome: externally visible stage, archive, request, diagnostic, or terminal label that stops further autonomous action for a slice until new events or explicit recovery permit work.
- Deterministic trace relationship: `legate.dispatch` is the slice trace origin, and downstream service actions join the same deterministic slice trace.
- Bounded diagnostic output: status payloads, heartbeat counters, action events, processor requests, errored spans, and concise diagnostics suitable for tests and operator display.

### Cross-Contract Ownership Boundaries

| Provider boundary | Provider contract | Legate relationship | Ownership rule |
|-------------------|-------------------|---------------------|----------------|
| Herald | `docs/subsystems/herald/contract.md` (future) | Legate consumes event-log cursors, folded projections, profile observations, and recovery events. | Legate owns cursor use, replay decisions, and loop state changes; Herald owns event-log and projection behavior. |
| Hatchery | `docs/subsystems/hatchery/contract.md` | Legate dispatches runnable slices and observes job outcomes through the Hatchery boundary. | Legate owns slice selection, dispatch metadata, and trace origin; Hatchery owns dispatch service behavior. |
| Brood | `docs/subsystems/brood/contract.md` (future) | Legate observes lifecycle state and asks for teardown or cleanup decisions to be reflected. | Legate owns loop decisions made from lifecycle evidence; Brood owns lifecycle state and cleanup authority. |
| Castra | `docs/subsystems/castra/contract.md` (future) | Legate observes hosted worker or steward sessions and attachment state. | Legate owns babysit, relaunch, and terminal decisions; Castra owns session hosting and attachment behavior. |
| Steward | `docs/subsystems/steward/contract.md` | Steward attachment, loss, or terminal outcome can affect Legate decisions. | Legate owns decisions made from steward state; the Steward contract owns Steward-specific role behavior. |

These references are owner pointers for future freshness mapping. They do not
define provider route tables, request or response schemas, Castra adapter
details, or Steward-specific role behavior. Legate documents only the loop
decisions it makes from those boundaries and the metadata it supplies to them.

## Invariants

Legate's loop behavior follows the low-touch execution model in `docs/vision.md`: Smithy decomposes work into quality plans, and March executes those plans with minimum operator intervention. Its recovery behavior follows the autonomous-component rules in `docs/operating-philosophy.md`: autonomous loop work does not block on interactive prompts, access is carried through typed service inputs, and failures become clean events, exits, or terminal diagnostics rather than hangs.

1. Legate owns the persisted Herald cursor it consumes for the loop. A service restart resumes from the last durable cursor or replays from the Herald fold; replayed events must rebuild equivalent per-profile working state before new dispatches are selected.
2. Event application is delta-based and idempotent. Duplicate, already-folded, or stale events must not create duplicate dispatches, duplicate terminal transitions, or regress a terminal slice into runnable work.
3. Cursor gaps, malformed events, and replay exhaustion are diagnostic states. The loop may skip a tick or mark a bounded failure, but it must not silently corrupt slice projection or wait for terminal input.
4. Slice projection includes planned or runnable Smithy work, running workers, Hatchery-pending jobs, attached stewards, relaunch candidates, blocked or waiting work, PR-open work, merge-ready work, archived work, and terminal outcomes. Tests must be able to diagnose a stalled slice from projected state plus events rather than terminal scrollback.
5. A slice is dispatchable only when Smithy state says the work is ready, no nonterminal projection already owns that slice id, service readiness permits dispatch, and the global spawn budget allows another live worker.
6. Legate supplies Hatchery dispatch metadata for every launch: task identity, action command metadata, branch or slice identity, repository path, profile/backend context, manager group, optional toolchain, and the slice id used for correlation.
7. A successful dispatch records a durable slice transition containing the slice id, branch, and Hatchery job id. Pending job completion is pollable across ticks and recoverable after restart from the Herald fold.
8. `legate.dispatch` is the deterministic root span for a slice trace. Hatchery, Spawn, Herald observations, Brood teardown, Castra prompts, babysit, relaunch, cleanup, and other service-side actions must nest under the deterministic slice trace instead of starting unrelated trace roots.
9. Babysit decisions are noninteractive. Timeout, missing worker, missing steward, lost session, failed status query, relaunch eligibility, cleanup eligibility, and merge readiness become action events, processor requests, relaunches, cleanup actions, or terminal failures.
10. Relaunch is bounded by recorded recovery budget and projection state. Exhausted relaunches become an externally visible request or terminal failure label; they must not loop forever or create unbounded duplicate workers.
11. Cleanup decisions use Brood as lifecycle and teardown authority. Cleanup success, cleanup failure, ghost cleanup, and steward retirement are recorded as events or diagnostics, and cleanup failure must preserve the original slice outcome evidence.
12. Terminal outcomes are justified by service state or events: merged PR state, closed or failed PR state, Hatchery job failure, worker failure, steward loss, timeout, recovery exhaustion, invalid projection, or explicit recovery/terminal events. Once terminal, autonomous dispatch stops until a new event or recovery request changes the state.

## Error Modes

| Error mode | Observable outcome |
|------------|--------------------|
| Missing repository context | The profile tick records a `state_error`, skips dispatch, and surfaces a bounded diagnostic naming the missing repository path or Smithy artifact. |
| Invalid profile or manager metadata | `march init <profile>` (and the deprecated `march legate init`) fails fast for invalid names or missing local prerequisites; the service tick skips an invalid profile and emits a diagnostic rather than dispatching with ambiguous manager context. |
| Missing service readiness | Legate emits or returns a service-readiness diagnostic and selects no new dispatch for that tick. |
| Unavailable Herald | Profile listing or inbox drain failure records a `profile_list_failed` or `herald_drain_failed` diagnostic and the tick exits cleanly without corrupting cursor state. |
| Unavailable Hatchery | Dispatch launch or job poll failure records a dispatch failure, processor request, or waiting decision for the slice; no interactive prompt is required. |
| Unavailable Brood | Teardown, register, retire, or lifecycle observation failure records cleanup or babysit failure evidence and preserves the slice state that required Brood action. |
| Unavailable Castra | Session observation or prompt delivery failure becomes a babysit, relaunch, steward-stranded, or recovery diagnostic tied to the slice/session id. |
| Local dependency failure | Missing git, Smithy, `gh`, filesystem access, or March CLI path becomes a bounded state or processor diagnostic; the loop does not block waiting for operator input. |
| Cursor gap | The cursor diagnostic names the gap or replay failure, stops applying unsafe deltas, and skips dispatch or produces a terminal projection diagnostic until a valid replay is available. |
| Malformed event | The malformed event is ignored or quarantined with a diagnostic; it must not mutate slice state in a way tests cannot assert. |
| Duplicate event | The duplicate is folded idempotently and does not duplicate dispatch, relaunch, cleanup, merge, terminal, or processor-request side effects. |
| Stale slice state | Stale nonterminal projection becomes a wait, relaunch candidate, cleanup candidate, or stale diagnostic according to observed worker, steward, PR, and Hatchery state. |
| Contradictory projection state | Conflicting worker, PR, terminal, or archive facts produce a bounded diagnostic or processor request and no unsafe dispatch. |
| Replay exhaustion | Legate reports replay exhaustion, keeps prior durable evidence, and exits the tick cleanly rather than looping indefinitely. |
| Hatchery dispatch failure | The slice records dispatch failure evidence, an errored dispatch span, and a processor request or recoverable decision keyed by slice id. |
| Worker launch failure | The slice remains unlaunched or terminal-failed with the Hatchery/job diagnostic; no steward handoff is assumed. |
| Worker loss | Babysit records missing-worker evidence and chooses relaunch, cleanup, or terminal failure based on recovery budget and observed state. |
| Steward attachment loss | Legate records steward-stranded or steward-loss diagnostics and chooses nudge, relaunch, cleanup, or terminal failure without assuming Steward role behavior. |
| Steward session loss | Castra/Brood evidence drives a relaunch or terminal failure decision and records the affected session id. |
| Timeout | Timeout becomes a relaunch, processor request, or terminal failure event with slice correlation; it never becomes an unbounded wait. |
| Relaunch exhaustion | The slice receives an externally visible recovery-exhausted or terminal-failure diagnostic that stops autonomous relaunch until explicit recovery. |
| Cleanup failure | Cleanup failure is emitted as cleanup failure evidence and does not mask the original merged, failed, skipped, stale, or terminal outcome. |
| Trace correlation failure | The action still records a bounded diagnostic or errored span, and the absence or wrong parent relationship is a telemetry gap test can assert against the deterministic slice id. |
| Oversized or noisy diagnostics | Legate surfaces bounded summaries through status, heartbeat, events, processor requests, and logs; callers are not required to parse unbounded terminal output. |

All Legate error modes resolve as clean tick exits, emitted events, processor requests, terminal labels, or bounded diagnostics. They do not require an interactive prompt inside the autonomous loop.
