# Contracts: Mini-Herald

## Overview

Mini-herald introduces contracts at five boundaries: the `march herald` CLI surface (operator-facing), the pure diff function (developer-facing, unit-testable), the daemon's read of legate's `state.json` (cross-conductor file contract), the `legate.herald` skill scripts (consumer-facing, called from legate's heartbeat), and the doorbell message sent via `agent-deck session send` (cross-conductor signal contract). The event and snapshot file shapes themselves are defined as data contracts in the companion data model document; this document covers the interfaces that produce, consume, and route those artifacts.

## Interfaces

### march herald init

**Purpose**: deploy a mini-herald conductor for a target repo, paired to an existing sibling legate conductor.
**Consumers**: operator (via the `march` CLI).
**Providers**: `src/herald.ts` (new), registered as a Commander group in `src/cli.ts` parallel to the existing `legate` group.

#### Signature

```
march herald init [options]
```

#### Inputs

| Parameter            | Type     | Required | Description                                                                                                                |
|----------------------|----------|----------|----------------------------------------------------------------------------------------------------------------------------|
| `--profile <name>`   | string   | No       | Agent-deck profile to deploy into. Defaults to a slug derived from the repo (matching `march legate init`'s rule).         |
| `--name <name>`      | string   | No       | Conductor name override. Defaults to `herald-<slug>`.                                                                      |
| `--target-legate <name>` | string | No     | Sibling legate conductor name to pair with. Defaults to `legate-<slug>` derived from the same slug.                       |
| `--poll-interval <seconds>` | integer | No | Daemon tick interval. Range `[10, 3600]`. Default `60`.                                                                  |
| `--no-setup`         | boolean  | No       | Render the template and write files but skip the `agent-deck conductor setup` call. Mirrors the legate flag.               |

The command MUST be run inside a git repository (the repo path is detected by walking up from cwd). Running outside one is a fatal error before any files are written.

#### Outputs

| Field              | Type    | Description                                                                                                       |
|--------------------|---------|-------------------------------------------------------------------------------------------------------------------|
| stdout summary     | text    | Human-readable summary: conductor name, profile, paired legate, repo path, poll interval, rendered file paths.    |
| exit code 0        | integer | Success: conductor exists in agent-deck and the daemon is up.                                                     |
| files materialized | n/a     | `~/.agent-deck/conductor/herald-<slug>/{CLAUDE.md, meta.json, heartbeat.sh, daemon-loop.sh, snapshots/, scripts/}` — the runtime conductor cwd. (`march herald init` may additionally write a staged copy under `~/.march/herald/<conductor-name>/` mirroring the mini-legate deploy pattern; this is a deploy-time implementation detail and is not part of the runtime data model.) |

#### Error Conditions

| Condition                                          | Response                                                                                                         | Description                                                                                          |
|----------------------------------------------------|------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| cwd is not inside a git repo                       | exit 1, stderr: `not inside a git repository`                                                                    | Hard precondition; no files are written.                                                             |
| `--target-legate` conductor does not exist        | exit 1, stderr: `no sibling legate conductor "<name>" found in profile "<profile>"`                              | Validated before any files are written.                                                              |
| `--poll-interval` is outside `[10, 3600]`          | exit 2 (usage error), stderr identifies the invalid value                                                        | Same convention as Commander usage errors elsewhere in the CLI.                                      |
| Herald conductor with the chosen name already exists | rerender + recopy (idempotent update path), exit 0                                                              | Same shape as `march legate init` re-invocation: no duplicate conductor created.                     |
| agent-deck binary is not on PATH                   | exit 1, stderr identifies missing dependency                                                                     | Mirrors the legate init dependency-check.                                                            |
| `gh` CLI not authenticated                         | exit 1, stderr identifies missing GitHub auth                                                                    | Daemon will need authed gh; failing fast here is preferable.                                         |

---

### march herald diff

**Purpose**: pure-function test entry point. Run the diff engine against two committed snapshot files and produce the event sequence on stdout. Lets the engine be unit-tested without subprocess gh calls.
**Consumers**: test harness, developers debugging the diff engine.
**Providers**: `src/herald.ts` (pure function exposed via the CLI).

#### Signature

```
march herald diff <prev-snapshot-path> <next-snapshot-path>
```

Either path may be the literal string `null` to denote "no prior snapshot" (first observation case).

#### Inputs

| Parameter              | Type   | Required | Description                                                                                          |
|------------------------|--------|----------|------------------------------------------------------------------------------------------------------|
| `<prev-snapshot-path>` | string | Yes      | Path to the prior snapshot JSON, or the literal `null`.                                              |
| `<next-snapshot-path>` | string | Yes      | Path to the fresh snapshot JSON.                                                                     |

#### Outputs

| Field        | Type    | Description                                                                                                 |
|--------------|---------|-------------------------------------------------------------------------------------------------------------|
| stdout       | NDJSON  | Zero or more events, one per line, in deterministic emission order. Each event matches the event schema.    |
| exit code 0  | integer | Success — even when zero events are emitted (identical snapshots).                                          |

#### Error Conditions

| Condition                                  | Response                                  | Description                                                          |
|--------------------------------------------|-------------------------------------------|----------------------------------------------------------------------|
| Snapshot file is missing or unreadable     | exit 1, stderr names the file             | Cannot diff against a non-existent input.                            |
| Snapshot JSON fails schema validation      | exit 1, stderr identifies the failure     | Diff inputs MUST be valid snapshots; shape errors are not silenced.  |
| Snapshots disagree on `number`             | exit 1, stderr: `pr_number mismatch`      | A diff is per-PR; cross-PR diffing is a programming error.           |
| Snapshot `schema_version` is unsupported   | exit 1, stderr identifies the version     | Engine refuses to diff inputs from a future schema.                  |

---

### Diff Function (programmatic)

**Purpose**: pure function inside `src/herald.ts` that the `march herald diff` CLI and the daemon loop both call. Defined as a contract because it is the single semantic authority for "what events come out of what state transition."
**Consumers**: `march herald diff`, daemon loop (`daemon-loop.sh` shells out via `march herald diff`), `src/herald.test.ts`.
**Providers**: `src/herald.ts`.

#### Signature

```
diff(prev: Snapshot | null, next: Snapshot, slice_id: string, next_seq: number): Event[]
```

#### Inputs

| Parameter   | Type             | Required | Description                                                                                                            |
|-------------|------------------|----------|------------------------------------------------------------------------------------------------------------------------|
| `prev`      | Snapshot \| null | Yes      | The prior snapshot, or `null` if this is the first observation of the PR.                                              |
| `next`      | Snapshot         | Yes      | The fresh snapshot to diff against `prev`.                                                                             |
| `slice_id`  | string           | Yes      | The legate slice id (or `issue-<N>`) the PR is associated with. Denormalized into every emitted event.                |
| `next_seq`  | integer          | Yes      | The `seq` value to assign to the first emitted event. Subsequent events in the same call increment by 1.              |

#### Outputs

| Field   | Type      | Description                                                                                                              |
|---------|-----------|--------------------------------------------------------------------------------------------------------------------------|
| return  | Event[]   | Ordered list of events. Empty array when `prev` and `next` are equivalent or when `next.mergeable == "UNKNOWN"` masks a transition. |

#### Error Conditions

| Condition                                            | Response                                                        | Description                                                          |
|------------------------------------------------------|-----------------------------------------------------------------|----------------------------------------------------------------------|
| `prev != null` and `prev.number != next.number`      | throw / reject (programming error)                              | Cross-PR diffing is unsupported.                                     |
| `next.schema_version` unsupported                    | throw / reject                                                  | Engine refuses unknown schemas explicitly.                           |
| `next.mergeable == "UNKNOWN"`                        | suppress `pr.conflict` / `pr.conflict_cleared` for this call    | Transient GitHub computation state; wait for next tick to resolve.   |

---

### legate.herald skill scripts

**Purpose**: the surface the mini-legate conductor uses to consume herald's event log. The scripts are deployed inside the legate template at `src/templates/legate/skills/legate.herald/scripts/` and live at `~/.agent-deck/conductor/<legate-name>/.claude/skills/legate.herald/scripts/` on disk.
**Consumers**: `legate.babysit`'s decision tree (in cross-validate and events-first modes), and the conductor's heartbeat skill chain.
**Providers**: shell scripts shipped with the mini-herald work, deployed by `march legate init` once the `legate.herald` skill exists in the template tree.

#### read-events.sh

```
read-events.sh <legate-cwd> <herald-events-path>
```

Inputs: the legate conductor's cwd (for cursor file location), and the absolute path to the paired herald's `events.ndjson`.

Output: a JSON array of new events (those with `seq > cursor.last_seq`) on stdout. On success, the cursor is advanced to the last event's `seq`. Exit 0 on success (including the zero-events case, in which output is `[]`); exit 1 on I/O error; exit 2 on cursor corruption (cursor is then reset to 0 and the caller decides whether to retry).

Error conditions:

| Condition                                       | Response                                                                                  |
|-------------------------------------------------|-------------------------------------------------------------------------------------------|
| Events log does not exist                       | output `[]`, exit 0 — herald has never written; consumer treats as no events.             |
| Cursor file is corrupt                          | exit 2 with stderr identifying the corruption; cursor is NOT modified — caller decides.   |
| Cursor advances and the atomic write fails      | exit 1; events ARE returned on stdout but cursor was not advanced (next read duplicates). |

#### peek-events.sh

```
peek-events.sh <legate-cwd> <herald-events-path>
```

Same inputs and stdout shape as `read-events.sh`, but never modifies the cursor. Used for diagnostics and dry-run inspection.

#### reset-cursor.sh

```
reset-cursor.sh <legate-cwd>
```

Resets the cursor to `last_seq = 0`. Next read returns the full log. Exit 0 on success; exit 1 on file I/O failure.

---

### Doorbell

**Purpose**: a payload-free `[EVENT]` message sent from the herald daemon to the paired legate conductor's tmux pane when any high-priority kind was emitted in a tick. The doorbell wakes the conductor outside its scheduled heartbeat cadence so the events are processed promptly.
**Consumers**: mini-legate conductor (the tmux input ends up as a user message into the Claude Code session, processed by the standard heartbeat skill chain).
**Providers**: the herald daemon loop.

#### Signature

```
agent-deck -p <profile> session send <paired-legate-conductor-id> "[EVENT]" --no-wait -q
```

The literal payload sent to the conductor is the six-character string `[EVENT]`. No PR number, no kind, no metadata.

#### Inputs

| Parameter                       | Type    | Required | Description                                                                                       |
|---------------------------------|---------|----------|---------------------------------------------------------------------------------------------------|
| `<profile>`                     | string  | Yes      | The agent-deck profile both conductors live in. Read from `meta.json.profile`.                    |
| `<paired-legate-conductor-id>`  | string  | Yes      | The target legate conductor's session id (or title). Read from `meta.json.paired_legate`.         |

#### Outputs

| Field   | Type    | Description                                                                                          |
|---------|---------|------------------------------------------------------------------------------------------------------|
| (none)  | n/a     | Fire-and-forget. The daemon does not consume `agent-deck send` output.                              |

#### Error Conditions

| Condition                                            | Response                                                                          |
|------------------------------------------------------|-----------------------------------------------------------------------------------|
| Paired legate conductor not found                    | `agent-deck send` exits non-zero; daemon logs to stderr and continues.            |
| Legate conductor's tmux session is stopped           | Send is silently dropped by agent-deck; daemon does not retry.                    |
| Multiple high-priority events in one tick            | Exactly one doorbell is sent at the end of the tick (debounced at tick boundary). |
| Tick produced no high-priority events                | No doorbell sent.                                                                 |

The doorbell is best-effort. The event log is the source of truth; the next scheduled heartbeat consumes the events regardless of doorbell delivery.

---

### Legate state.json read contract

**Purpose**: the herald daemon discovers the set of tracked PRs by reading the paired legate conductor's `state.json`. This is a cross-conductor file contract: herald reads, legate writes. There is no write-back path.
**Consumers**: herald daemon loop.
**Providers**: mini-legate (existing artifact; herald imposes a read-only dependency on its shape).

#### Signature

```
read(legate-state-path) → { slices: {[id]: SliceState}, archived_slices: {[id]: ArchivedSliceState}, ... }
```

The path is captured at init time in `meta.json.legate_state_path`.

#### Inputs

| Parameter            | Type   | Required | Description                                                              |
|----------------------|--------|----------|--------------------------------------------------------------------------|
| `legate-state-path`  | string | Yes      | Absolute path to the paired legate's `state.json`.                       |

#### Outputs

The daemon extracts the set of `(slice_id, pr_number)` tuples by:
- Iterating `state.json.slices`: include every entry whose `pr.number` is a positive integer.
- Iterating `state.json.archived_slices`: include every entry whose `pr_number` is set, regardless of age. Herald imposes no retention window of its own; archived-slice pruning is owned by mini-legate's `legate.cleanup` skill, and herald simply inherits whatever set is present in `state.json` at the moment of the poll.

#### Error Conditions

| Condition                                        | Response                                                                                   |
|--------------------------------------------------|--------------------------------------------------------------------------------------------|
| `state.json` file does not exist                 | Daemon logs to stderr and skips the tick; no events appended.                              |
| File exists but JSON parse fails                 | Daemon logs and skips the tick.                                                            |
| Schema is older than expected (missing fields)   | Daemon best-effort extracts what it can; missing fields treat slice as untracked for the tick. |
| File is locked (concurrent write by legate)      | Daemon retries once after a short backoff; on persistent lock, skips the tick.             |

The daemon MUST NOT write to `state.json` under any circumstances. State for herald lives entirely in herald's own conductor cwd.

## Events / Hooks

### Outbound events (herald → consumers via file log)

The full 14-kind PR event vocabulary is defined in the data model document. Consumers are:
- `legate.herald` skill (primary, via `read-events.sh`).
- Any future replay tool (`march herald replay`, e.g.) that operates against `events.ndjson` directly. Such a tool is out of scope for this spec.

### Outbound signals (herald → legate via tmux)

The single `[EVENT]` doorbell described above. No other signal types are defined.

### Inbound events (consumers → herald)

None. Herald is a pure producer of events and signals; consumers have no upward path to herald.

## Integration Boundaries

- **GitHub API (via `gh` CLI)**: Herald reuses the operator's authenticated `gh` CLI to run the same `gh pr view --json` + `gh api graphql` reviewThreads query that `babysit-pr.sh` runs today. Auth, rate limits, and network access are inherited from the host environment; no new credentials, no new firewall rules.
- **agent-deck (CLI)**: Herald is deployed via `agent-deck conductor setup` and sends doorbells via `agent-deck -p <profile> session send`. Agent-deck owns the conductor lifecycle (tmux, restart, status); herald owns its own meta and on-disk artifacts.
- **mini-legate template (`src/templates/legate/`)**: This work adds a new skill bundle at `src/templates/legate/skills/legate.herald/` containing `SKILL.prompt` + `scripts/{read-events.sh, peek-events.sh, reset-cursor.sh}`. The bundle is deployed by `march legate init` like every other skill. The conductor's `CLAUDE.prompt` is updated to load `legate.herald` between `legate.resume` and `legate.babysit`.
- **`legate.babysit` script suite**: A new mode flag (or two — `cross-validate` and `events-first`) is added to the decision tree's input handling. The decision tree itself (the MERGED → CONFLICTING → FAIL → unresolved-threads → all-clear ladder) is unchanged. Only the source of the per-PR state input changes.
- **`src/cli.ts`**: A new `herald` Commander group is added, structurally parallel to the existing `legate` group (the `program.command("legate")` block with its `init` subcommand, alongside the `spawn` group). The unknown-command fallthrough at the bottom of that file relies on the group shape; the new group MUST follow it exactly.
- **`src/herald.ts` + `src/herald.test.ts`**: New module mirroring `src/legate.ts` / `src/legate.test.ts`. Houses the diff function, the init flow, and the template-render helpers; covered by a fixture-driven test file. No new runtime dependencies introduced.
- **Filesystem layout**: All persistent state lives under `~/.agent-deck/conductor/{herald-<slug>,legate-<slug>}/`. No global state, no shared databases, no inter-host coordination.
