# Brood Contract

Brood owns lifecycle state and cleanup for tracked March sessions. Its read
surfaces give operators and automation visibility without moving registry,
Docker, archive, worktree, branch, or Castra mutation into the CLI. This follows
the Brood role in `docs/vision.md` and `docs/operating-philosophy.md`: Brood is
the lifecycle authority, while the CLI is only the deliberate intervention
surface over that authority.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

### Health and readiness

`GET /healthz` takes no inputs and returns 200 with `{ status: "ok" }`.
`GET /readyz` takes no inputs and returns `{ ready, docker, git, castra }`, all
booleans. It returns 200 when Docker and Git are available on PATH and 503
otherwise. The best-effort Castra reachability probe does not gate readiness.

### Registry

`POST /sessions` accepts a JSON object with a required nonempty string `id`
(trimmed) and `kind` of `spawn`, `steward`, or `legate`. Optional `status` is
one of `created`, `running`, `stopped`, `failed`, `tearing-down`, or `torndown`.
Optional `repoPath` and `worktreePath` must be absolute path strings. Optional
`branch` must match `^[A-Za-z0-9][A-Za-z0-9._/-]*$` and contain no `..`.
Other optional fields are the strings `parentId`, `containerId`,
`agentDeckSessionId`, `profile`, `group`, `backend`, `imageId`, and
`failureReason`, a numeric `exitCode`, and the `extractionResult` object
described below. Unknown keys are ignored.

Registration does not check the ID's characters, but teardown does. The
checks apply to the teardown's primary record, not to the addressed row. That
is the owning spawn when the target is a spawn or a steward whose `parentId`
names a spawn, and the target row otherwise. A steward's own ID is therefore
never checked when it has a spawn parent. Teardown checks the primary ID twice.

1. Archive: every primary ID must be a single path component under the Brood
   archive directory. That rules out `/`, `.`, and `..`. Any other ID fails
   the `archive` step and defers every later step.
2. Compute: a primary with a container to tear down (every spawn, and other
   kinds with a tracked `containerId`) must also match
   `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`. Any other ID fails its `stop` or
   `container` step.

Either failure repeats on every attempt, and the session stays
`tearing-down`. Retrying does not fix this, so register primary IDs that
pass both checks.

Registration upserts by ID and returns 201 with a `SessionRecord`. New records
default to `created`. Re-registration preserves the original kind and creation
time. The record contains `id`, `kind`, `status`, and server-managed timestamp
strings `createdAt` and `updatedAt`. It includes optional registration fields
when present and may also include timestamp strings `startedAt`, `stoppedAt`,
and `torndownAt`, string `teardownReason`, and boolean `teardownRequiresForce`.
Invalid registration returns 400. Closed extraction or workspace reclaim
returns 409. Both use `{ error: string }`, with an additional `code` for
workspace reclaim.

`GET /sessions` takes no body. Optional query filters `kind`, `status`, and
`parentId` combine by exact match. Optional `reconcile` accepts `true` or
`false` and defaults to off. Empty values are treated as omitted. Invalid
enum or boolean values and repeated filters return 400. Unavailable requested
container observation returns 503. Both use `{ error: string }`. Success
returns 200 with `{ sessions: SessionRecord[], views: BroodReadView[] }`.
Each view contains its `record`, an `age` string, booleans `needsAttention`,
`disposed`, and `reconciled`, and `containerLive` as a boolean or null for
rows without a tracked container. Without observation, liveness for a tracked
container reflects whether its registry status is `running`.

`GET /sessions/:id` takes the session ID as its only input. It returns 200
with the `SessionRecord` or 404 with `{ error: string }` for an unknown ID.

`PATCH /sessions/:id` takes the session ID and an optional JSON object.
Only supplied allowlisted fields are applied. Those fields are `status`,
`containerId`, `imageId`, `exitCode`, `failureReason`, `agentDeckSessionId`,
`worktreePath`, `branch`, `profile`, `group`, `extractionResult`,
`startedAt`, `stoppedAt`, and `torndownAt`. Status, path, and branch follow
registration rules. `torndownAt` must be a nonempty string and is write-once.
The response is 200 with the updated record, 400 for validation failures,
404 for an unknown ID, or 409 for closed extraction or workspace reclaim.
Errors use the same envelope as registration.

