# Feature Specification: Mini-Herald

**Spec Folder**: `2026-05-12-003-mini-herald`
**Branch**: `feature/mini-herald`
**Created**: 2026-05-12
**Status**: Draft
**Input**: Operator-authored feature description — a precursor to Herald (Milestone 4 of `docs/rfcs/2026-001-march-orchestration-platform/march-orchestration-platform.rfc.md`), built ahead of full Herald to deliver deterministic PR-event signals into mini-legate now.

## Clarifications

### Session 2026-05-12

- Q: Which entity owns the set of tracked PRs the daemon polls? → A: Mini-herald reads tracked PRs from the sibling legate conductor's `state.json` — every entry in `state.json.slices` whose `pr.number` is set, plus every entry in `state.json.archived_slices` whose `pr_number` is set, regardless of age. Legate is the producer; mini-herald is a read-only consumer of that file. Archived-slice pruning is owned by mini-legate's `legate.cleanup` skill; herald inherits whatever set legate exposes. `[Critical Assumption]`
- Q: How is `pr.head_pushed` detected when `babysit-pr.sh`'s current JSON shape lacks `headRefOid`? → A: Snapshots extend the `babysit-pr.sh` shape with a `head_oid` field captured from `gh pr view --json headRefOid` (same single call, additional field). The diff function compares `prev.head_oid` to `next.head_oid` and emits `pr.head_pushed` on change.
- Q: How does the doorbell debounce across rapid bursts? → A: At most one doorbell `[EVENT]` send per poll tick — fired once after all events for that tick are appended, only when ≥1 high-priority kind was emitted. Multiple high-priority events in the same tick collapse to a single doorbell.
- Q: What is the authoritative source for skill load order in the conductor? → A: The conductor's `CLAUDE.prompt` (in `src/templates/legate/`) is authoritative. The `legate.babysit` SKILL.prompt's frontmatter description ("load before any other skill") is stale and predates `legate.resume`; mini-herald specs must not propagate that phrasing into `legate.herald`.
- Q: Is mini-herald the closure of RFC Milestone 4? → A: No. Mini-herald is a narrower precursor: PR-only event vocabulary, single-repo, file-based log, polling-only. RFC M4's success criteria (first-class Herald clients for Spawn/Hatchery/Brood; deterministic bus protocol; cross-component routing) remain open. `[Critical Assumption]`

### Assumptions

- Sibling legate conductor exists in the same agent-deck profile before `march herald init` is invoked directly. (The typical operator path is `march legate init`, which orchestrates herald deployment alongside legate — see FR-024.) When invoked directly, `march herald init` validates the sibling legate's presence and fails with an actionable error otherwise.
- Daemon is a bash loop (non-LLM "agent" in agent-deck conductor terms), the same way mini-legate is a Claude Code "agent" in the conductor — both ride agent-deck's tmux/restart/observability primitives.
- Mini-herald reuses the existing `babysit-pr.sh` GraphQL+REST query shape verbatim for snapshot capture; the snapshot JSON is the `babysit-pr.sh` output extended with `head_oid` and a `captured_at` ISO-8601 timestamp.
- Event `seq` is a monotonically increasing integer scoped to a single `events.ndjson` file. Rotation introduces a new file with `seq` resetting to 1; rotation is out of scope for the first cut and recorded as specification debt.
- Cursor file is owned by the `legate.herald` skill and lives in the legate conductor's cwd. The herald daemon never reads the cursor.
- Snapshot files persist for the lifetime of legate's tracking of the PR. When legate.cleanup signals teardown of a slice, herald removes the corresponding snapshot file (FR-022). The cleanup-signal wire protocol is captured as SD-008.

## Artifact Hierarchy

RFC → Milestone → Feature → User Story → Slice → Tasks

## User Scenarios & Testing

### User Story 1: Event Schema and Diff Engine (Priority: P1)

As a developer iterating on the herald daemon, I want a pure diff function that maps a pair of per-PR snapshots to a sequence of events so that the event-emission logic is testable without GitHub access.

**Why this priority**: The schema is the contract every other story depends on. Locking it first unblocks the daemon (US4, US5) and the skill (US6) to develop in parallel.

**Independent Test**: Feed the diff function two committed fixture snapshots representing a known transition (e.g., `mergeable: MERGEABLE → CONFLICTING`) and assert the produced events match a golden NDJSON file.

**Acceptance Scenarios**:

