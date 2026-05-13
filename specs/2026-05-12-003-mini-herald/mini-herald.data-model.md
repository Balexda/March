# Data Model: Mini-Herald

## Overview

Mini-herald introduces four file-based entities on disk. Three are owned by the herald daemon (Snapshot, Event, Herald Conductor Meta); one is owned by the consuming `legate.herald` skill (Cursor). All entities are plain JSON or NDJSON on the local filesystem — there is no database, no IPC service, and no shared memory. The append-only event log is the single source of truth; snapshots are diff inputs and a convenience cache for cold-start fallback; the cursor is consumer-private bookkeeping; the conductor meta is one-shot config written at `march herald init`.

## Entities

### 1) Snapshot (`pr-<N>.json`)

Purpose: the last observed state for a single PR. Diff inputs come from comparing the prior snapshot against the freshly captured one. After diffing, the fresh snapshot overwrites the prior one (atomic temp + rename). Snapshots also serve as the cold-start state for events-first babysit when a PR has no event-derived history yet.

Location: `~/.agent-deck/conductor/herald-<slug>/snapshots/pr-<N>.json` (one file per tracked PR).

| Field                    | Type      | Required | Notes                                                                                                                      |
|--------------------------|-----------|----------|----------------------------------------------------------------------------------------------------------------------------|
| `number`                 | integer   | Yes      | PR number. Mirrors `babysit-pr.sh` output.                                                                                 |
| `url`                    | string    | Yes      | PR HTML URL.                                                                                                               |
| `state`                  | string    | Yes      | `OPEN`, `MERGED`, or `CLOSED`.                                                                                             |
| `mergeable`              | string    | Yes      | `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`.                                                                                  |
| `head_branch`            | string    | Yes      | PR head branch name (from `headRefName`).                                                                                  |
| `head_oid`               | string    | Yes      | PR head commit SHA (from `headRefOid`). Extension beyond `babysit-pr.sh` so the diff can emit `pr.head_pushed`.            |
| `title`                  | string    | Yes      | PR title.                                                                                                                  |
| `review_decision`        | string    | No       | `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null.                                                               |
| `checks`                 | string    | Yes      | Rollup: `PASS`, `FAIL`, `PENDING`, or `NONE`.                                                                              |
| `failed_checks`          | array     | Yes      | List of `{name, url}` for FAILED checks. May be empty.                                                                     |
| `unresolved_threads`     | array     | Yes      | List of `{id, path, line, author, body_preview, last_author, last_comment_at, comment_count, needs_response}`.             |
| `thread_count`           | integer   | Yes      | `unresolved_threads.length`.                                                                                               |
| `needs_response_count`   | integer   | Yes      | Subset where `last_author != pr_author`. Reused for the babysit single-user override.                                       |
| `captured_at`            | string    | Yes      | ISO-8601 UTC timestamp of when the snapshot was written. Used by FR-017's stale-snapshot freshness check.                  |
| `schema_version`         | integer   | Yes      | Currently `1`. Bumps on any breaking shape change.                                                                         |

Validation rules:
- Every field marked Required must be present on every write.
- `mergeable == "UNKNOWN"` is a valid transient state. The diff function suppresses `pr.conflict` / `pr.conflict_cleared` until `mergeable` resolves to a concrete value.
- `unresolved_threads[].id` is a stable integer (GraphQL `databaseId`). It is used as the `ref` field on `pr.thread_*` events.
- `captured_at` is strictly monotonic per PR across successive snapshots (no backwards-in-time writes).

### 2) Event (one line in `events.ndjson`)

Purpose: the append-only record of every state transition the diff engine detected. This is the source of truth in mini-herald — consumers (the `legate.herald` skill, and any future replay tool) rebuild PR-state intent from this log.

Location: `~/.agent-deck/conductor/herald-<slug>/events.ndjson` (single file per herald conductor, one JSON object per line).

| Field             | Type      | Required | Notes                                                                                                                       |
|-------------------|-----------|----------|-----------------------------------------------------------------------------------------------------------------------------|
| `schema_version`  | integer   | Yes      | Currently `1`. Matches the snapshot schema_version. Bumps together.                                                         |
| `seq`             | integer   | Yes      | Monotonically increasing within the file, starting at 1 for the first appended event. Resets on log rotation (see SD-001). |
| `kind`            | string    | Yes      | One of the 14 PR-event kinds (see "Event kind taxonomy" below).                                                             |
| `pr_number`       | integer   | Yes      | PR this event pertains to.                                                                                                  |
| `slice_id`        | string    | Yes      | The legate slice id (or `issue-<N>`) the PR belongs to. Denormalized at write time so consumers do not need to re-join.    |
| `ts`              | string    | Yes      | ISO-8601 UTC timestamp of when the event was emitted (same instant as the diff that produced it).                            |
| `prev`            | any       | Yes      | Prior value of the changed field on the snapshot. Type varies by `kind` (see taxonomy). `null` allowed only for `pr.opened`.|
| `next`            | any       | Yes      | New value of the changed field on the snapshot. Type varies by `kind`.                                                      |
| `ref`             | string    | No       | Discriminator for thread events (thread id) and `pr.head_pushed` (head SHA). Omitted on kinds where no ref applies.         |

Validation rules:
- `seq` is strictly increasing line by line. A reader that observes a gap or a non-increasing value MUST treat the file as corrupt and surface an error rather than silently skipping.
- One event per appended line, no trailing comma, no pretty-printing. The line is a single complete JSON object terminated by `\n`.
- Line writes are atomic under POSIX append semantics for writes ≤ `PIPE_BUF` bytes. The daemon MUST write each event as a single `write(2)` call to ensure this.
- `prev == null` is valid for `kind == "pr.opened"` (first observation of the PR), for `kind == "pr.thread_opened"` (per the taxonomy table, a newly-appearing thread has no prior state), and for `kind == "pr.review_changes_requested"` / `pr.review_approved` when the prior `review_decision` was unset (null). All other kinds require both `prev` and `next` because they represent a transition between two known concrete states.

#### Event kind taxonomy

| Kind                          | Trigger (diff over snapshot pair)                       | `prev` / `next` shape                       | `ref` semantics              | High-priority |
|-------------------------------|---------------------------------------------------------|---------------------------------------------|------------------------------|---------------|
| `pr.opened`                   | First snapshot for a PR (prior snapshot is null)        | `prev = null`, `next = "OPEN"`              | omitted                      | no            |
| `pr.merged`                   | `state` transitions `OPEN → MERGED`                     | `prev = "OPEN"`, `next = "MERGED"`          | omitted                      | **yes**       |
| `pr.closed`                   | `state` transitions `OPEN → CLOSED` (non-merge)         | `prev = "OPEN"`, `next = "CLOSED"`          | omitted                      | no            |
| `pr.conflict`                 | `mergeable` transitions to `CONFLICTING`                | strings                                     | omitted                      | **yes**       |
| `pr.conflict_cleared`         | `mergeable` transitions from `CONFLICTING` to `MERGEABLE` | strings                                   | omitted                      | no            |
| `pr.ci_failed`                | `checks` rollup transitions to `FAIL`                   | strings                                     | omitted                      | **yes**       |
| `pr.ci_passed`                | `checks` rollup transitions to `PASS`                   | strings                                     | omitted                      | no            |
| `pr.ci_pending`               | `checks` rollup transitions to `PENDING`                | strings                                     | omitted                      | no            |
| `pr.review_changes_requested` | `review_decision` transitions to `CHANGES_REQUESTED`    | strings (or null on initial transition)     | omitted                      | **yes**       |
| `pr.review_approved`          | `review_decision` transitions to `APPROVED`             | strings                                     | omitted                      | no            |
| `pr.thread_opened`            | A thread id appears in `unresolved_threads` not present before | `prev = null`, `next = thread object` | `ref = thread_id`            | no            |
| `pr.thread_new_reply`         | `last_comment_at` advances on an existing unresolved thread | ISO-8601 strings                        | `ref = thread_id`            | **yes**       |
| `pr.thread_resolved`          | A previously unresolved thread id is no longer in `unresolved_threads` | `prev = thread object`, `next = null` | `ref = thread_id`     | no            |
| `pr.head_pushed`              | `head_oid` changes                                      | SHA strings                                 | `ref = next head SHA`        | no            |

High-priority kinds (the doorbell set) are: `pr.merged`, `pr.ci_failed`, `pr.thread_new_reply`, `pr.conflict`, `pr.review_changes_requested`.

### 3) Cursor (`herald-cursor.json`)

Purpose: the consumer's bookmark into `events.ndjson`. Lets the `legate.herald` skill resume reading from the right line across heartbeats and conductor restarts without re-processing the entire log.

Location: `~/.agent-deck/conductor/<legate-name>/herald-cursor.json` (lives inside the *legate* conductor's cwd, not the herald conductor's — so the herald daemon never reads it). One cursor per (legate, herald) pair.

| Field             | Type      | Required | Notes                                                                                                                                                                                 |
|-------------------|-----------|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `schema_version`  | integer   | Yes      | Matches the event log schema_version this cursor was last read against.                                                                                                               |
| `last_seq`        | integer   | Yes      | The `seq` of the last event the consumer successfully processed. The next read returns events with `seq > last_seq`. Initial value before any read is `0`.                            |
| `last_offset`     | integer   | No       | Optional byte offset into `events.ndjson` corresponding to `last_seq`. A read optimization (skip seek-by-line) — the seq comparison remains authoritative when offset and seq disagree. |
| `updated_at`      | string    | Yes      | ISO-8601 UTC timestamp of the last successful read.                                                                                                                                   |

Validation rules:
- Cursor write is atomic (temp + rename) so a crash mid-write does not corrupt the file.
- If the cursor file is absent or corrupt, the consumer treats `last_seq` as `0` and reads from the beginning. Exact replay semantics (read all vs read from tail vs persist `last_seq` elsewhere as backup) are open — see SD-004.
- The consumer MUST advance the cursor only after it has successfully processed the read batch. A read script that returns events but fails to update the cursor before its caller crashes will deliver duplicates on the next read; this is preferable to silently losing events.

### 4) Herald Conductor Meta (`meta.json`)

Purpose: configuration written by `march herald init` and read by the daemon loop. Distinct from agent-deck's own conductor meta (which agent-deck owns); this is herald-specific config that lives inside the herald conductor's cwd.

Location: `~/.agent-deck/conductor/herald-<slug>/meta.json`.

| Field                    | Type      | Required | Notes                                                                                                                       |
|--------------------------|-----------|----------|-----------------------------------------------------------------------------------------------------------------------------|
| `schema_version`         | integer   | Yes      | Currently `1`. Independent of event/snapshot schema_version (those move together; meta moves separately).                   |
| `paired_legate`          | string    | Yes      | Name of the sibling legate conductor (e.g., `legate-march`). Doorbells fire to this target.                                |
| `profile`                | string    | Yes      | Agent-deck profile this herald conductor lives in.                                                                          |
| `repo_path`              | string    | Yes      | Absolute path to the target repo.                                                                                           |
| `repo_owner_with_name`   | string    | Yes      | GitHub `owner/repo` for the `gh api graphql` calls.                                                                         |
| `poll_interval_seconds`  | integer   | Yes      | Daemon loop tick interval. Default `60`, set via `--poll-interval` at init.                                                |
| `legate_state_path`      | string    | Yes      | Absolute path to the sibling legate's `state.json` (read-only input). Resolved at init time.                               |

Validation rules:
- `paired_legate` MUST refer to a conductor that exists in `profile` at `march herald init` time. Subsequent disappearance is non-fatal at runtime (doorbells silently no-op).
- `poll_interval_seconds` MUST be a positive integer. The init flag accepts values in the range `[10, 3600]`; values outside this range are rejected.
- `repo_path` MUST be a git repository checkout. If the path becomes invalid at runtime, the daemon logs and skips the tick.

## Relationships

- **Herald Conductor 1:N Snapshot**: One herald conductor maintains many snapshot files, one per tracked PR. The PR set is derived from the paired legate's `state.json`, not stored separately by herald.
- **Herald Conductor 1:1 Event Log**: One herald conductor writes to exactly one `events.ndjson`. (Rotation, when added, produces additional files but only one is the active log.)
- **Legate Conductor 1:1 Cursor**: One legate conductor maintains exactly one cursor file pointing into its paired herald's event log.
- **Herald Conductor 1:1 Legate Conductor**: One herald is paired to exactly one legate via `meta.json.paired_legate`. The reverse — one legate's cursor points into one herald's log — completes the bidirectional binding.
- **Snapshot N:M Event** (loose): An event references exactly one snapshot transition (the diff that produced it). A snapshot is referenced by the zero, one, or many events emitted during the tick that produced it. There is no enforced foreign key — the join is implicit via `(pr_number, ts)`.

## State Transitions

### Snapshot lifecycle

1. **absent → captured** (first observation of a PR)
   - Trigger: daemon poll finds the PR in legate's `state.json.slices` and no snapshot file exists.
   - Effects: snapshot written atomically; `pr.opened` event appended.

2. **captured → captured** (state change, snapshot replaced)
   - Trigger: daemon poll observes any field difference between the live PR and the prior snapshot.
   - Effects: new snapshot written atomically (overwrites prior); one or more events appended; doorbell fired if any high-priority kind was emitted in the tick.

3. **captured → captured** (no state change, snapshot refreshed)
   - Trigger: daemon poll observes no field differences vs the prior snapshot.
   - Effects: `captured_at` field on the snapshot is updated (atomic rewrite); zero events appended; no doorbell. This refresh signals to consumers that the snapshot is live, not stale, even when no events fired.

4. **captured → archived** (PR drops out of legate's tracked set)
   - Trigger: PR is no longer present in either `state.json.slices` or `state.json.archived_slices` (i.e., legate's `legate.cleanup` has fully pruned the slice).
   - Effects: snapshot is no longer refreshed. Cleanup of the on-disk file is governed by SD-002 and is not specified here.

### Event log lifecycle

1. **absent → growing** (first event ever appended)
   - Trigger: first `pr.opened` event from initial PR discovery.
   - Effects: `events.ndjson` created; `seq` begins at 1.

2. **growing → growing** (steady state)
   - Trigger: any diff that produces ≥1 event.
   - Effects: events appended; `seq` monotonically increases.

3. **growing → rotated** (size threshold reached)
   - Trigger: TBD — see SD-001.
   - Effects: TBD. `seq` reset semantics across rotations is open.

### Cursor lifecycle

1. **absent → at-zero** (cold start, first read)
   - Trigger: `read-events.sh` is invoked and the cursor file does not exist.
   - Effects: consumer reads from `seq = 0` (i.e., all events); on success, cursor is written with `last_seq` set to the final event's `seq`.

2. **at-N → at-M** (steady-state read)
   - Trigger: `read-events.sh` is invoked and the cursor file exists with `last_seq = N`.
   - Effects: consumer reads events with `seq > N`; on success, cursor advances to the last event's `seq` (call it `M`); on consumer failure, cursor remains at `N` and the same events will be re-delivered on the next read.

3. **at-N → at-zero** (manual reset)
   - Trigger: `reset-cursor.sh` is invoked.
   - Effects: cursor file is rewritten with `last_seq = 0`. The next read replays the entire log.

## Identity & Uniqueness

- A **Snapshot** is uniquely identified by `(herald-<slug>, pr-<N>)` — i.e., the herald conductor name and the PR number. There is one snapshot file per PR per herald conductor at any time.
- An **Event** is uniquely identified by `(herald-<slug>, seq)` within a given `events.ndjson` file. Across log rotations the tuple `(herald-<slug>, log-filename, seq)` is the full identity; rotation specifics are open (SD-001).
- A **Cursor** is uniquely identified by `(legate-<slug>)` — there is one cursor per legate conductor, pointing into exactly one herald log.
- A **Herald Conductor Meta** is uniquely identified by the herald conductor name (which agent-deck guarantees is unique within a profile).
