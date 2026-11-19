# Legate Contract

Legate owns March's autonomous loop: it observes Smithy and service state, projects slice state, dispatches runnable work, babysits running workers and stewards, and records terminal outcomes. This contract documents the Legate-owned behavior that L2 tests and operators can assert without scraping terminal logs or re-authoring Herald, Hatchery, Brood, Castra, or Steward contracts.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

Legate is started through the `march legate` command group. Profile onboarding now lives at the top-level `march init <profile> --repo <path>`, which ensures the full service stack is up (the idempotent `march up` path) and then registers a deployment profile for a repository and manager context, including the repository path and name, profile name, worker group, paired Legate steward/conductor metadata, local March CLI path, mode, and the carried-over worker toolchain and dispatch priority. `march legate init` and `march profile register` remain as deprecation shims that forward to the same registration for one release. Merge policy is configured separately through `march profile merge-policy set` rather than at onboarding, and service endpoints are environment configuration (and legacy-meta seed) rather than registered profile fields; the loop reads any merge policy present on the profile record from Herald's registry each tick. `march legate serve` starts the profile-agnostic service process; the back-compat `march legate loop` alias reaches the same serve entrypoint. `march legate recover <sliceId>` is an operator-visible recovery request path that appends an event for the running service to consume on its next tick.

`POST /escalations/:sliceId/respond` on the running legate service (with the `march legate respond <sliceId>` CLI wrapper) is the operator path for a slice escalated as `steward_awaiting_input`. It takes exactly one mode — `message` (answer mode: delivered into the live steward session via Castra, then the escalation is cleared) or `ack:true` (mark-read: cleared without a delivery) — and rejects a request that omits both or supplies both. It routes by `profile` (request body or `?profile=`, defaulting to the sole registered profile) and targets only a slice whose stage is `escalated` with reason `steward_awaiting_input`. On success it flips the steward self-report to a non-awaiting status and appends `slice.recovery.requested`, so the graduated recovery ladder un-escalates the slice back to babysit's PR (fix + merge) handling on the next tick; the JSON result reports `ok`, `mode`, `delivered`, `cleared`, and `recoveryRequested`. It returns 400 for a missing/ambiguous mode or missing profile, 404 for an unknown profile or a slice not in a respondable escalation, and 501 where the effecting runtime is unavailable. The action emits a `legate.respond` child span and a slice-correlated log so a failed or partially delivered respond is visible in the slice trace.

`POST /slices/:sliceId/requeue` on the running legate service (with the `march legate requeue <sliceId> [--close-pr] [--reason <text>]` CLI wrapper) is the operator lever that discards a slice's current attempt and puts its smithy item back in the queue. It accepts any in-flight slice regardless of stage, escalation reason or session liveness — including a steward parked `awaiting_input` whose session has died, which both respond and recover refuse (#588). The body carries `profile` (or `?profile=`), optional `closePr` (boolean), and optional `operator`/`reason` strings for attribution. It returns 202 after appending `slice.requeue.requested` to Herald; 400 for a missing profile or mistyped field; 404 for an unknown profile or slice; 409 for an archived, already-recovered or `hatchery-pending` slice, a merged PR, or an open PR without `closePr:true`; 502 if Herald rejects the append; 501 where the runtime is unavailable. The request is durable in the fold (`requeueRequested`), and the requeue handler — first in the tick pipeline — acts on it: it tears the incarnation down through Brood by exact path (registering an untracked or dead session's worktree/branch first), closes the open PR with an attribution comment when `closePr` was given, deletes a pushed remote branch, then drops the slice and appends the `slice.recovery.requested {rung:3}` tombstone so dispatch re-launches the item fresh. A refused request appends `slice.requeue.refused`; a teardown that keeps failing retries up to three ticks, then gives up with `slice.requeue.refused` and an operator judgement request. The request emits a `legate.requeue.request` span and each outcome a `legate.requeue` span (errored unless done) on the slice trace.

The service process exported by `src/legate/loop/index.ts` is the loop startup surface. `runLoop(opts)` reconciles telemetry identity, configures the loop runtime, starts the Fastify status server, starts the periodic runtime, and resolves only during graceful shutdown. `RunLoopOptions` accepts an optional port and environment. `DEFAULT_LOOP_PORT` names the default HTTP port, and `LEGATE_SERVICE_NAME` names the telemetry service identity. `reconcileOtelEnv(env)` is the exported configuration helper that ensures the service has a stable OTel name. `getActiveOtel` remains exported for callers and tests that need the live telemetry handle.

