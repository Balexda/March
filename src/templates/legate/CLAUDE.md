# Agent context — mini-legate template

This file is context for an agent (Claude Code, or any other AI assistant) working on the mini-legate template. Humans iterating on the template should also find it useful, but it's deliberately focused on **programmatic** inspection and the gotchas that don't surface when you drive agent-deck through its TUI.

> Companion docs in this directory:
> - [`README.md`](./README.md) — what mini-legate is and how it works conceptually.
> - [`CONTRIBUTING.md`](./CONTRIBUTING.md) — developer dev loop, build, deploy, re-deploy.

## What "agent-facing" means here

An operator typically runs `agent-deck` with no args (TUI), navigates sessions in the visual interface, and uses `agent-deck attach` to interact with the conductor. An agent has no TUI — it needs commands that return structured output (JSON, parseable tables, or raw file content). This document is the reference for those commands.

## Where things live on disk

When `march legate init` deploys a conductor, three trees on disk are populated:

```
~/.march/legate/<conductor-name>/                # staged copy (march-owned snapshot)
├── CLAUDE.md                                    # rendered conductor prompt
└── skills/<name>/                               # rendered skills, scripts copied

~/.agent-deck/conductor/<conductor-name>/        # conductor's cwd at runtime
├── CLAUDE.md                                    # same content, copied from staging
├── meta.json                                    # name, agent, profile, heartbeat config
├── state.json                                   # live slice tracking (see below)
├── heartbeat.sh                                 # generates the [HEARTBEAT] message
├── task-log.md                                  # append-only operator-facing log
├── LEARNINGS.md                                 # cross-heartbeat learnings the conductor writes
└── .claude/
    ├── settings.json                            # permission allow-list
    └── skills/legate.<name>/                    # deployed skill bundle

~/.agent-deck/profiles/<profile>/                # agent-deck profile DB
├── state.db                                     # sqlite: sessions, groups, watchers, heartbeats
├── state.db-shm
└── state.db-wal
```

The conductor's working directory is `~/.agent-deck/conductor/<conductor-name>/` — **not** the target repo. The conductor reaches into the target repo by path (`{{REPO_PATH}}`); its own cwd is its state directory. That's what makes `Read(./**)` / `Edit(./**)` / `Write(./**)` in `settings.json` safe: it scopes those grants to the conductor's state, not the repo.

## Inspecting conductor state programmatically

### List all conductors

```bash
agent-deck conductor list           # all profiles
agent-deck -p <profile> conductor list   # one profile
```

Plain-text output; pipe to `awk`/`grep` for filtering.

### Conductor health (including bridge + notifier daemons)

```bash
agent-deck conductor status                  # all conductors, both daemons
agent-deck conductor status <name>           # one conductor
agent-deck conductor status --json           # structured form (used by heartbeat.sh)
```

The `--json` form has a top-level `"enabled"` flag and per-conductor `"heartbeat": true|false` flags. `heartbeat.sh` checks the top-level `enabled` to no-op when heartbeats are globally disabled, and decides whether to fire based on the conductor session's status — see *Forcing a heartbeat* below.

### Session details

```bash
agent-deck -p <profile> list --json          # all sessions in profile
agent-deck -p <profile> session show <id-or-title> --json
```

`session show --json` is the canonical structured view: `status` (idle/waiting/running/error/stopped), `path`, `claude_session_id`, `tmux_session`, and the boolean lifecycle flags. Title prefix `conductor-` distinguishes conductors from workers.

### Reading session config that the CLI doesn't surface

Some fields (notably `extra_args`, `auto_mode`, `claude_session_id`) live inside a JSON blob in sqlite. The CLI commands above don't always print them. Direct SQL works:

```bash
sqlite3 ~/.agent-deck/profiles/<profile>/state.db \
  "SELECT title, command, tool_data FROM instances WHERE title LIKE '%conductor%';"
```

`tool_data` is a JSON blob with shape:

```json
{
  "claude_session_id": "uuid",
  "claude_detected_at": 1778459126,
  "latest_prompt": "...",
  "extra_args": ["--model", "sonnet"],
  "tool_options": {"tool": "claude", "options": {"auto_mode": true}}
}
```

Schema highlights for `instances` (sessions): `id, title, project_path, group_path, command, tool, status, tmux_session, created_at, last_accessed, parent_session_id, is_conductor, no_transition_notify, title_locked, worktree_path, worktree_repo, worktree_branch, tool_data, acknowledged`. Other tables: `groups, watchers, watcher_events, instance_heartbeats, recent_sessions, cost_events, metadata`.