1. **Given** two fixture snapshots that differ in `mergeable`, **When** the diff function runs, **Then** it emits exactly one `pr.conflict` or `pr.conflict_cleared` event with `prev`, `next`, `pr_number`, `slice_id`, and `ts` populated.
2. **Given** two fixture snapshots that differ in `checks` rollup, **When** the diff function runs, **Then** it emits the corresponding `pr.ci_failed` / `pr.ci_passed` / `pr.ci_pending` event.
3. **Given** two fixture snapshots that differ in `state` from OPEN to MERGED, **When** the diff function runs, **Then** it emits a `pr.merged` event.
4. **Given** two fixture snapshots that differ in `head_oid`, **When** the diff function runs, **Then** it emits a `pr.head_pushed` event with `prev` and `next` carrying the SHAs.
5. **Given** two fixture snapshots that differ in `unresolved_threads` (a thread id appears, a `last_comment_at` advances, or a thread id disappears), **When** the diff function runs, **Then** it emits `pr.thread_opened` / `pr.thread_new_reply` / `pr.thread_resolved` respectively, with `ref` set to the thread id.
6. **Given** two fixture snapshots that differ in `review_decision`, **When** the diff function runs, **Then** it emits `pr.review_changes_requested` or `pr.review_approved` as appropriate.
7. **Given** two identical fixture snapshots, **When** the diff function runs, **Then** it emits zero events.
8. **Given** a `null` previous snapshot and a fresh snapshot with `state == "OPEN"` (first observation of an open PR), **When** the diff function runs, **Then** it emits a single `pr.opened` event and no others.
9. **Given** a `null` previous snapshot and a fresh snapshot whose `state` is `MERGED` or `CLOSED` (a PR first observed in a terminal state — e.g., a slice that was archived before herald was deployed), **When** the diff function runs, **Then** it emits a `pr.opened` event followed by the appropriate terminal-state event (`pr.merged` or `pr.closed`) so downstream consumers see the full transition rather than treating the archived PR as still open.

---

### User Story 2: Snapshot Capture (Priority: P1)

As the herald daemon, I want a non-LLM script that produces a per-PR snapshot JSON from a live PR by calling the same GitHub queries `babysit-pr.sh` uses today so that snapshot semantics are guaranteed to match what `legate.babysit`'s decision tree already expects.

**Why this priority**: Without snapshot capture there is nothing to diff. Reusing `babysit-pr.sh`'s query shape is the cheapest way to guarantee semantic parity with the existing decision tree.

**Independent Test**: Run the snapshot script against a known open PR; assert the produced JSON contains every field `babysit-pr.sh` produces plus `head_oid` and `captured_at`.

**Acceptance Scenarios**:

1. **Given** a valid PR number and repo path, **When** the snapshot script runs, **Then** it writes a JSON file containing all `babysit-pr.sh` output fields (`state`, `mergeable`, `checks`, `failed_checks`, `unresolved_threads`, `thread_count`, `needs_response_count`, `review_decision`, etc.).
2. **Given** the same PR, **When** the snapshot script runs, **Then** the JSON additionally contains a `head_oid` string and a `captured_at` ISO-8601 timestamp.
3. **Given** a snapshot is being written, **When** a crash occurs mid-write, **Then** a prior valid snapshot remains intact (atomic write via temp file + rename).
4. **Given** the GitHub API returns an error, **When** the snapshot script runs, **Then** it exits non-zero, writes no snapshot, and prints the error to stderr.

---

### User Story 3: Event Log Append (Priority: P1)

As the herald daemon, I want every diff result appended atomically to a single NDJSON event log per conductor so that consumers can read events in deterministic order with a byte-offset or seq-based cursor.

**Why this priority**: The log is the source of truth in the operator's settled design. Append semantics, ordering, and atomicity must be specified before any consumer is built.

**Independent Test**: Drive the diff engine and append routine with two fixture snapshot pairs that produce three events total; assert `events.ndjson` contains exactly three lines, each a valid JSON object with monotonically increasing `seq`.

**Acceptance Scenarios**:

1. **Given** the diff engine produces N events for a tick, **When** the daemon appends them, **Then** the events are written as N consecutive lines of valid JSON to `events.ndjson` in the diff's iteration order.
2. **Given** a sequence of appends across multiple ticks, **When** the log is read top-to-bottom, **Then** the `seq` field is monotonically increasing with no gaps or duplicates.
3. **Given** the daemon is killed mid-tick after partial appends, **When** it restarts, **Then** no event line is half-written (line-atomic via single write syscall under POSIX append semantics); the next tick continues from the correct `seq`.
4. **Given** a long-lived daemon, **When** the events log grows beyond a soft size threshold, **Then** the daemon logs a warning to its stderr stream (rotation policy itself is specification debt — see SD-001).

---

### User Story 4: `march herald init` CLI (Priority: P1)

As an operator, I want `march herald init` to deploy a mini-herald conductor for a target repo so that I have a single command to stand up the daemon, mirroring the experience of `march legate init`.

**Why this priority**: Without a CLI surface the daemon cannot be deployed. The init command is the entry point operators will use; without it, only manual file placement works.