### Extraction readiness

`GET /sessions/:id/extraction-readiness` takes a spawn ID and no body or query
inputs. It returns 404 with `{ error: string }` for unknown IDs and non-spawn
sessions. A known spawn returns 200 with `{ spawnId, status, prReady }`.
`status` is `missing`, `failed`, or `succeeded`. Only `succeeded` sets
`prReady` to true. Both completed states include `result` with the stored
`ExtractionResult`.

An `ExtractionResult` has string `spawnId` and `extractedAt`, `backend` of
`claude-code` or `codex`, a completed `status`, and optional string
`diagnostic`. Failure carries a string `failureReason`. Success carries a
`patch` object with `spawnId`, `backend`, string `patchText` (at most 1 MiB
in UTF-8), string array `touchedPaths`, and a string `sha256`.

The `sha256` value is supplied by the caller. Registration and update check
only that it is a string and do not compare it with `patchText`, so a stored
result does not prove the digest is correct. The check happens during the
teardown archive. A mismatch with the registry adds the warning
`registry extraction patch digest mismatch` and keeps any patch already
archived. A mismatch after the archive is written fails the archive step.

### List consumers

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

### Session teardown

`POST /sessions/:id/teardown` takes a session ID and an optional JSON object
with booleans `force` and `kill` and a nonempty string `reason`. Only literal
`true` enables either boolean. Empty or non-string reasons are ignored.
With `kill: true`, Brood skips graceful stop and requests forced compute
removal after the archive succeeds. Force admission still applies independently.
It returns 200 with `{ id, status, steps, warnings }`. The `id` is the primary
session ID and `status` is `torndown` or `tearing-down`. Each ordered step
has a `step` name (`stop`, `archive`, `container`, `steward`, `worktree`, or
`branch`), an `outcome` of `ok`, `skipped`, or `failed`, and optional string
`detail`. The `warnings` field is a string array. An already-complete group
returns `torndown` with empty steps and warnings. Errors use `{ error: string }`
with 404 for unknown IDs, 409 when force is required, and 500 for unexpected
teardown errors.

A steward ID resolves to its owning spawn for admission. Created and running
spawns require force. Brood records that requirement before archiving and
enforces it on retries while teardown is in progress. Older in-progress spawn
records with unknown admission state also require force. Accepted cleanup
reasons are stored on the primary record as `teardownReason`, alongside the
original `failureReason`. Omitting a reason on retry preserves the stored value.

`march brood teardown <id> [--force] [--kill] [--reason <text>] [--json]`
sends the request to Brood. The response contains the primary session ID,
status, ordered cleanup steps, and warnings. Ordinary forced teardown of
ephemeral compute checks for a graceful stop before capturing final evidence.
The host substrate gives the stop check up to 10 seconds, sends SIGTERM to the
verified container if it is running, and verifies it exited and remains
present. The spawn entrypoint's `sh` (the container's main process) forwards
SIGTERM to the agent's process group, so the signal reaches the agent, including a stop that arrives before the agent has started. A stopped agent keeps its own exit status, so an agent killed during the stop (137) is never reported as a graceful stop. With telemetry on, the wrapping `sh` becomes the main process and forwards SIGTERM to the entrypoint before emitting its span. The `stop` step reports `ok` for a verified graceful stop and
`skipped` for already stopped or absent compute. An unsupported, unverified,
or timed-out stop reports `failed`, defers the remaining steps, and leaves the
session retryable. Removal after a verified stop targets the same container ID
without forcing it.

At the slice's original source baseline (`9910481`), Brood accepted and
ignored `kill`. The lifecycle teardown implementation added the skip-stop
behavior described above.