**Gotcha**: each profile is its own sqlite DB. Don't write SELECT * across profiles — column order has shifted historically, and a positional read can mismap. Always use explicit column names.

### Reading the conductor's own state.json

```bash
cat ~/.agent-deck/conductor/<conductor-name>/state.json | jq .
```

Top-level shape:

```json
{
  "profile": "<profile>",
  "repo": {"name", "path", "default_branch", "owner_with_name"},
  "slices": {
    "<slice-id>": {
      "worker_session_id", "worker_title", "branch", "actual_branch",
      "worktree_path", "stage", "pr", "command", "arguments",
      "last_action", "last_action_note",
      "resume_pending"  // optional: "selected" once legate.resume has typed "1"
    }
  },
  "archived_slices": {"<slice-id>": {"pr_number", "pr_url", "worker_title", "terminal_state", "merged_at|closed_at"}},
  "last_smithy_status_at": "ISO8601",
  "last_heartbeat": "ISO8601"
}
```

`last_smithy_status_at` and `last_heartbeat` are useful sanity checks: if they're older than the last bridge-tick interval, the conductor is stalled (or the bridge is dead).

### Reading the conductor's TUI output

```bash
tmux capture-pane -t agentdeck_<title>_<hash> -p           # current screen
tmux capture-pane -t agentdeck_<title>_<hash> -pS -1000    # last 1000 lines of scrollback
```

The tmux session name is `agentdeck_<title>_<short-hash>` (visible via `tmux list-sessions` or `agent-deck session show --json` → `tmux_session`). agent-deck uses the **default tmux socket** (`/tmp/tmux-<uid>/default`), so `tmux list-sessions` from the same user works without `-L`.

## Forcing a heartbeat

The heartbeat script that the bridge would call is stored alongside the conductor:

```bash
bash ~/.agent-deck/conductor/<conductor-name>/heartbeat.sh
```

It:

