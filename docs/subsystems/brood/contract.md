# Brood Contract

## Purpose

Brood owns lifecycle state and cleanup for tracked March sessions. Its read
surfaces give operators and automation visibility without moving registry,
Docker, archive, worktree, branch, or Castra mutation into the CLI. This follows
the Brood role in `docs/vision.md` and `docs/operating-philosophy.md`: Brood is
the lifecycle authority, while the CLI is only the deliberate intervention
surface over that authority.

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

`march brood sessions` takes no positional arguments. It combines Castra's
live `march/` inventory with `GET /sessions?kind=spawn` read views across all
tracked statuses. It prints the unprefixed interactive names and the tracked
spawn IDs in labeled sections. A name matching any tracked spawn ID is labeled
unavailable with the collision reason. A healthy empty Castra inventory prints
an explicit empty result.

Both reads have deadlines. A failed read causes a nonzero exit and a diagnostic
on stderr for each unavailable source. Available sections are labeled partial,
and interactive names are advertised as attachable only when Brood has
confirmed that they do not collide.

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
warnings. After the archive succeeds, the host substrate immediately removes
only the ephemeral container resolved from the session kind and ID, then
verifies absence. The recorded container ID supplies logs. Compose service
containers are excluded. Docker errors, deadline breaches, and unverified
removal produce a failed container step and leave teardown retryable. Castra
removes the steward with worktree pruning disabled. Brood then removes the
tracked worktree and branch separately, in that order. Failed steward removal
defers both Git steps. Failed Git steps leave teardown retryable. The CLI
prints the status, steps, and warnings in text mode or emits the service
result with `--json`. Only `torndown` exits zero. A `tearing-down` result
is rendered and exits non-zero even on HTTP 200.

The `brood.teardown` span follows the inbound W3C trace parent when supplied.
Cleanup steps appear as ordered events and child spans with their outcome and
diagnostic detail when available. Step details are capped at 500 characters.
A failed or deferred step marks the teardown span errored. Brood writes a
structured request warning for incomplete cleanup, including on HTTP 200, and
for any nonterminal result even when every cleanup step succeeded (for example,
a journal finalization failure). The warning includes the primary session ID as
`session_id`, the `teardown_status`, the failed and deferred `teardown_steps`,
and, for a nonterminal result, the capped `teardown_warnings`.

The Brood dashboard counts teardown results with `march.brood.teardowns`
and tracks seconds with `march.brood.teardown.duration`. Both instruments
use only the `kind`, `outcome`, and `profile` dimensions. Outcomes are
`success` for a torn-down session, `partial` for a retryable container or
Git cleanup failure, and `error` when archiving or verifying steward
removal failed. HTTP rejections are tracked by the HTTP request instruments.

Brood archives teardown evidence under `~/.march/brood/archive/<primary-id>/`.
Requests for a spawn and its steward share one archive and run serially within
the Brood service. Brood saves the original registry group when it records
admission, so an archive failure can be retried after restart. It publishes
`record.json` once and preserves existing snapshots byte for byte, including
legacy snapshots. Rejected and already-complete requests leave the archive
untouched.

Each attempt adds a numbered `started` entry to `teardown.ndjson` after the
snapshot, then a `finished` entry with the response's status, steps, and warnings.
Brood publishes the journal atomically with its prior entries intact. A start
without a finish identifies an interrupted attempt. Available container logs go
to `container.log`. Validated registry extraction results go to
`artifacts/extraction-result.json`. Successful patches go to
`artifacts/spawn.patch` with SHA-256 verification before writing and after reading
back the saved bytes. The archive excludes worktree files.

Unavailable sources produce warnings and preserve previously archived evidence.
A source digest mismatch also preserves any earlier verified patch and its
matching extraction result. A read-back mismatch fails the archive step.
An archive write failure before removal yields a failed archive step and blocks
all removal. A journal finalization failure leaves the row `tearing-down` and
returns the completed step outcomes with a warning. If Brood stops after
journaling `torndown` and before updating the registry, the next teardown request
completes the registry transition without repeating removal, even after a
status-only PATCH. Recovery applies only while the row keeps the container,
repository, worktree, and branch the attempt reclaimed; a re-registered identity
gets a full teardown instead. A spawn teardown removes and verifies every live
steward under the spawn before it reclaims the shared worktree and branch; if
any steward removal fails, or a steward registers under the spawn while earlier
steps are in progress, Git cleanup is deferred and the row stays retryable. The
journal's `finished` entry lists only the stewards whose removal that attempt
verified.
The journal records each verified steward's registration identity (row, parent,
and Castra session and profile). Recovery marks only stewards whose current
registration still matches that identity; a steward re-registered under the
same spawn stays live and the result is `tearing-down` with a warning naming it
until a retry removes it, and a steward that moved to another spawn keeps its
status under its new owner. Completion only marks stewards that still belong to
the primary and keeps any existing `torndownAt`. Once a teardown is admitted
(for the primary or any steward it admitted), or the row carries `torndownAt`,
`PATCH /sessions/:id` and re-registration reject an `extractionResult` with 409,
even if a later lifecycle PATCH changes `status`, so the archived result is
final. `torndownAt` is write-once: a PATCH may set it but a `null` or empty
value is rejected with 400 and an existing timestamp is kept. Archive failures
end errored spans, following the [March vision](../../vision.md) and
[operating philosophy](../../operating-philosophy.md).

