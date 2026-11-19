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

## Invariants

List reads leave registry and container state unchanged. Brood owns filter
validation, read-view derivation, and any requested liveness observation.

## Error Modes

The service returns HTTP 400 for invalid filter values and HTTP 503 when
requested liveness observation is unavailable. `listViews()` surfaces
HTTP errors, transport failures, and responses missing the views array.
