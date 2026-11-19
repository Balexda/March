# Herald contract

Herald observes each registered profile and appends changes to its event log.
The profile checkout's local GitHub `origin` identifies the repository before
Herald makes GitHub requests. Herald requests a repository-scoped Tessera
`app/read` entitlement for repository metadata, PR details, review data and the
open-PR cursor. Branch discovery matches same-repository heads regardless of who
opened the PR. An identically named fork branch is ineligible.

`MARCH_HERALD_SYNC=1` enables default-branch synchronization before observation.
Herald fetches and pulls over HTTPS with the same repository entitlement and
requires a fast-forward. With sync disabled, Herald reads the local checkout
and skips network Git operations.

Set `MARCH_TESSERA_URL` and `MARCH_TESSERA_CLIENT_KEY` in the Herald process
using Herald's own client key. Each GitHub CLI invocation receives an isolated,
initially empty configuration directory and a child-only credential. Git
network operations disable credential helpers, SSH and interactive prompts.
A confirmed GitHub 401 allows one request with a refreshed credential. The
shared client's explicit `MARCH_TESSERA_GH_TOKEN_FALLBACK=1` migration setting
permits the environment-token fallback. The Herald compose file forwards
`MARCH_HERALD_TESSERA_CLIENT_KEY` as Herald's client key and enables that
fallback by default, so a stack without a provisioned key keeps observing
through `GH_TOKEN` until the fallback is removed.

A typed Tessera failure records an errored span and ends that profile's tick
before any observation events are appended. Herald continues with the next
profile. This follows the [March vision](../../vision.md) and
[operating philosophy](../../operating-philosophy.md).
