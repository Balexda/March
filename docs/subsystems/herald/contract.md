# Herald Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

The published `@balexda/march/modules/v0` authoring contract defines the producer
and destination observe facets that Herald is planned to call. Herald does not
load or invoke work modules yet. See the
[work module authoring reference](../legate/contract.md#work-module-authoring).

Herald observes each registered profile and appends changes to its event log.
The profile checkout's local GitHub `origin` identifies the repository before
Herald makes GitHub requests. Herald requests a repository-scoped Tessera
`app/read` entitlement for repository metadata, PR details, review data and the
open-PR cursor. Branch discovery matches same-repository heads regardless of who
opened the PR. Herald uses the Tessera app login and the legacy `[march-bot]`
reply prefix to distinguish March's replies from external feedback. It excludes
March's conversation comments and reviews from feedback, and an inline thread
whose latest reply is from March has no response due. The existing CodeRabbit
standing records `decision_is_bot: true` when the review list is complete and
GitHub identifies the decisive review's author as a bot.

PR snapshots in `slice.pr.changed` include a `reviews` array with one entry
per reviewer identity. A human and a bot with matching normalized logins have
separate entries. Each entry includes `login` (lowercase with the
`[bot]` suffix removed), `author_kind` (`human` or `bot`), `state`
(`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` or `COMMENTED`),
`commit_sha` (string or null) and `submitted_at` (ISO-8601). A comment
cannot supersede an approval, a request for changes or a dismissal.
Herald classifies authors from GitHub's actor type and login without consulting
the verb's allowlist. The Tessera app and the login configured by
`MARCH_SELF_BOT_LOGIN` are excluded. The existing aggregate counts and
CodeRabbit standing are still recorded. The PR snapshot includes `is_draft` and
GitHub timestamps of raw CodeRabbit reviews and sampled March triggers, grouped
by head. `copilot_review_times` carries the latest verified Copilot review timestamp per head for request eligibility and pacing. `reviews_complete: false` marks partial evidence from an unfinished
review page walk. The snapshot also carries `needs_steering`, true when the PR has the
`march:needs-steering` label. It is read from the same `gh pr view` call, and a
label change bumps `updatedAt`, so the change cursor sees it. Herald refreshes
older snapshots that lack review verdicts, draft status or `needs_steering` on
the next observation.

A Legate `slice.stage.changed` event may include `handledFeedback` with a
`kind` of `inline` or `conversation` and an array of string `commentIds`.
An optional string `dispatchKey` names the fix dispatch that handled them, and
an optional string `headSha` records the PR head it was sent against. The fold
accumulates the IDs per slice and kind, and keeps the latest dispatch (kind,
key, event time and head SHA), for Legate to restore on restart.

A `slice.dispatched` transition can carry an `attemptId` and an absolute
`stewardDeadline` in ISO UTC format with milliseconds. The fold retains both
for restart recovery. Legate records a successful Brood handoff through a matching
`slice.stage.changed` transition with the attempt, spawn, branch, session, and
worktree identifiers. Replay ignores a handoff for a superseded attempt.
Legate appends `slice.integration.failed` with the
`sliceId`, `attemptId` and typed failure `outcome` after Brood returns a
durable failure or fences an attempt without an outcome. When the attempt
matches the current dispatch, the fold stores `integrationFailure`
and moves the slice to `escalated` with reason `hatchery_dispatch_failed`.
The failure has a null spawn ID when no spawn was linked or reported.
A `slice.escalated` transition may carry a `failure` (the Hatchery launch-failure
`{ class, retry, reason, evidence? }`, see the Hatchery contract). `POST /events`
rejects an unknown class or retry policy and stores only the bounded evidence
fields. The fold keeps it as the slice's `escalationFailure`. An escalation with a
reason but no failure clears it, as do a fresh `slice.dispatched`, a
`slice.recovery.requested`, and a `slice.stage.changed` to any stage other than
`escalated`. Events without `failure` fold as before.
A new attempt clears the prior fallback. When `MARCH_LEGATE_OPERATOR_TOKEN`
is set, this failure transition requires the bearer token.

`GET /state/integration/:sliceId?profile=<profile>` returns
`{ outcome: PrIntegrationResult | null }` for the slice's current attempt.
The profile defaults to Herald's default profile. Herald reads the outcome
through Brood's attempt lookup and returns it when present. Once Brood
confirms that no outcome exists, Herald uses the folded failure, if any.
A `null` outcome means there is no terminal result. When the Brood read
fails, Herald returns `503`. The `HeraldClient.integrationOutcome` method
exposes this read to consumers. Historical `/state?at=` reads use the event
log and snapshots.

Herald synchronizes every active profile's default branch before each
observation (#601; there is no switch, and removing the profile is how to stop
it). Herald fetches and pulls over HTTPS with the same repository entitlement
and requires a fast-forward.

Each sync produces a checkout status (#592): `ok`, `defaultBranch`, local
`head`, `originHead` (`refs/remotes/origin/<default>`), `behind` and `ahead`
(commits between them after the fetch), an `error` on failure, and `at`. On a
failed sync the position fields are the last-known local values from a no-fetch
read, or null. Herald appends `repo.sync.changed { sync }` only when `ok`,
`defaultBranch`, `head`, `originHead`, `behind` or `ahead` differ from the
fold, so a steady checkout adds no events; the fold keeps it as
`SystemState.repoSync`, and Legate serves it as `checkout` on `/queue` and
`/status`. Herald's `GET /status` adds `by_profile[p].sync`: the folded status
plus in-memory `last_fetch_at` (last attempt) and `last_success_at`, which reset
when Herald restarts.

Herald's `GET /healthz` returns `{ status: "ok", build }` and `GET /status` includes `build` with `service: "herald"` and `started_at` set when the module loads. All successful `/healthz` and `/status` responses also carry a `build` object (C-BUILD): `service`, `version` (package version) and `started_at` (RFC3339 UTC, seconds) are always strings; `describe`, `commit` and `built_at` come from the image env `MARCH_GIT_DESCRIBE`/`MARCH_GIT_SHA`/`MARCH_BUILD_TIME` (set at build time by `scripts/build-args.sh`) and are `null`, never `""`, when unset or empty. `commit` is a lowercase 40-hex SHA and `built_at` an RFC3339 UTC (`Z`) timestamp with in-range fields (no leap second); a value that doesn't match is reported as `null`. `describe` is passed through as a free-form string (normally `git describe --tags --long --dirty --always` output). `buildInfo` in `src/shared/build-info.ts` builds it.

Herald reads these settings:

| Variable | Meaning |
|----------|---------|
| `MARCH_TESSERA_URL` | Tessera base URL. |
| `MARCH_BROOD_URL` | Brood base URL for attempt lookups. Compose defaults to `http://brood:9748`. |
| `MARCH_TESSERA_CLIENT_KEY_FILE` | File holding Herald's own Tessera client key (takes precedence over `MARCH_TESSERA_CLIENT_KEY`). The compose file defaults it to `~/.march/tessera/keys/herald.key`, which `march tessera provision` writes; `MARCH_HERALD_TESSERA_CLIENT_KEY_FILE` overrides the path. Compose forwards no `GH_TOKEN`/`GITHUB_TOKEN` and sets no fallback. |

### Profile merge policy

`POST /profiles` validates the optional `mergePolicy` before replacing the saved
policy. `GET /profiles/:profile` returns the normalized policy. The existing
`defaults` and `byTaskType` requirement objects accept `botApprovers`, a list of
1–10 logins stored in lowercase with the `[bot]` suffix removed. Herald rejects
the login configured by `MARCH_SELF_BOT_LOGIN`, which defaults to `march-bot`.
An invalid write leaves the saved policy intact. An invalid stored policy
falls back to Legate's built-in table.

A `POST /profiles` that changes the saved policy (compared without regard to
key order) appends `profile.merge_policy.changed` with the `previous` and new
`mergePolicy` (null when unset) under that profile. A plain re-registration
that omits or repeats the policy appends nothing. The optional
`attribution: {operator?, note?}` on the request is stamped on that event. The
reducer ignores the event: the registry remains the policy's source of truth.

`reviewRequests.byTaskType.<verb>.reviewers` accepts CodeRabbit (mode
`comment-trigger` by default or `auto`) and Copilot (no mode). An empty list
disables requests for the verb. The existing `dependencyUpdates` and
`codeRabbit` settings remain part of the wire format.

Use `march profile merge-policy show <profile> [--json]` to inspect effective
values and their provenance. Pass `--task-type <verb>` to
`march profile merge-policy set <profile>` with `--bot-approver` or
`--no-bot-approver` to edit bot logins. Use `--review-request` or
`--no-review-request` to edit reviewers.

## Invariants

- Each GitHub CLI invocation receives an isolated, initially empty
  configuration directory and a child-only credential. The credential never
  appears in command arguments or the parent environment.
- Git network operations disable credential helpers, SSH, hooks, redirects and
  interactive prompts. They pin TLS verification and the system trust anchors,
  so checkout-local configuration cannot weaken the credentialed request.
- An identically named fork branch never becomes a slice's PR.
- A confirmed GitHub 401 allows one request with a refreshed credential.

This follows the [March vision](../../vision.md) and
[operating philosophy](../../operating-philosophy.md).

## Error Modes

- A typed Tessera failure records an errored span and ends that profile's tick
  before any observation events are appended. Herald continues with the next
  profile.
- A missing or non-GitHub `origin` fails the profile's GitHub reads with the
  typed `github_repo_unavailable` error. A rewritten effective remote URL fails
  with `github_remote_rewritten`, and a missing system CA bundle fails with
  `github_tls_unavailable`. All three fail before any credential is sent.
- A sync failure that is not a Tessera failure is logged, and the tick observes
  the local checkout.

## Operator attribution

When `MARCH_LEGATE_OPERATOR_TOKEN` is set on Herald (the same value Legate
uses), `POST /events` requires `Authorization: Bearer <token>` (constant-time
compare, read per request) for the event types that ask Legate to act:
`slice.merge.requested`, `slice.relaunch.requested`, `slice.requeue.requested`,
`slice.recovery.requested`, `dispatch.paused`, `dispatch.resumed` and
`legate.tick.requested`. Without it they return 401. Merge-now skips the review
and CI gates, so a caller that can reach Herald must not be able to bypass
Legate's operator gate by writing the request directly. Every other event type
stays open, and so do these when the token is unset. Legate's Herald client sends
the bearer on every append.

`POST /events` accepts an optional `attribution: {operator?, note?}` object
(operator at most 128 characters, note at most 1000) on any event (#593).
Herald strips it from the payload and stamps `operator`/`note` on the event
envelope without the `admin` flag. The fields come back on `GET /events` and
are absent on the loop's own events. The request is nested so a client can send
it beside an event-body field of the same name. The stored payload keeps the body
field, but the returned event is flat, so an envelope `operator` replaces a body
`operator` there. This affects only `slice.requeue.requested`, whose body
`operator` (from #605) predates attribution: its folded
`requeueRequested.operator` is therefore the envelope value whenever attribution
is present. Legate fills both from the same operator input. The reducer reads no
other attribution field. Legate uses attribution for every operator lever it
relays.

The operator levers add these event types:

| Event | Fold effect |
|-------|-------------|
| `slice.merge.requested {sliceId, prNumber, reason?}` | Sets the slice's `mergeRequested`. A `merged` stage change or a `merge` refusal clears it. |
| `slice.relaunch.requested {sliceId, reason?}` | Sets `relaunchRequested`. A `steward.relaunched` whose `requestSeq` is at or after the request's `seq`, or a `relaunch` refusal, clears it. An automatic relaunch (`steward.relaunched` without `requestSeq`) leaves it pending. |
| `slice.operator.refused {sliceId, action, reason, requestSeq?}` | `action` is `merge` or `relaunch`. With `requestSeq`, clears that lever's pending request only if its `seq` is at most `requestSeq`, so a newer request filed while the refused attempt ran stays pending. Without `requestSeq` (legacy events) it clears the pending request unconditionally. |
| `dispatch.paused {reason?}` / `dispatch.resumed {reason?}` | Sets or clears the profile's `dispatchPaused` (`seq`, `ts`, `reason`). |
| `legate.tick.requested {reason?}` | None (history only). |

## Dispatch action key

`POST /events` accepts optional `command` (non-empty string), `arguments` (array
of strings) and `artifactPath` (non-empty string) on Legate's `slice.dispatched`
and `slice.recovery.dispatched` transitions, and rejects them when mistyped. The
fold stores each field on the slice when present. An event without them leaves a
known key alone, and a rung-3 `slice.recovery.requested` drops it with the rest
of the slice. Legate restores the key on a cold start to match sibling plan rows
exactly (#653).

## Review request intents

`POST /events` accepts Legate's `review.requested` transition with a profile,
slice ID, positive PR number, reviewer (`coderabbit` or `copilot`), 40-hex
`headSha`, UTC `at`, and a reason (`initial`, `stale_approval`,
`stale_changes_requested`, or `timeout_retry`). Each append folds into the owning
profile's `reviewRequests` history returned by `GET /state`. Repeated attempts
remain separate records. Legate uses `GET /state?all=1` and the global event
stream to recover the UTC daily budget across profiles.

## Reviewer back-off

`POST /events` accepts Legate's `review.backoff` transition with a profile,
reviewer (`coderabbit` or `copilot`), UTC deadline `until`, nonnegative integer
`attempts`, and cause `http_429`, `rate_limited_comment`, `paused_comment`,
`post_failed`, or `reset`. Only a reset has zero attempts. Optional `signalAt`
(UTC) and `noticeId` preserve the observation time and notice identity for replay.
The profile identifies the observer. The cross-profile projection
(`GET /state?all=1`) keeps the latest event by stream sequence per reviewer
in `reviewBackoffs`, processed notice IDs in `reviewNoticeIds`, the latest
reset signal time per reviewer in `reviewResetBoundaries` (a reset's `signalAt`,
or the optional `resetObservedAt` that Legate adds when it repeats an active
throttle to record a fresh review that arrived too late to clear it), and the latest
intent per reviewer in `latestReviewRequests`. A later throttle record does not
clear the reset boundary. Legate ignores notices created at or before it. A log without back-off events
has no active reviewer back-off.

## Review state projection

`GET /state` adds `slices[<sliceId>].reviewState` for every slice with a
tracked PR, including the per-profile and `?all=1` views. The field is derived
from the slice verb and its owning profile's registered merge policy, the
observed PR, the profile's request history, and the account-wide reviewer
back-off. It is a read projection field and is never recorded in an event or
stored in a PR snapshot.

In precedence order, the values are `changes_requested`, `approved_by_bot`,
`rate_limited`, `in_progress`, `requested`, and `none`. A PR without a head
SHA reports `none`. A legacy snapshot without per-review verdicts reports
`changes_requested` from its blocker count or verified CodeRabbit blocker, and
never reports a bot approval. `MARCH_REVIEW_WAIT_MINUTES` sets the request and progress
window and defaults to 30 minutes. The latest projection uses the current
clock. A projection at `?at=<seq>` uses only the event history through that
sequence and evaluates deadlines at the resulting fold's timestamp, using
the currently registered policy.

`march herald state` keeps its summary line and adds a table with the slice,
PR number, and review state for each tracked PR in the default profile.
`--json` returns the projection with the `reviewState` field, and `--at`
selects a historical projection in either format.