1. Checks `agent-deck conductor status --json` for top-level `enabled: true` → exits 0 if disabled.
2. Checks the conductor session status — exits 0 silently only when the conductor is `running` (genuinely busy) or `stopped` (no tmux to deliver into) or status is empty (couldn't determine). Sends in all other cases including `idle`, `waiting`, and `error`. Sending on `error` is deliberate: agent-deck's classifier transiently flips a Claude session to `error` when the TUI has half-typed text or a stale spinner, and a fresh heartbeat usually unsticks it.
3. Pulls the worker session list, buckets by status, formats a `[HEARTBEAT] [<name>] Status: N waiting, N running, N idle, N error, N stopped.` line, and sends it via `agent-deck -p <profile> session send <target> ... --no-wait -q`.

**Previous behavior (fixed):** the gate used to be `case "$STATE" in idle|waiting) ;; *) exit 0 ;;`, which silently bailed on `error`. Conductors that transiently lapsed into `error` overnight got stranded — the heartbeat that would have unstuck them was the very thing the gate blocked. If you observe this regression returning, check the gate in `src/legate.ts:LEGATE_HEARTBEAT_SCRIPT_TEMPLATE`.

## Inspecting the dispatch loop's input

The dispatch skill consumes `find-ready-slices.sh`, deployed alongside the dispatch scripts. To see exactly what dispatch will consider on the next heartbeat:

```bash
bash ~/.agent-deck/conductor/<conductor-name>/.claude/skills/legate.dispatch/scripts/find-ready-slices.sh <repo-path>
```

Returns a JSON array of `{type, path, title, status, next_action}` objects — one per ready item. Empty array `[]` means nothing is ready (legitimate quiescent state). `next_action.command` is drawn from the closed set `{smithy.render, smithy.mark, smithy.cut, smithy.forge}`.

To see what `smithy status --graph` would say (the same data in a different shape):

```bash
(cd <repo-path> && smithy status --graph --no-color)
```

The "Layer 0 — ready to work" section enumerates dispatchable items. `find-ready-slices.sh` collapses additional non-L0 items that are still dispatchable (e.g. `smithy.render` on the parent RFC, because it doesn't depend on any in-flight forge/cut).

## Auto-mode pitfalls — things that pause the loop

The conductor runs under `--permission-mode auto`. The classifier auto-approves anything it recognizes as routine and pauses on anything that smells like arbitrary execution. Specific patterns to avoid in any new skill script:

- **Inline interpreters**: `python3 -c "..."`, `bash -c "..."`, `node -e "..."`, `perl -e "..."`. All flagged. Wrap the logic in an actual script file under `scripts/` and call that.
- **Symlinks pointing outside cwd**: classified as cross-boundary reads. The deploy uses copies, not symlinks, for this reason.
- **Writes outside the conductor's cwd**: `Write(<conductor-dir>/**)` is granted via `Write(./**)`, but writes to the target repo or other paths pause for approval. Workers do their own writes inside their own worktrees.
- **Destructive git ops**: `git reset --hard`, `git push --force-with-lease`, `git clean -fd`. Flagged. The conductor escalates instead of forcing.
- **`agent-deck session send` to a worker outside the resume/babysit/dispatch protocols**: only the deployed scripts (`send-to-worker.sh`, `nudge-resumed-worker.sh`, etc.) are allowed by name; direct `session send` invocations get classified as ad-hoc.
- **Any unallowed `Bash` pattern**: even read-only commands like `ls` on an unexpected path can pause. The settings.json allow-list is the source of truth; if a script needs a new pattern, add it there.

A single pause inside a heartbeat-driven loop wedges the conductor on operator approval until someone attaches and clears it. Treat any new script as "must run end-to-end without prompting".

## Heartbeat order is fixed

The CLAUDE.prompt loads skills in this order on every heartbeat:

1. `legate.resume` — clear any "Resume from summary" pickers before anything else tries to send keystrokes.
2. `legate.error` — handle opaque worker `error` sessions escalated by the processor or reported by agent-deck.
3. `legate.babysit` — handle existing PRs.
4. `legate.merge` — auto-squash-merge gated PRs from this tick.
5. `legate.cleanup` and the deterministic processor — sweep terminal PR slices into `archived_slices`, prune worktrees. The processor also mirrors the deterministic babysit subset: PR discovery/state refresh, first conflict prompts, review-thread `/smithy.fix`, and all-clear transitions. Failed CI, persistent conflicts, and opaque worker errors are escalated to the Legate conductor.
6. `legate.dispatch` — pick up new work. Runs every heartbeat regardless of what babysit found; iterates the entire ready set and launches one worker per ready slice that has no in-flight worker yet (no per-heartbeat cap on the number of new workers). See "Concurrency and dispatch behavior" below.

`legate.issue` is not in the heartbeat order; it's triggered by operator message.

## Concurrency and dispatch behavior

`legate.dispatch/SKILL.prompt` runs on **every** heartbeat regardless of what babysit found, and iterates over every ready item from `find-ready-slices.sh`. For each, it launches one worker if (a) all dependencies have merged, and (b) no existing entry in `state.json.slices` already claims that artifact. There is **no per-heartbeat dispatch cap** — the natural rate limit is the size of the ready set. If you see a conductor sit on a known-ready, unclaimed item across multiple heartbeats, the bug is in one of: dep-check (treating a merged PR as unmerged), the in-flight check (treating an escalated/archived slice as live), or `find-ready-slices.sh` (failing to surface the item).

Dispatch and agent-deck are decoupled: agent-deck can launch arbitrary workers; the conductor decides what to launch based on `smithy status` + `state.json` cross-reference.

## Where the deploy code lives

If you're changing what `march legate init` writes:

- `src/legate.ts` — the deploy flow (render, stage, copy, settings, agent-deck calls, bridge verify). Notable functions: `initLegate`, `copySkillIntoConductor`, `writeNarrowSettings`, `renderPrompt`, `deriveDefaults`.
- `src/legate.test.ts` — covers the deploy contract.
- `src/cli.ts:194+` — the `march legate` command group definition and its `init` subcommand.

The `--no-setup` flag in `march legate init` is the right tool for inspecting the rendered output without touching agent-deck.

## Useful one-liners

```bash
# Status of every legate conductor on the host
agent-deck conductor list

# Last heartbeat timestamp for a conductor
jq -r '.last_heartbeat' ~/.agent-deck/conductor/<name>/state.json

# Slices currently in flight (not archived) for a conductor
jq '.slices | to_entries | map({id: .key, stage: .value.stage, pr: .value.pr.number})' \
  ~/.agent-deck/conductor/<name>/state.json

# Workers in a profile (excluding the conductor itself)
agent-deck -p <profile> list --json \
  | jq '.sessions[] | select(.title | startswith("conductor-") | not)
                    | {title, group, status, id}'

# What dispatch would pick up next
bash ~/.agent-deck/conductor/<name>/.claude/skills/legate.dispatch/scripts/find-ready-slices.sh <repo-path>

# Tail conductor's tmux pane
tmux capture-pane -t "$(agent-deck -p <profile> session show conductor-<name> --json | jq -r .tmux_session)" -pS -200
```
