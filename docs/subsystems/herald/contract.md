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
whose latest reply is from March has no response due.

A Legate `slice.stage.changed` event may include `handledFeedback` with a
`kind` of `inline` or `conversation` and an array of string `commentIds`.
An optional string `dispatchKey` names the fix dispatch that handled them.
The fold accumulates the IDs per slice and kind, and keeps the latest dispatch
(kind, key and event time), for Legate to restore on restart.

`MARCH_HERALD_SYNC=1` enables default-branch synchronization before observation.
Herald fetches and pulls over HTTPS with the same repository entitlement and
requires a fast-forward. With sync disabled, Herald reads the local checkout
and skips network Git operations.

Herald reads these settings:

| Variable | Meaning |
|----------|---------|
| `MARCH_TESSERA_URL` | Tessera base URL. |
| `MARCH_TESSERA_CLIENT_KEY` | Herald's own Tessera client key. The compose file forwards it from `MARCH_HERALD_TESSERA_CLIENT_KEY`. |
| `MARCH_TESSERA_GH_TOKEN_FALLBACK` | The shared client's explicit migration fallback. When set to `1` and issuance fails, `GH_TOKEN` or `GITHUB_TOKEN` serves the same scoped call. The compose file defaults it to `1` until the fallback is removed. |

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