The runtime exported by `src/legate/loop/runtime.ts` is the orchestration entrypoint surface. `configureLoopRuntime({ profileClient, intervalSeconds, homeDir, env })` supplies the profile registry client, tick cadence, filesystem root, and environment. `startLoopRuntime()` starts the periodic scheduler and returns a stop handle. `runTickOnce()` runs one immediate tick for tests or future explicit tick triggers. `getLoopSnapshot()` returns the latest per-profile heartbeat snapshot consumed by the HTTP status endpoint. The HTTP surface exported by `src/legate/loop/http.ts` consists of `buildLoopServer(ctx)`, `startLoopHttpServer(ctx, port, host)`, `buildStatus(ctx, profile?)`, and `statusForRecord(record, tick)`, which expose `/healthz` and `/status` diagnostics without making the HTTP route contract the source of Legate behavior.

Legate's required public inputs are:

- Repository context: the profile registry's repository path and name, plus local Smithy artifacts discovered from that path.
- Profile or manager context: profile name, worker group, paired Legate steward/conductor metadata, configured March CLI path, merge policy, and backend/toolchain context passed to dispatch.
- Herald cursor: the single multiplexed event cursor and per-profile folded projection that the loop drains and replays.
- Projected slice state: planned or runnable Smithy work, running slice records, archived records, PR observations, steward attachments, recovery requests, and terminal facts folded from events.
- Service readiness: Herald for events and profiles, Hatchery for dispatch jobs, Brood for lifecycle and teardown authority, Castra for hosted session observation and prompts, plus local git, Smithy, `gh`, and filesystem dependencies.
- Steward attachment metadata: session id, profile, worker group, slice id, trace key, status, and worktree or PR metadata observed through Herald/Castra boundaries.

Shared PR sensing classifies full conversation comment bodies before creating previews. Review-bot commands, March review triggers, and reviewer notices are excluded from `conversation_comments`. The PR snapshot carries `reviewer_notices` with `reviewer`, `kind` (`status`, `in_progress`, `rate_limited`, or `paused`), `created_at`, and an optional ISO-8601 `reset_at` when the notice supplies a reset time. Notices require a recognized bot identity. Unresolved inline threads continue through the review-thread path and can block merge. Sensing continues to report the existing `codex_review` and `coderabbit` observations.

Babysit uses Herald's feedback classification for both operator- and app-authored
PRs. After successfully sending a fix for inline or conversation feedback,
Legate records the handled comment IDs in the Herald stage transition. A restart
restores those IDs and the latest fix dispatch context from the fold, so a
parked worker still gets the bounded nudge, review-fix escalation and the
comment-fix steward-stuck escalation, and a distinct
external reply can still trigger a fix.

Legate resolves the GitHub repository from the profile checkout's origin
before asking Tessera for an app entitlement. Independent reads use
`app/read`. Merges, reactions, comments, labels, PR closures, and remote
branch deletion use `app/write`. Merges pin the head SHA from the observation,
and slice PR observations continue to come from Herald's fold. Deployed
conductor skills use the same access split for GitHub reads and writes,
including `app/read` over HTTPS for default-branch fetches.

Each GitHub CLI child gets its own empty configuration directory and its
credential through the environment. A confirmed GitHub 401 allows one retry
with a refreshed entitlement. An issuance failure stops that action with a
sanitized diagnostic and an errored `tessera.issue` span on the slice trace
when a slice ID is available. Other profiles and subsequent ticks continue.
CI reruns use `app/write`. If that entitlement lacks Actions permission,
the conductor reports a failed rerun for the operator to perform.