**Independent Test**: Run `march herald init` in a repo with a sibling legate conductor already deployed. Verify a new agent-deck conductor named `herald-<slug>` exists, its cwd is populated with rendered template files, and `march herald init --help` lists supported flags.

**Acceptance Scenarios**:

1. **Given** a repo with no sibling legate conductor, **When** the operator runs `march herald init`, **Then** the command exits non-zero with a clear "no sibling legate conductor found in profile `<X>`" error before touching any files.
2. **Given** a repo with a sibling legate conductor named `legate-<slug>`, **When** the operator runs `march herald init`, **Then** a new agent-deck conductor `herald-<slug>` is created in the same profile, paired to `legate-<slug>` (paired name persisted in herald's `meta.json`).
3. **Given** `march herald init` succeeds, **When** the operator runs `agent-deck conductor list`, **Then** both `legate-<slug>` and `herald-<slug>` appear in the listing.
4. **Given** the same repo, **When** `march herald init` is re-invoked, **Then** the existing conductor is updated in place (template re-rendered, scripts re-copied) without creating a duplicate conductor.
5. **Given** `march herald init --help`, **When** the operator runs it, **Then** flags `--profile`, `--name`, `--target-legate`, `--poll-interval`, and `--no-setup` are listed.

---

### User Story 5: Daemon Poll Loop (Priority: P1)

As an operator, I want the herald daemon to run a poll-and-diff loop at a configurable interval so that PR state changes flow into events without operator intervention.

**Why this priority**: This is the runtime that produces events. Without it nothing emits events even when capture, diff, and log are wired.

**Independent Test**: Start a deployed herald conductor against a repo with one tracked PR. Modify the PR (e.g., push a commit). Within one poll interval, verify a `pr.head_pushed` event appears in `events.ndjson`.

**Acceptance Scenarios**:

1. **Given** a deployed herald conductor, **When** the conductor's tmux session starts, **Then** the daemon loop begins polling tracked PRs at the configured interval (default 60s).
2. **Given** the daemon polls a tracked PR, **When** state has not changed since the last snapshot, **Then** the daemon updates `captured_at` on the snapshot but appends zero events.
3. **Given** the daemon polls a tracked PR, **When** state has changed, **Then** the daemon performs the following ordered sequence — (1) capture the fresh snapshot in memory (or to a temp path), (2) read the prior on-disk snapshot, (3) run the diff against the prior, (4) **durably append** the resulting events to `events.ndjson` (line-atomic write), and only then (5) atomically replace the prior snapshot file with the fresh snapshot. This ordering guarantees that a crash between any two steps cannot lose a transition: events are durable before the snapshot is rotated, so a re-run after crash re-diffs against the still-prior snapshot and re-emits the same events (consumers are idempotent on `seq`).
4. **Given** the sibling legate's `state.json.slices` lists PRs the daemon has never seen, **When** the next tick runs, **Then** the daemon performs an initial snapshot for each and emits a `pr.opened` event per new PR.
5. **Given** a PR that has been pruned from legate's `state.json` entirely (no longer in `slices` or `archived_slices`), **When** the daemon polls, **Then** that PR is dropped from the tracked set (no further snapshot or event emission). Herald defers archive-window pruning to legate's `legate.cleanup` skill and does not impose its own retention cutoff.
6. **Given** the daemon encounters a transient GitHub error (rate limit, 5xx), **When** the error fires, **Then** the daemon logs the error to stderr and continues to the next tick without crashing (rate-limit response strategy itself is specification debt — see SD-003).

---

### User Story 6: `legate.herald` Skill — Event Read with Cursor (Priority: P2)

As the mini-legate conductor, I want a skill that reads new events from herald's log since my last cursor position and advances the cursor only on successful processing so that I consume events exactly once across heartbeats and conductor restarts.

**Why this priority**: This is what makes the events usable. P2 because the daemon (P1) must exist and be writing events first, but this is the second-most-critical piece — it bridges herald's output into legate's loop.

**Independent Test**: Pre-seed `events.ndjson` with five known events. Invoke `read-events.sh` from a fresh cursor; assert it returns all five events as a JSON array and updates the cursor file. Re-invoke; assert it returns zero events.

**Acceptance Scenarios**:

1. **Given** an `events.ndjson` with N events and a cursor at position 0 (or absent), **When** `read-events.sh` runs, **Then** it returns all N events as a JSON array on stdout.
2. **Given** the same log and a successful read, **When** the cursor file is inspected after the read, **Then** it reflects the position immediately after the Nth event.
3. **Given** zero new events since the last cursor position, **When** `read-events.sh` runs, **Then** it returns `[]` and the cursor is unchanged.
4. **Given** a `peek-events.sh` script invocation, **When** it runs, **Then** it returns the same JSON array as `read-events.sh` would, but does not advance the cursor.
5. **Given** a `reset-cursor.sh` script invocation, **When** it runs, **Then** the cursor file is moved to position 0 (next read returns all events from the start).
6. **Given** the skill's `SKILL.prompt` frontmatter, **When** the conductor loads it, **Then** the `allowed-tools` list grants only the `legate.herald/scripts/*` patterns (no inline bash, no cross-skill paths).

---

### User Story 7: Cross-Validation Mode (Priority: P2)

As a developer rolling out herald, I want `legate.babysit` to consume both herald events and its existing `babysit-pr.sh` gh polling for a transition window and to log any disagreement so that schema or diff bugs surface before the events-first flip in US8.

**Why this priority**: This is the safety net. Skipping it means the first divergence between herald events and gh state silently wedges the conductor; running it for a window catches the bug class before it matters.

**Independent Test**: With herald events deliberately stale (daemon paused), run a babysit heartbeat. Verify the cross-validation log captures a disagreement entry naming the PR, the event-derived state, and the gh-derived state.

**Acceptance Scenarios**:

1. **Given** `legate.babysit` is in cross-validate mode, **When** the heartbeat runs, **Then** for every tracked PR, both the event-derived state (from `legate.herald` reads + the latest snapshot) and the gh-derived state (from `babysit-pr.sh`) are computed.
2. **Given** the two states agree on a PR, **When** the heartbeat runs, **Then** no disagreement is logged and the heartbeat proceeds using either source (decision tree input is identical).
3. **Given** the two states disagree on a PR, **When** the heartbeat runs, **Then** a structured disagreement entry is appended to a `cross-validate.ndjson` log and the gh-derived state wins for the heartbeat's decision.
4. **Given** a documented agreement window (≥ a configured number of heartbeats with zero disagreements), **When** the window completes, **Then** the operator may flip babysit to events-first per US8.

---

### User Story 8: Events-First Babysit (Priority: P2)

As the mini-legate conductor, I want `legate.babysit` to consume herald events as its primary input on every heartbeat and to fall back to `babysit-pr.sh` polling only for PRs with no snapshot yet (cold-start) so that PR-state freshness no longer depends on the 15-minute heartbeat cadence.

**Why this priority**: This is the payoff — the heartbeat-cadence coupling for PR-state detection is removed. P2 because US5 and US6 must be solid before legate trusts events as the primary source, and US7 must have validated the bridge.

**Independent Test**: With herald running and the agreement window passed, run a babysit heartbeat. Verify `babysit-pr.sh` is invoked only for tracked PRs whose snapshot file does not exist; events are read for the rest.

**Acceptance Scenarios**:

1. **Given** babysit is in events-first mode, **When** the heartbeat runs, **Then** for each tracked PR with a snapshot file, the decision tree is driven by event-derived state with no `babysit-pr.sh` call.
2. **Given** the same heartbeat, **When** a tracked PR has no snapshot file (cold-start), **Then** `babysit-pr.sh` is invoked as a fallback for that PR only.
3. **Given** the herald daemon is down and the snapshot files are stale (a configurable freshness threshold), **When** the heartbeat runs, **Then** babysit falls back to `babysit-pr.sh` for every PR and surfaces a `NEED:` to the operator about the stale herald.
4. **Given** the decision tree's behavior on a PR in events-first mode, **When** compared to the same PR in legacy gh-polling mode for the same observed state, **Then** the actions selected (dispatch `/smithy.fix`, request rebase, etc.) are identical.

---

### User Story 9: Doorbell for High-Priority Events (Priority: P3)

As an operator, I want high-priority PR events (merges, CI failures, new review replies, conflicts, changes-requested) to wake mini-legate immediately via an `agent-deck session send` doorbell so that critical state changes are reacted to within seconds rather than waiting for the next heartbeat.

**Why this priority**: This is the latency optimization. P3 because the log-based path (US5 + US6 + US8) already delivers correctness — the doorbell only changes latency. Worth shipping last to validate it doesn't introduce noise or wedge auto-mode.

**Independent Test**: With herald running and the doorbell wired, trigger a CI failure on a tracked PR. Within one poll interval, verify a single `[EVENT]` message arrives in the legate conductor's tmux pane and a corresponding `pr.ci_failed` event is in `events.ndjson`.

**Acceptance Scenarios**:

1. **Given** a poll tick during which ≥1 high-priority event was emitted, **When** the events are appended, **Then** the daemon fires exactly one `agent-deck session send` to the paired legate with the literal message `[EVENT]` (payload-free).
2. **Given** a poll tick during which only non-high-priority events were emitted, **When** the events are appended, **Then** the daemon fires no doorbell.
3. **Given** a poll tick during which zero events were emitted, **When** the tick completes, **Then** the daemon fires no doorbell.
4. **Given** multiple high-priority events in a single tick, **When** they are appended, **Then** exactly one doorbell is fired (debounced at the tick boundary, not per event).
5. **Given** an `[EVENT]` doorbell arrives at legate, **When** the heartbeat skill chain runs, **Then** `legate.herald` reads the log and `legate.babysit` consumes the read events per its normal decision tree.

---

### Edge Cases

- Daemon crashes mid-tick after capturing a fresh snapshot but before appending events: the on-disk prior snapshot is untouched; the next tick re-captures, re-diffs against the same prior, and re-appends the same events. No transitions are lost.
- Daemon crashes after appending events but before atomically replacing the prior snapshot: events are already durable; the next tick re-captures, re-diffs against the (still) prior snapshot, and re-emits identical events. Consumers are idempotent on `seq` — duplicates by content but distinct by `seq` are tolerated; the snapshot replace eventually completes on a successful tick.
- Daemon crashes after appending events but before firing the doorbell: log is intact; next heartbeat consumes the events (correctness preserved, latency degraded).
- Cursor file is corrupt or absent on the consumer side: see SD-004.
- A PR is force-pushed, GitHub returns a transient `mergeable: UNKNOWN`: snapshot records `UNKNOWN`; diff suppresses `pr.conflict_cleared` / `pr.conflict` until the value resolves to a concrete `MERGEABLE` / `CONFLICTING`.
- A tracked PR is closed externally (without merging) during a tick: `pr.closed` is emitted (per the taxonomy; a merge produces `pr.merged` instead). Herald continues to surface the PR in subsequent snapshots until legate.cleanup signals teardown for the slice — at which point herald removes the per-PR snapshot file per FR-022. Herald imposes no age-based cutoff of its own.
- Legate's `state.json` is locked or absent: daemon skips the tick rather than blocking, logs a warning to stderr, retries next tick.
- Sibling legate conductor is uninstalled while herald is running: herald's `meta.json` `paired_legate` becomes invalid; doorbell sends silently no-op (agent-deck send to a missing target is a non-fatal stderr warning) and the log keeps accumulating.
- Multiple events of the same kind for the same PR within one tick (e.g., `pr.ci_pending` then `pr.ci_failed`): only the net transition relative to the prior snapshot is emitted; intermediate states between polls are not observable.

## Dependency Order

Recommended implementation sequence:

| ID  | Title                                       | Depends On | Artifact |
|-----|---------------------------------------------|------------|----------|
| US1 | Event Schema and Diff Engine                | —          | —        |
| US2 | Snapshot Capture                            | US1        | —        |
| US3 | Event Log Append                            | US1        | —        |
| US4 | `march herald init` CLI                     | US1, US2, US3 | —     |
| US5 | Daemon Poll Loop                            | US2, US3, US4 | —     |
| US6 | `legate.herald` Skill — Event Read with Cursor | US3     | —        |
| US7 | Cross-Validation Mode                       | US5, US6   | —        |
| US8 | Events-First Babysit                        | US7        | —        |
| US9 | Doorbell for High-Priority Events           | US5        | —        |

## Requirements

### Functional Requirements

- **FR-001**: The system MUST define an event schema with the 14 PR-only kinds — `pr.opened`, `pr.merged`, `pr.closed`, `pr.conflict`, `pr.conflict_cleared`, `pr.ci_failed`, `pr.ci_passed`, `pr.ci_pending`, `pr.review_changes_requested`, `pr.review_approved`, `pr.thread_opened`, `pr.thread_new_reply`, `pr.thread_resolved`, `pr.head_pushed` — and a payload shape of `{schema_version, seq, kind, pr_number, slice_id, ts, prev, next, ref?}`.
- **FR-002**: The system MUST provide a pure diff function that takes a prior snapshot and a fresh snapshot for the same PR and returns an ordered list of events, deterministically and with no I/O.
- **FR-003**: The system MUST emit a `pr.opened` event whenever a PR is observed for the first time (prior snapshot is null). When the fresh snapshot's `state` is already `MERGED` or `CLOSED` at first observation (e.g., the PR was first surfaced via legate's `archived_slices`), the diff MUST additionally emit the corresponding terminal-state event (`pr.merged` or `pr.closed`) in the same call so consumers see the full transition rather than treating an archived PR as still open.
- **FR-004**: The system MUST extend the snapshot JSON shape to include `head_oid` (PR head SHA) and `captured_at` (ISO-8601 timestamp) beyond the fields already produced by `babysit-pr.sh`.
- **FR-005**: The system MUST write snapshot files atomically (write to a temp path, rename into place) so that a crash mid-write cannot leave a corrupt snapshot visible to readers.
- **FR-005a**: The system MUST order each poll tick so that (1) the fresh snapshot is captured to memory (or a temp path), (2) the diff against the prior on-disk snapshot is computed, (3) the resulting events are durably appended to `events.ndjson`, and only then (4) the prior snapshot file is atomically replaced. A crash between any two steps MUST NOT lose a transition — the on-disk prior snapshot remains the diff baseline until events are durable.
- **FR-006**: The system MUST append events to a single `events.ndjson` file per herald conductor, one JSON object per line, with `seq` monotonically increasing within the file.
- **FR-007**: The system MUST expose a `march herald init` CLI command that mirrors the surface of `march legate init` (Commander group), supporting at minimum `--profile`, `--name`, `--target-legate`, `--poll-interval`, and `--no-setup` flags.
- **FR-008**: The system MUST validate that a sibling legate conductor exists in the target profile before deploying a herald conductor, failing fast with an actionable error otherwise.
- **FR-009**: The system MUST deploy the herald daemon as an agent-deck conductor (one per legate, per repo), using agent-deck for tmux/restart/observability.
- **FR-010**: The system MUST read the set of tracked PRs from the sibling legate conductor's `state.json` — every entry in `state.json.slices` whose `pr.number` is a positive integer, plus every entry in `state.json.archived_slices` whose `pr_number` is set, regardless of age. Pruning of `archived_slices` is owned by mini-legate (legate's `legate.cleanup` skill); herald inherits whatever set legate exposes and does not impose its own age cutoff. The herald daemon MUST NOT write to legate's `state.json`.
- **FR-011**: The system MUST run the poll-and-diff loop at a configurable interval, defaulting to 60 seconds, set via the `--poll-interval` init flag and persisted in the herald conductor's `meta.json`.
- **FR-012**: The system MUST provide a `legate.herald` skill in the mini-legate template that exposes `read-events.sh`, `peek-events.sh`, and `reset-cursor.sh` scripts and grants them via `allowed-tools` in the SKILL.prompt frontmatter.
- **FR-013**: The system MUST place the cursor file in the legate conductor's cwd (not the herald conductor's cwd) and ensure the herald daemon never reads it.
- **FR-014**: The system MUST integrate `legate.herald` into the conductor's heartbeat order between `legate.resume` and `legate.babysit`, as declared in `CLAUDE.prompt` (the authoritative source for skill load order).
- **FR-015**: The system MUST support a cross-validation mode in `legate.babysit` that consumes both event-derived state (via `legate.herald` + snapshot read) and gh-derived state (via `babysit-pr.sh`) for the same heartbeat, and logs any disagreement to a `cross-validate.ndjson` file.
- **FR-016**: The system MUST support an events-first mode in `legate.babysit` that consumes event-derived state as the primary input and falls back to `babysit-pr.sh` only for PRs with no snapshot file (cold-start case).
- **FR-017**: The system MUST fall back to `babysit-pr.sh` polling for every tracked PR and surface a `NEED:` to the operator when snapshots are older than a configured freshness threshold (indicating the herald daemon is down or stalled).
- **FR-018**: The system MUST fire at most one doorbell `agent-deck session send "[EVENT]"` per poll tick, only when ≥1 high-priority event was emitted in that tick. High-priority kinds: `pr.merged`, `pr.ci_failed`, `pr.thread_new_reply`, `pr.conflict`, `pr.review_changes_requested`.
- **FR-019**: The system MUST treat the doorbell as a best-effort latency optimization. If the doorbell fails to deliver (paired legate conductor missing, tmux unreachable), the failure is non-fatal — the next scheduled heartbeat consumes the events from the log.
- **FR-020**: The system MUST provide a test entry point — `src/herald.test.ts` — covering the diff engine via fixture snapshot pairs, mirroring the test pattern of `src/legate.test.ts`.
- **FR-021**: The system MUST treat the herald daemon as the sole writer of every file in `~/.agent-deck/conductor/herald-<slug>/` (snapshots, events log, meta). External cleanup of per-PR data MUST flow through a herald-owned mechanism, not direct file mutation by legate or any other process. (Exact signal protocol — see SD-008.)
- **FR-022**: The system MUST provide a cleanup pathway for per-PR data triggered by `legate.cleanup`'s slice teardown. When legate.cleanup finishes pruning a slice from `state.json` (worker session removed, worktree pruned, slice moved into `archived_slices` and eventually removed), it MUST signal the paired herald so that herald removes the corresponding snapshot file and, optionally, rotates or archives the events for that PR. The wire protocol for the signal is captured in SD-008.
- **FR-023**: When the herald daemon encounters a transient GitHub API failure (rate limit, 5xx, network error), it MUST skip the affected tick, write a descriptive error line to its own stderr (visible in the herald conductor's tmux pane and persisted by agent-deck), and proceed to the next tick. The daemon MUST NOT propagate the error to the paired legate (no doorbell, no `herald.error` event), so transient GitHub flakiness does not produce noise in the operator-facing legate stream.
- **FR-024**: The `march legate init` command MUST orchestrate herald deployment alongside legate — running `march legate init` against a repo deploys both the legate conductor and a paired herald conductor in the same agent-deck profile. `march herald init` remains available as a lower-level primitive for incremental deploys (e.g., adding herald to a legate that was created before mini-herald existed), but the operator-facing default is "one command, both conductors."

### Key Entities

- **Snapshot**: A per-PR JSON file at `~/.agent-deck/conductor/herald-<slug>/snapshots/pr-<N>.json` holding the last-observed `babysit-pr.sh`-shape state extended with `head_oid` and `captured_at`. Owner: herald daemon (sole writer).
- **Event**: A single JSON object appended as one line to `~/.agent-deck/conductor/herald-<slug>/events.ndjson`. Schema: `{schema_version, seq, kind, pr_number, slice_id, ts, prev, next, ref?}`. Owner: herald daemon (sole writer).
- **Cursor**: A small JSON file at `~/.agent-deck/conductor/<legate-name>/herald-cursor.json` recording the consumer's last-read position (byte offset and/or last-consumed `seq`). Owner: `legate.herald` skill (sole writer).
- **Herald Conductor Meta**: A `meta.json` file in the herald conductor's cwd recording `schema_version`, `paired_legate` (the sibling conductor's name, e.g., `legate-march` — passed verbatim to `agent-deck session send` for doorbells and resolved by agent-deck), `profile`, `repo_path`, `repo_owner_with_name` (the GitHub `owner/repo` for `gh api graphql` calls), `poll_interval_seconds`, and `legate_state_path` (the absolute path to the paired legate's `state.json`). Owner: `march herald init` (writes on init/update); daemon reads. Full field semantics are in the data model.

## Assumptions

- The herald daemon is non-LLM. It is a bash loop running inside an agent-deck conductor; the "agent" registered with agent-deck for this conductor is the shell loop script, not Claude Code.
- The herald daemon trusts its sibling legate's `state.json` as the read-only source of tracked PRs. There is no separate herald-side tracking config.
- `babysit-pr.sh`'s GraphQL+REST query shape is the canonical PR-state observation. Mini-herald reuses it verbatim plus the `head_oid` field; semantic parity with the existing decision tree is the default.
- The cross-validation window (US7) is operator-driven, not time-bound: the operator inspects `cross-validate.ndjson`, decides agreement is sufficient, and flips the mode.
- The doorbell carries no payload because the log is the single source of truth. Including event details in the doorbell would let consumers drift from log replay; payload-free debouncing forces correct-by-construction log reads.

## Specification Debt

| ID     | Description                                                                                                                                                                          | Source Category          | Impact | Confidence | Status | Resolution |
|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------|--------|------------|--------|------------|
| SD-001 | events.ndjson rotation policy (size threshold, rotated filename, retention count) — superseded by SD-008's cleanup-driven model: rotation is triggered by per-PR cleanup signals rather than time- or size-based thresholds. Exact rotation/archive semantics still TBD (rotate-on-cleanup vs. keep-forever vs. per-PR log files). | Non-Functional Quality | Medium | Medium | partial | Tied to SD-008's cleanup-signal design; see also FR-021 / FR-022. |
| SD-002 | Snapshot retention for closed/merged PRs — resolved: herald deletes the per-PR snapshot file when legate.cleanup signals teardown for that slice. No time-based retention. Exact wire protocol for the cleanup signal is SD-008.                                                                | Domain & Data Model      | Low    | Medium     | resolved | Resolved 2026-05-13 — herald deletes per-PR snapshot on legate.cleanup signal (see FR-022 / SD-008). |
| SD-003 | Behavior when GitHub API rate-limits or returns 5xx mid-poll — resolved: skip the affected tick, log the error to herald's own stderr (visible in its tmux pane), do not propagate to legate (no doorbell, no `herald.error` event). Operator-visible via herald conductor inspection, no noise in legate's stream. | Edge Cases             | Medium | Medium     | resolved | Resolved 2026-05-13 — see FR-023. |
| SD-004 | Cursor crash-safety: atomic write strategy and recovery if cursor file is corrupt. Resolved partial: absent cursor is treated as `last_seq = 0` (replay from start); corrupt cursor surfaces a `read-events.sh` exit 2 without modifying the cursor, leaving recovery to the caller. Open tail: who clears the corrupt file (operator? auto-reset on the next legate heartbeat?) — TBD. | Edge Cases | Medium | Medium | partial | Absent-cursor behavior resolved; corrupt-cursor handling deferred. See FR-013 and the cursor entry in the data model. |
| SD-005 | Exact `march herald` CLI option set — resolved by FR-024: `march herald init` becomes a lower-level primitive; the default operator entry point is `march legate init`, which orchestrates both conductors. Detailed flag parity (heartbeat-interval analog, bridge-check defaults, profile derivation) is folded into the legate-init contract. | Interaction & UX | Medium | Medium | resolved | Resolved 2026-05-13 — see FR-024. |
| SD-006 | Stale-snapshot freshness threshold (FR-017) is unspecified as a concrete duration. Likely a function of `poll_interval`, e.g., 5× interval, but spec does not fix the multiplier.       | Non-Functional Quality   | Medium | Medium     | open   | —          |
| SD-007 | Agreement-window definition for the cross-validate → events-first transition (US7 → US8) — number of heartbeats / PRs / consecutive ticks required is operator judgment, not specified. | Functional Scope         | Low    | Low        | open   | —          |
| SD-008 | Cleanup-signal wire protocol from `legate.cleanup` to herald. The principle is fixed (only herald writes to herald-owned files; legate.cleanup signals herald to clean up per-PR data — FR-021, FR-022). The mechanism is open: file-drop into a herald-owned inbox dir, an `agent-deck session send "[CLEANUP pr=<N>]"` to herald's tmux pane consumed by the daemon loop, or a herald-supplied script invoked synchronously by legate.cleanup. Each has trade-offs (durability, observability, race surface) the spec does not resolve here. | Functional Scope         | High   | Medium     | open   | —          |

## Out of Scope

- **Webhook event source.** GitHub webhooks would lower latency and reduce polling cost but require an HTTPS receiver (smee.io, ngrok, self-hosted). The daemon's diff loop is the same whether the input arrives by poll or webhook; webhook support is a future second input source.
- **Adaptive polling cadence.** Slowing the cadence after consecutive no-change polls and snapping back on change is a future optimization. The current spec ships a fixed configurable interval; the cadence field in `meta.json` is the only required hook.
- **Non-PR events.** Worker session transitions (`agent-deck notify-daemon`), branch-level events, workflow_run events outside PR CI rollup, and issue-level events are not in scope.
- **Cross-repo / multi-legate coordination.** One mini-herald per legate, per repo. A single herald watching multiple repos belongs to RFC M4 with Hatchery profiles.
- **Replacement of agent-deck heartbeats.** Mini-herald supplements the scheduled heartbeat with a latency-optimization doorbell; it does not remove the heartbeat. Legate continues to wake on its 15-minute (or operator-configured) cadence.
- **RFC M4 closure.** Mini-herald delivers no Spawn/Hatchery/Brood Herald clients and does not implement a cross-component bus protocol. M4's success criteria remain open after this work lands.
- **Auth or networking changes.** Polling reuses the operator's already-authed `gh` CLI; no new credentials, no new network endpoints, no firewall changes.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A developer can run a unit test (`vitest src/herald.test.ts`) that exercises the diff engine against committed fixture snapshot pairs and validates the full 14-kind event vocabulary without making any GitHub API call.
- **SC-002**: After `march herald init` in a repo with a sibling legate conductor, `agent-deck conductor list` shows two conductors (`legate-<slug>` and `herald-<slug>`) in the same profile, and the herald conductor's tmux pane shows daemon poll activity within one poll interval.
- **SC-003**: For a tracked PR with a known state change (e.g., a manual force-push), an event corresponding to the change appears in `events.ndjson` within one configured poll interval of the change being visible on GitHub.
- **SC-004**: During the cross-validation window (US7), zero disagreement entries are recorded in `cross-validate.ndjson` across a configured number of consecutive heartbeats spanning at least three distinct PR-state transitions.
- **SC-005**: After the events-first flip (US8), the `babysit-pr.sh` script is invoked at most once per heartbeat per tracked PR that lacks a snapshot file. Tracked PRs with snapshots produce zero `babysit-pr.sh` invocations from the babysit decision tree.
- **SC-006**: A high-priority event (e.g., `pr.ci_failed`) on a tracked PR produces exactly one `[EVENT]` doorbell delivery into the paired legate conductor's tmux pane per poll tick that contains it.
- **SC-007**: With the herald daemon stopped, mini-legate continues to function on its scheduled heartbeats via the FR-017 fallback path, surfacing a `NEED:` for stale snapshots; correctness is preserved at degraded latency.
- **SC-008**: The mini-legate template's `README.md` and `CLAUDE.md` are updated to reference mini-herald and the `legate.herald` skill; the babysit SKILL.prompt frontmatter is corrected (or annotated) to no longer claim "load before any other skill," consistent with the authoritative load order in `CLAUDE.prompt`.
