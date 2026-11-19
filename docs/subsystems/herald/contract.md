# Herald Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

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
review page walk. Herald refreshes older snapshots that lack review verdicts or
draft status on the next observation.

A Legate `slice.stage.changed` event may include `handledFeedback` with a
`kind` of `inline` or `conversation` and an array of string `commentIds`.
An optional string `dispatchKey` names the fix dispatch that handled them, and
an optional string `headSha` records the PR head it was sent against. The fold
accumulates the IDs per slice and kind, and keeps the latest dispatch (kind,
key, event time and head SHA), for Legate to restore on restart.

Herald synchronizes every active profile's default branch before each
observation (#601; there is no switch, and removing the profile is how to stop
it). Herald fetches and pulls over HTTPS with the same repository entitlement
and requires a fast-forward.

Herald reads these settings:

| Variable | Meaning |
|----------|---------|
| `MARCH_TESSERA_URL` | Tessera base URL. |
| `MARCH_TESSERA_CLIENT_KEY` | Herald's own Tessera client key. The compose file forwards it from `MARCH_HERALD_TESSERA_CLIENT_KEY`. |
| `MARCH_TESSERA_GH_TOKEN_FALLBACK` | The shared client's explicit migration fallback. When set to `1` and issuance fails, `GH_TOKEN` or `GITHUB_TOKEN` serves the same scoped call. The compose file defaults it to `1` until the fallback is removed. |

### Profile merge policy

`POST /profiles` validates the optional `mergePolicy` before replacing the saved
policy. `GET /profiles/:profile` returns the normalized policy. The existing
`defaults` and `byTaskType` requirement objects accept `botApprovers`, a list of
1–10 logins stored in lowercase with the `[bot]` suffix removed. Herald rejects
the login configured by `MARCH_SELF_BOT_LOGIN`, which defaults to `march-bot`.
An invalid write leaves the saved policy intact. An invalid stored policy
falls back to Legate's built-in table.

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