The orphan PR lookup used by `POST /admin/sweep` and periodic reconciliation
requests a Tessera app/read token scoped to the repository at the profile's
GitHub origin. Brood retries a GitHub 401 once using a refreshed entitlement.
The Brood compose file sets `MARCH_TESSERA_URL` and points
`MARCH_TESSERA_CLIENT_KEY_FILE` at `~/.march/tessera/keys/brood.key`
(`march tessera provision`). It forwards no ambient GitHub token, and the
token fallback is off.

### `GET /sessions/:id/logs`

`GET /sessions/:id/logs` returns logs for one tracked `SessionRecord`.

`march brood logs <id>` calls this endpoint through `BroodClient.logs(id)`
and writes the returned text verbatim to stdout. Service and connection
errors go to stderr and exit non-zero. Brood selects and reads the log source.

| Condition | Response |
|-----------|----------|
| Live container logs are readable for a container-backed `spawn` or `legate` row | `200 text/plain` with `X-March-Log-Source: live-container` |
| Castra output is readable for a live `steward` row with a tracked agent-deck session id and profile | `200 text/plain` with `X-March-Log-Source: castra-session` |
| The live source is missing or unreadable and the archived `container.log` is readable | `200 text/plain` with `X-March-Log-Source: archive` |
| The id is not tracked | `404 { "error": "No session with id \"<id>\"." }` |
| No live source and no archived `container.log` exist | `409 { "error": "<message>" }` |
| No live source was available and the archived `container.log` is unreadable | `409 { "error": "<message>" }` |
| The Docker or Castra read fails and no readable archive exists | `502 { "error": "<message>" }` |

The live read runs `docker logs` asynchronously, so it never blocks other
Brood requests. It returns the container's stdout and stderr in the order they
arrived. A read that exits non-zero, runs past 15 seconds, or exceeds 16 MiB
counts as a live-source failure.

For stewards, Brood reads output from Castra using the tracked profile and
agent-deck session id. On an archive fallback, Brood checks the steward's
archive and then the parent spawn's archive.

The endpoint only reads registry rows, Docker logs, Castra session output,
and archived `container.log` files.

The archived log for a session is read from
`<home>/.march/brood/archive/<id>/container.log`. Teardown archives a
spawn<->steward group under the *spawn* id, so a steward row's archive is
resolved under its `parentId` when its own id has no archive.

Steward live-session output is intentionally not part of this slice. A steward
row can still use its group's archived `container.log` when present; live Castra
session output is owned by the follow-up steward log-routing contract.

## Invariants

List reads leave registry and container state unchanged. Brood owns filter
validation, read-view derivation, and any requested liveness observation.

- Log reads are read-only. They do not register, update, delete, tear down,
  prune, remove, create, or repair registry rows, Docker resources, archives,
  worktrees, or branches.
- Container-backed `spawn` and `legate` records prefer the tracked live
  container log source when it can be read.
- Archive fallback reads only the tracked session's (or its parent spawn's)
  archived `container.log`, and only from a path that resolves beneath
  `<home>/.march/brood/archive`. A session id that would escape that root is
  treated as having no archive source and is never probed on disk.
- A failed live-container read owns the outcome: an archived log that exists but
  cannot be read is treated as an archive miss, so the response stays the `502`
  upstream failure and carries both failure details.
- Unknown ids are distinct from known sessions whose logs are unavailable.

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

| Condition | Route | Response | Observable behavior |
|-----------|-------|----------|---------------------|
| Unknown session id | `GET /sessions/:id/logs` | `404` with `{ "error": string }` | No tracked row exists for the id. |
| No live source and no readable archive | `GET /sessions/:id/logs` | `409` with `{ "error": string }` | The session is tracked, but logs cannot be selected. |
| Docker or Castra read fails and no readable archive exists | `GET /sessions/:id/logs` | `502` with `{ "error": string }` | The service reports the upstream read failure. Both live reads are time-bounded. |
