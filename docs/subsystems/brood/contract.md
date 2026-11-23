# Brood Contract

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

`GET /sessions` returns matching registry records in `sessions` and their
derived read views in `views`. It accepts `kind`, `status`, `parentId`, and
`reconcile`. Reconciliation defaults to off.

`BroodClient.listViews({ kind?, status?, reconcile? })` returns the service's
`BroodReadView[]`. The existing `BroodClient.list()` returns the
`SessionRecord[]` from the same route. The
[Brood CLI read contract](../../../specs/2026-08-14-012-brood-cli-read-surface/brood-cli-read-surface.contracts.md)
describes the response and operator output.

`POST /sessions/:id/teardown` accepts optional `force`, `kill`, and `reason`.
A steward ID resolves to its owning spawn for admission. Created and running
spawns require force. Brood records that requirement before archiving and
enforces it on retries while teardown is in progress. Older in-progress spawn
records with unknown admission state also require force. Accepted cleanup
reasons are stored on the primary record as `teardownReason`, alongside the
original `failureReason`. Omitting a reason on retry preserves the stored value.

`march brood teardown <id> [--force] [--kill] [--reason <text>] [--json]`
sends the request to Brood. The response contains the primary session ID,
status, ordered archive, container, steward, worktree, and branch steps, and
warnings. The current container step attempts immediate removal. The CLI
prints the status, steps, and warnings in text mode or emits the service
result with `--json`. Only `torndown` exits zero. A `tearing-down` result
is rendered and exits non-zero even on HTTP 200.

The orphan PR lookup used by `POST /admin/sweep` and periodic reconciliation
requests a Tessera app/read token scoped to the repository at the profile's
GitHub origin. Brood retries a GitHub 401 once using a refreshed entitlement.
The Brood compose file sets `MARCH_TESSERA_URL` and points
`MARCH_TESSERA_CLIENT_KEY_FILE` at `~/.march/tessera/keys/brood.key`
(`march tessera provision`). It forwards no ambient GitHub token, and the
token fallback is off.

## Invariants

List reads leave registry and container state unchanged. Brood owns filter
validation, read-view derivation, and any requested liveness observation.

## Error Modes

The service returns HTTP 400 for invalid filter values and HTTP 503 when
requested liveness observation is unavailable. `listViews()` surfaces
HTTP errors, transport failures, and responses missing the views array.

Teardown returns HTTP 404 for an unknown ID, HTTP 409 when force is required,
and HTTP 400 for explicit kill mode, even with force. Rejection precedes
registry updates and cleanup. Rejections end an errored `brood.teardown`
span under the inbound trace context when supplied. The CLI exits non-zero
on these errors and when Brood is unreachable.

If Brood cannot resolve the repository or obtain a credential, it skips the
candidate's PR-based removal and continues the sweep. Lookup errors are
recorded on `brood.orphan.pr_lookup`, linked to the dispatch trace when Castra
provides a slice ID.