The host substrate resolves ephemeral compute by session kind and ID and
verifies absence after removal. The recorded container ID supplies logs.
Compose service containers are excluded. Docker errors, deadline breaches,
and unverified removal produce a failed container step and leave teardown
retryable. Castra removes the steward with worktree pruning disabled. Brood
then removes the tracked worktree and branch separately, in that order. Failed container or steward removal
defers both Git steps, so compute that may still be running keeps its workspace. Failed Git steps leave teardown retryable. The CLI
prints the status, steps, and warnings in text mode or emits the service
result with `--json`. Only `torndown` exits zero. A `tearing-down` result
is rendered and exits non-zero even on HTTP 200.

Teardown gives call-outs and admission queueing a combined 25-second budget
under the default 30-second Brood client timeout. A request can spend that
budget waiting for a concurrent teardown. Once admitted, cleanup call-outs
reserve the final three seconds for journal finalization. Each Git step also
keeps a two-second reserve. Steps before Git cleanup end seven seconds before the
request deadline. Worktree removal ends five seconds before it, and branch
deletion ends at the finalization reserve. A stalled retry therefore always
leaves branch deletion a usable share of the budget. Each call-out uses the
smaller of its own limit and the remaining time in its window, including any
lookup, verification, and retries within it. The Castra steward deadline also
aborts in-flight Castra list and remove requests.

| Call-out | Maximum |
| --- | ---: |
| Archive journal read, snapshot and attempt start, evidence write, and attempt finish | 3s each |
| Docker log read | 4s |
| Graceful compute stop | 10s |
| Compute removal | 6s |
| Castra steward cleanup across the group | 8s |
| Exact worktree removal and exact branch deletion | 4s each |

A deadline reports the affected operation in the response and trace. A log
read timeout warns and cleanup can continue. An archive sink timeout before
removal blocks cleanup. A finalization timeout warns and leaves the group
`tearing-down`. If archive I/O or a cleanup operation is still settling
after a timeout, Brood defers a retry for the same archive until it settles.
Cleanup then resumes with fresh verification.

