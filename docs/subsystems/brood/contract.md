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

The orphan PR lookup used by `POST /admin/sweep` and periodic reconciliation
requests a Tessera app/read token scoped to the repository at the profile's
GitHub origin. Brood retries a GitHub 401 once using a refreshed entitlement.
The shared client's ambient-token fallback requires
`MARCH_TESSERA_GH_TOKEN_FALLBACK=1`.

## Invariants

List reads leave registry and container state unchanged. Brood owns filter
validation, read-view derivation, and any requested liveness observation.

## Error Modes

The service returns HTTP 400 for invalid filter values and HTTP 503 when
requested liveness observation is unavailable. `listViews()` surfaces
HTTP errors, transport failures, and responses missing the views array.

If Brood cannot resolve the repository or obtain a credential, it skips the
candidate's PR-based removal and continues the sweep. Lookup errors are
recorded on `brood.orphan.pr_lookup`, linked to the dispatch trace when Castra
provides a slice ID.