The `march-legate` container receives `MARCH_TESSERA_URL` (default
`http://tessera:9477`) and `MARCH_TESSERA_CLIENT_KEY`. Until the Legate client
key is distributed, the compose file enables `MARCH_TESSERA_GH_TOKEN_FALLBACK=1`
by default, so a failed issuance falls back to the forwarded
`GH_TOKEN`/`GITHUB_TOKEN` and records a Tessera client fallback. The mounted
`gh` login is never read. Operators set the fallback to `0` once Tessera issues
Legate entitlements.

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
13. Legate resolves the profile's merge policy on each tick. The built-in `cut` row skips approval, `forge` requires approval and allows `coderabbitai`, and the other built-in verbs require human approval. An explicit verb entry overrides its row. Profile defaults apply to verbs added by the profile. An unidentified verb requires human approval. Changes-requested remains mandatory unless the profile explicitly relaxes it for the verb. Babysit and merge readiness share these review checks. For current snapshots both checks use each reviewer's latest verdict in `pr.reviews`. A human approval satisfies the gate. A verified, allowlisted bot approval satisfies it when the verb permits bot approval and the verdict names the current head. A human or allowlisted bot changes-requested verdict blocks regardless of the commit reviewed. March's bot is excluded. Legacy snapshots retain their human counts and any verified, allowlisted CodeRabbit changes-requested blocker. Trusted bot approval requires a reviewer verdict. When the observer could not read every review page for the current head (`reviews_complete: false`), required approval and changes-requested checks fail closed.
14. Dependency-update auto-merge is off unless the profile's merge policy sets `dependencyUpdates.autoMerge`. When on, Legate merges an open Dependabot pull request only if it is not a draft, every changed file is a dependency manifest, lockfile, Dockerfile, or GitHub Actions workflow, at least one check ran and all passed, and GitHub reports it mergeable with a clean merge state. It queries GitHub at most once per profile per five minutes, attempts at most one merge per query pinned to the observed head SHA, and attempts each head SHA once. These pull requests are not slices: the action log and its `legate.dependency-merge` span are the record, and no Herald transition event is written.
15. With dependency-update auto-merge on, a Dependabot pull request that would qualify but for a merge conflict (`mergeable` `CONFLICTING` or merge state `DIRTY`; `UNKNOWN` is not a conflict) goes through a conflict ladder. Legate waits 30 minutes for Dependabot's own rebase, skipping the wait when a commit on the branch is not by Dependabot, since Dependabot does not rebase such a branch. It then comments `@dependabot recreate`, at most twice per pull request. If Dependabot does not act on a recreate within 30 minutes, or the pull request is still conflicted 30 minutes after the second one, Legate escalates once: it adds the `march:needs-human` label and posts a comment giving the reason. While that label is present the ladder makes no further GitHub calls for the pull request. The ladder never merges; a recreated pull request is merged by the rule above once its checks pass. The recreate count is folded as a `retry.counted` transition (key `dependabot-recreate:<pr>`, zeroed when the pull request closes) so it survives a restart; the wait timers are in memory and restart on a cold start. Ladder actions are `dependency-recreate-requested`, `dependency-recreate-failed`, `dependency-unblock-escalated`, `dependency-unblock-escalate-failed`, and `dependency-unblock-resolved` (a laddered pull request that merged), each with a `legate.dependency-unblock` span on the pull request's trace and a `march.legate.dependency.unblock{outcome}` count.
16. Legate requests CodeRabbit reviews for tracked, open, non-draft forge PRs with passing checks when the resolved forge reviewer row opts into comment-trigger mode. Auto mode observes. Set the forge opt-in with `march profile merge-policy set <profile> --task-type forge --review-request coderabbit`. Deployments using the legacy profile-wide CodeRabbit flags need this per-verb opt-in. New-head requests also require resolved threads and a conflict-free PR. A stale or dismissed CodeRabbit approval qualifies only if approval is the sole remaining gate. The existing merge gate still requires a current-head, allowlisted bot approval and retains stale changes-requested blockers. Legate waits for Herald to acknowledge the per-head intent before posting the incremental `@coderabbitai review` command with a March head marker. A recent intent or in-progress notice suppresses repeats. An unanswered attempt can retry after `MARCH_REVIEW_WAIT_MINUTES` (default 30) and any active reviewer back-off. GitHub trigger and review timestamps determine whether a review answered an attempt. Legate checks the complete comment history if the marked trigger is missing from the sampled comments. `MARCH_CODERABBIT_REVIEWS_PER_DAY` counts recorded attempts across profiles, including failed posts, and resets at UTC midnight. Unset is unlimited and zero disables posting. Invalid values warn and use the defaults. Decisions use the `review-request` and `review-request-failed` actions (a back-off refusal logs `review-request-deferred`, which is not a failure), the slice child span `legate.review.request`, and the `march.legate.review.requests` counter labeled by reviewer and outcome. See [March vision](../../vision.md) and [operating philosophy](../../operating-philosophy.md).

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

### CodeRabbit account-wide pacing

Legate processes throttling notices and fresh current-head reviews across
profiles before evaluating review requests. An HTTP 429 or other GitHub rate
limit, a rate-limit notice, a pause notice, or a failed post records
`review.backoff` in Herald. A usable stated reset takes precedence over the
bounded exponential delay. The deadline covers every CodeRabbit comment-trigger
request. Legate waits for Herald to acknowledge pending updates and retries them
on later ticks. Replay preserves the attempts, deadline, and processed notice
identities. On startup an unanswered latest intent without a later back-off
needs a complete trigger lookup. An unknown post outcome records `post_failed`
with delay anchored at the intent's timestamp before posting can resume.
A fresh review on a current head clears attempts, and incoming review verdicts
continue to be evaluated by the merge gate during back-off.

Throttle and pause decisions and active deadline refusals emit a non-errored
`legate.review.request` child span and `review-request-deferred` action.
Post and persistence failures emit errored child spans. Both paths count
decisions by reviewer and outcome. New HTTP rate-limit hits and rate-limit
notices also increment `march.legate.review.rate_limited` with only the
`reviewer` label.

At the end of each multi-profile tick with a successful ledger read, Legate
refreshes the `march.legate.review.cap_remaining` gauge. It counts acknowledged
review intents across profiles, including failed posts, in UTC calendar windows.
The only labels are `reviewer` and `window` (`day` or `month`). Finite
balances have a floor of zero and unlimited windows emit no sample.
`MARCH_COPILOT_REVIEWS_PER_DAY` and `MARCH_COPILOT_REVIEWS_PER_MONTH`
both default to zero. The optional CodeRabbit daily cap uses the same
calculation as request enforcement.