Brood holds a workspace reclaim lease from each Git step's steward membership
check until its Git mutation settles. While the lease is held, steward
registration into that group and `PATCH` of any row in it return 409 with
`{ "error": string, "code": "workspace_reclaiming" }`. `BroodClient` raises
`BroodWorkspaceReclaimingError` for that refusal. Hatchery treats it as a launch
failure: it removes the steward it just launched and does not continue the
dispatch. Other `PATCH` callers do not retry. For example, the legate's
relaunch retire path (`broodRetire`) records the refusal and continues. The
in-flight teardown is already retiring that group's rows. This follows March's clean-exit
rule for autonomous components.
[March vision](../../vision.md) · [Operating philosophy](../../operating-philosophy.md#3-failures-are-clean-exits-not-hangs)

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
snapshot, then a `finished` entry with the attempt's status, steps, and warnings.
The response stays retryable if a registration changes during the final write.
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
all removal. After a graceful stop, this leaves the stopped container present
so a retry can capture its evidence. A journal finalization failure leaves
the row `tearing-down` and returns the completed step outcomes with a warning.
If Brood stops after acknowledging a `torndown` journal write in the registry,
the next teardown request completes the registry transition without repeating
removal, even after a status-only PATCH. A retry verifies cleanup again when
the write lacks that acknowledgment. Brood
restores the unmatched start if a submitted rename finishes after the deadline
and holds the archive fence until the filesystem work settles. Recovery applies
only while the row keeps the container,
repository, worktree, and branch the attempt reclaimed; a re-registered identity
gets a full teardown instead. Requests by spawn ID or steward ID apply the
same group completion rule. When the spawn and all its stewards are already
`torndown`, Brood returns `torndown` with no cleanup steps or archive writes.
Teardown removes and verifies every live steward under the spawn before it
reclaims the shared worktree and branch; if
any steward removal fails, or a steward registers under the spawn (or a removed
steward's registration changes) while earlier steps are in progress, Git cleanup
is deferred and the row stays retryable. Ordinary completion and recovery apply
the same rule: a steward counts as removed only while its registration still
matches what was removed. This includes a standalone steward that is its own
primary: if its registration changes after removal, the result is
`tearing-down` and a retry removes the new session (recovery likewise falls
through to a full teardown). The
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

### Admin sweep

`POST /admin/sweep` takes no body or query inputs. If `MARCH_BROOD_ADMIN_TOKEN`
is unset or blank, it returns 404. Otherwise it requires
`Authorization: Bearer <token>` and returns 401 for missing or invalid
credentials. Both rejections use `{ error: string }`.

On 200 the sweep returns `{ scannedProfiles, reaped, adopted, skipped, failures }`.
`scannedProfiles` lists profile names. The remaining arrays contain entries
with string `profile` and `sessionId`. Reaped entries add `worktreePath`,
`branch`, and `reason`. Skipped entries add `reason`. Failures add `detail`
and use `sessionId: "*"` for a failed profile listing. This route leaves
`adopted` empty. It only reaps stewards that have no live Brood owner and whose
worktree is gone or whose PR is confirmed merged or closed. Castra removes them
with worktree pruning disabled. Castra list and removal failures are reported
in `failures` within HTTP 200.

The orphan PR lookup used by `POST /admin/sweep` and periodic reconciliation
requests a Tessera app/read token scoped to the repository at the profile's
GitHub origin. Brood retries a GitHub 401 once using a refreshed entitlement.
The Brood compose file sets `MARCH_TESSERA_URL` and points
`MARCH_TESSERA_CLIENT_KEY_FILE` at `~/.march/tessera/keys/brood.key`
(`march tessera provision`). It forwards no ambient GitHub token, and the
token fallback is off.

### `GET /sessions/:id/logs`

`GET /sessions/:id/logs` takes the session ID as its only input and returns
the selected log as UTF-8 text or a JSON `{ error: string }` envelope.

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
| An unexpected error occurs | `500 { "error": "<message>" }` |

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

## Invariants

After admission and any required graceful stop, Brood runs cleanup in this
order.

1. Archive the session evidence before removing resources.
2. Remove the targeted ephemeral container and verify absence.
3. Remove or verify absence of the group's stewards through Castra with
   `pruneWorktree: false`. [Castra removal contract](../castra/contract.md#delete-v1sessionsid)
4. Remove only the exact tracked worktree path in the tracked repository.
5. Delete only the exact tracked branch in that repository.

Brood never runs blanket `git worktree prune`. Each Git step requires the
tracked repository and its corresponding tracked path or branch. A failed
steward removal defers both Git steps and leaves teardown retryable.

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

Registration, listing, and update return 400 with `{ error: string }` for
validation failures. Lookup and update return 404 for unknown session IDs.
Requested liveness observation can return 503. `listViews()` surfaces HTTP
errors, transport failures, and responses missing the views array.

Teardown returns HTTP 404 for an unknown ID and HTTP 409 when force is required.
Rejection precedes registry updates and cleanup. Rejections end an errored `brood.teardown`
span under the inbound trace context when supplied. The CLI exits non-zero
on these errors and when Brood is unreachable.

Expected teardown-step failures return 200 with a `tearing-down` result and
failed steps or warnings. A steward-removal failure reports `steward` as
`failed` and `worktree` and `branch` as `skipped` with a deferral detail.
A later teardown request can retry. Completion is signaled by `torndown`
in the response body.

If Brood cannot resolve the repository or obtain a credential, it skips the
candidate's PR-based removal and continues the sweep. Lookup errors are
recorded on `brood.orphan.pr_lookup`, linked to the dispatch trace when Castra
provides a slice ID.

| Condition | Route | Response | Observable behavior |
|-----------|-------|----------|---------------------|
| Unknown session id | `GET /sessions/:id/logs` | `404` with `{ "error": string }` | No tracked row exists for the id. |
| No live source and no readable archive | `GET /sessions/:id/logs` | `409` with `{ "error": string }` | The session is tracked, but logs cannot be selected. |
| Docker or Castra read fails and no readable archive exists | `GET /sessions/:id/logs` | `502` with `{ "error": string }` | The service reports the upstream read failure. Both live reads are time-bounded. |
