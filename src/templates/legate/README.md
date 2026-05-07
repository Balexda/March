# Mini-Legate Conductor Template

This directory ships the prompt that turns an [agent-deck](https://github.com/asheshgoplani/agent-deck) **conductor** into a per-repo **Legate** — a Claude Code session that drives the Smithy plan→implement→PR→fix loop on a single repository.

`CLAUDE.prompt` is the conductor's identity prompt. It is rendered with the values of the target repository by `march legate init` (see [`src/legate.ts`](../../legate.ts)) — `{{REPO_NAME}}`/`{{REPO_PATH}}`/`{{PROFILE}}`/`{{CONDUCTOR_NAME}}`/`{{WORKER_GROUP}}` are substituted, and any `{{>partial-name}}` includes are resolved against `snippets/` via [Dotprompt](https://www.npmjs.com/package/dotprompt) — into `~/.march/legate/<conductor-name>/CLAUDE.md` (a march-owned staged snapshot), then **copied** into `<conductor-dir>/CLAUDE.md`. Each skill under `skills/<name>/SKILL.prompt` is similarly rendered to `SKILL.md` and **copied** to `<conductor-dir>/.claude/skills/<name>/` along with its `scripts/`. We deliberately use copies rather than symlinks: Claude Code's `--permission-mode auto` classifier flags symlinks pointing outside cwd as cross-boundary reads and pauses on them, which stalls the heartbeat-driven loop. With copies, every read the conductor does stays inside its own cwd. The trade-off: editing the staged file no longer auto-propagates — operators iterate by editing the source template (`src/templates/legate/`), then re-running `march legate init`, which re-renders, re-copies, and restarts the conductor.

This README is **not** rendered or deployed — it stays here as developer-facing documentation of what the prompt is meant to do.

## What mini-legate is

Mini-legate is a precursor to the full Legate component described in March RFC `2026-001-march-orchestration-platform` (Milestone 5). It exists ahead of the M1–M4 infrastructure (Spawn, Hatchery, Brood, Herald) because Claude Code auto mode is reliable enough to handle most of Legate's reasoning today. It runs entirely on top of:

- `agent-deck conductor` for runtime, parent/child links, heartbeats, transition notifications.
- `smithy` CLI and skills for "what work to pick up next".
- `gh` CLI for high-level PR state.
- The `smithy.pr-review` skill for unresolved inline review threads.

There is no host-side spawn sandbox, no declarative profile system, no separate event bus, and no persistent session manager — those arrive with M1–M4. Mini-legate's interface to those concerns is whatever agent-deck provides today.

## Source layout

```
src/templates/legate/
├── CLAUDE.prompt                       ← conductor identity, loop skeleton, universal invariants
├── snippets/                           ← shared {{>partial}} fragments (state-json schema, status grammar, …)
└── skills/
    ├── legate.babysit/                 ← existing-PR mechanics
    │   ├── SKILL.prompt                ← decision tree, stage transitions, /smithy.fix composition
    │   └── scripts/                    ← babysit-pr, send-to-worker, request-rebase, …
    └── legate.dispatch/                ← new-work mechanics
        ├── SKILL.prompt                ← step boundaries, sync-then-launch protocol
        └── scripts/                    ← smithy-status, sync-default-branch, launch-worker, inspect-worker
```

## The two skills — mechanics layer

Mini-legate's *identity* (who I am, what I own, escalation rules, the loop skeleton) lives in `CLAUDE.prompt`. Its *mechanics* are split across two Claude Code skills, each deployed alongside CLAUDE.md into the conductor dir.

**`legate.babysit`** — existing-PR mechanics. Loaded first on every heartbeat. Owns the decision tree (`MERGED → CONFLICTING → FAIL → unresolved threads → all-clear`), stage transitions, and every script that mutates an existing PR via the worker that owns it.

| Operation | Script |
|---|---|
| List workers | `list-workers.sh <profile> <worker-group>` |
| Discover a worker's PR | `discover-pr.sh <profile> <session-id> <repo> [<since>]` |
| Babysit a PR | `babysit-pr.sh <repo> <pr-num>` |
| Send a fix message | `send-to-worker.sh <profile> <session-id> <msg-file>` |
| Request rebase (clean) | `request-rebase.sh <profile> <session-id> <worktree-path>` |
| Request conflict resolution | `request-conflict-resolution.sh <profile> <session-id> <worktree> <default-branch> <pr-num>` |
| Re-trigger CI | `rerun-ci.sh <repo> <run-id>` |
| Restart errored worker | `restart-worker.sh <profile> <session-id>` |

**`legate.dispatch`** — new-work mechanics. Loaded second on every heartbeat (only after babysit reports clean). Owns `smithy status` interpretation, default-branch sync, and the one-PR-per-step launch protocol. Operators can disable this skill on repos where the conductor should only manage existing PRs.

| Operation | Script |
|---|---|
| Refresh smithy status | `smithy-status.sh <repo-path>` |
| Sync default branch | `sync-default-branch.sh <repo-path>` |
| Launch worker for slice | `launch-worker.sh <profile> <repo> <title> <group> <branch> <verb-cmd>` |
| Inspect worker | `inspect-worker.sh <profile> <session-id-or-title>` |

Each script: `set -euo pipefail`, JSON to stdout, status to stderr, structured exit codes (0 success / 1 op-failure / 2 invalid input).

**Why two skills, not one?** Three reasons. (a) **Per-repo enablement** — disabling dispatch on a repo where the conductor should only watch existing PRs is a config flip rather than a prompt rewrite. (b) **Narrower `allowed-tools`** — each skill grants only its own scripts; an operator can audit one skill's surface area without paging through eight others. (c) **Side-effect locality** — dispatch is the only thing that mutates worktrees and creates new sessions; babysit is the only thing that touches existing PRs. Future skills (e.g. PR review, issue triage, merge) can be added without expanding either of these.

**Why a skill, not inline shell?** Claude Code's `--permission-mode auto` (which the conductor runs under) classifies inline `python3 -c "..."` and other ad-hoc patterns as arbitrary code execution and pauses for operator approval. A single such pause inside a heartbeat-driven loop stalls the orchestration. Skills self-declare permitted bash patterns via `allowed-tools` in their frontmatter, so when a legate skill is invoked, its scripts auto-approve as a unit.

## Snippets — shared fragments

`snippets/<name>.md` files are referenced from `.prompt` files via Handlebars partials: `{{>name}}`. At render time, Dotprompt inlines the snippet's content. The snippet itself is never deployed — only the rendered output is. This keeps universal invariants (state.json schema, escalation grammar, auto-mode rules, boundaries) in one place that both `CLAUDE.prompt` and the per-skill `SKILL.prompt` files consume. See [`snippets/README.md`](./snippets/README.md) for the current inventory and the conventions for adding more.

## Slice State Machine

Each Smithy slice the conductor picks up moves through this state machine. Triggers in italics; terminal states in **bold**.

```
              ┌──────────────────────────────────────┐
              │  smithy status picks next ready slice│
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
                 ┌─────────────────────────────────┐
                 │  SYNC                           │
                 │  fetch + switch + ff default    │  divergence
                 │  branch in {REPO_PATH}          │  ─────────▶  ESCALATED
                 └──────────────────┬──────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────┐
                 │  IMPLEMENTING                   │  worker errors
                 │  agent-deck launch              │  twice in a row
                 │    --worktree <branch> -b       │  ─────────▶  ERROR
                 │    --title-lock                 │
                 │  worker is `running`            │
                 └──────────────────┬──────────────┘
                                    │ transition: waiting
                                    │ + `gh pr list` confirms PR
                                    ▼
              ┌──────────────────────────────────────┐
              │  PR_OPEN                             │  reviews resolved
              │  watch CI                            │  + CI green
              │  watch reviews via smithy.pr-review  │  ──────────▶  **MERGED**
              │  watch comments via gh pr view       │   (operator merges,
              └──────────────────┬───────────────────┘    legate marks slice)
                                 │
              CI FAIL  ◀─────────┤────────▶  unresolved inline thread
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │  PR_IN_FIX                           │
              │  dispatch /smithy.fix to             │
              │  the slice's worker session          │
              │  (worker is `running` again)         │
              └──────────────────┬───────────────────┘
                                 │ worker → `waiting`,
                                 │ thread replies posted,
                                 │ new commits pushed
                                 │
                                 └────▶  back to PR_OPEN

         Operator can route any state to ESCALATED at any time.
         ESCALATED unblocks back into the same state on operator action.
```

### State definitions (mirrors `state.json`)

| Stage                      | Meaning                                                                                           |
|----------------------------|---------------------------------------------------------------------------------------------------|
| `planning`                 | Slice is being scoped via `/smithy.cut` etc., no PR yet.                                          |
| `implementing`             | Worker is running `/smithy.forge` (or equivalent) in its own worktree; no PR open yet.            |
| `pr-open`                  | PR has been opened by the worker. CI/reviews are running. No unresolved inline threads detected.  |
| `pr-in-fix`                | A `/smithy.fix` has been dispatched in response to CI failure or review feedback.                 |
| `pr-rebasing`              | A `request-rebase.sh` has been dispatched (clean rebase to pick up an upstream fix).              |
| `pr-in-rerun`              | `rerun-ci.sh` has been triggered for a transient flake.                                           |
| `pr-resolving-conflicts`   | A `request-conflict-resolution.sh` has been dispatched for a real merge conflict against default. |
| `merged`                   | PR is `MERGED`. Worktree is left on disk for operator cleanup until Brood (M3) ships.             |
| `escalated`                | Conductor has surfaced a `NEED:` to the operator; legate will not act on this slice until cleared.|

### What drives transitions

| Trigger                                       | Source                                                              |
|-----------------------------------------------|---------------------------------------------------------------------|
| Worker `running → waiting | error | idle`     | agent-deck transition notifier (`agent-deck notify-daemon`, PR #580) |
| Periodic re-scan of all workers + PRs         | agent-deck heartbeat (`[HEARTBEAT]` messages from the bridge)       |
| Operator instruction                          | Telegram/Slack message via the conductor bridge, or direct attach   |
| New commit on PR / CI completion / new review | discovered via `gh pr ...` during a heartbeat or transition wake-up |

The conductor never polls on its own schedule — heartbeats and transition notifications are the only timers.

## What's deployed and where

`march legate init` (run from inside a repo) does the following:

1. Detect repo basename → derive defaults: profile = repo slug, conductor name = `legate-<slug>`, worker group = `legate-workers`.
2. Render `src/templates/legate/CLAUDE.prompt` through Dotprompt: substitute `{{REPO_NAME}}` / `{{REPO_PATH}}` / `{{PROFILE}}` / `{{CONDUCTOR_NAME}}` / `{{WORKER_GROUP}}`, resolve `{{>partial}}` includes against `snippets/`.
3. Stage the rendered output at `~/.march/legate/<conductor-name>/CLAUDE.md` (stable, march-owned snapshot for inspection / debugging).
4. For each skill in `skills/<name>/`: render its `SKILL.prompt` (frontmatter preserved; body interpolated), stage at `~/.march/legate/<conductor-name>/skills/<name>/SKILL.md`, and copy its `scripts/` alongside. Wipes any previous staged copy first so scripts removed in a newer source template don't linger.
5. Run `agent-deck -p <profile> conductor setup <name> -description "..."` (no `-claude-md` — see below). agent-deck registers the conductor session, writes its default conductor `CLAUDE.md`, installs the heartbeat timer + bridge unit, and starts the session.
6. Copy the rendered CLAUDE.md and each staged skill directly into `<conductor-dir>/CLAUDE.md` and `<conductor-dir>/.claude/skills/<name>/` (replacing agent-deck's defaults and any prior symlinks/copies, including any legacy monolithic `<conductor-dir>/.claude/skills/legate/` from older deploys — Claude Code autoloads every dir under `.claude/skills/`, so a leftover legacy dir would shadow the new per-skill grants). **Why copies, not symlinks**: Claude Code's `--permission-mode auto` classifier flags symlink reads pointing outside cwd as cross-boundary access and pauses on them, which stalls the heartbeat-driven loop.
7. Write `<conductor-dir>/.claude/settings.json` with a narrow allow list: `Skill(legate.babysit:*)` and `Skill(legate.dispatch:*)` (per-skill grants), per-script `Bash(...)` allows that mirror each skill's `allowed-tools` (belt-and-suspenders for first-call classifier behavior), `Read(./**)` / `Edit(./**)` / `Write(./**)` for cwd-scoped state updates, and read-only `Bash(agent-deck * session show *)` / `... list *` / `... status *` patterns so a future direct invocation doesn't stall (the dispatch skill's `inspect-worker.sh` covers the common case but the underlying read patterns being allowed is cheap insurance). Deliberately *not* in this list: `Bash(*)`, `Read(*)`, `Edit(*)`, `Write(*)`, or any tool-wide wildcard — those would be a permission bypass.
8. `agent-deck session set conductor-<name> auto-mode true` to put the conductor into Claude Code's `--permission-mode auto`, then `agent-deck session set conductor-<name> extra-args -- --model <model>` to pin the model (default: `sonnet`; override with `march legate init --model <id>`), then `session restart` so both flags take effect immediately. The conductor's role is orchestration-heavy / reasoning-light — Sonnet is intentionally chosen as the default; workers stay on the Claude default for real implementation work.
9. (Linux/WSL2) `systemctl --user start agent-deck-conductor-bridge` and verify with `systemctl --user is-active --quiet agent-deck-conductor-bridge`. agent-deck installs and tries to enable+start this systemd unit during conductor setup, but a successful unit install does not guarantee a healthy daemon — `march legate init` re-asserts the start and verifies, so a crash-loop (e.g. a Python 3.8 host trying to run a bridge.py that uses Python 3.9 generics) is surfaced immediately rather than silently leaving the conductor inert.

After that, the iteration loop is: edit any of the source files (`CLAUDE.prompt`, `snippets/*.md`, `skills/<name>/SKILL.prompt`, or `skills/<name>/scripts/*.sh`), then re-run `march legate init` from inside the same repo. That re-renders, re-stages, re-copies, re-writes settings, and restarts the conductor in one shot.

### Why bridge-start matters

The conductor's only autonomous trigger is `[HEARTBEAT]` messages. The agent-deck bridge daemon (`~/.agent-deck/conductor/bridge.py`, run as `agent-deck-conductor-bridge.service` on Linux/WSL2 or `com.agentdeck.conductor-bridge` launchd plist on macOS) is what generates those messages on a configurable cadence (default 15 min) and forwards them into the conductor's tmux session via `agent-deck session send`. With the bridge stopped, the conductor sits in `waiting` indefinitely — healthy but inert. Manual `agent-deck session send` is the fallback.

**Python version requirement (host-level):** agent-deck's `bridge.py` uses PEP 585 generic builtins (`list[dict]`, `dict[str, Any]`), which require Python 3.9 or newer. On hosts whose default `python3` is 3.8 or older (Ubuntu 20.04 / WSL2's stock image, for example), the bridge will crash on import and systemd will retry until it gives up, even though the unit shows as "loaded". `march legate init` will surface this as a `Bridge daemon: NOT active` warning with the log path so the operator can either install Python 3.9+ or fall back to manual heartbeats.

## Permission mode — how it's wired

The conductor runs under Claude Code's `--permission-mode auto`, layered with two levels of scoped pre-approval:

**Level 1 — conductor session permission mode** (set via agent-deck). The `auto_mode` key on the global `[claude]` block in `~/.agent-deck/config.toml` would put *every* Claude session on the host into auto mode (per `internal/session/userconfig.go:653`); group and conductor TOML blocks only carry `config_dir` / `env_file`, not permission keys. To scope auto mode to *just* this conductor, `march legate init` mutates the conductor's Instance directly:

```
agent-deck -p <profile> session set conductor-legate-<slug> auto-mode true
```

This flips `ClaudeOptions.AutoMode` and agent-deck's launcher emits `--permission-mode auto` on every start/restart. Workers go through the per-launch `--extra-arg --permission-mode --extra-arg auto` path because there is no `--auto-mode` flag on `agent-deck launch`. The `auto-mode` field is preferred over `extra-args -- --permission-mode auto` so a future inspection via `agent-deck session show` reports auto mode as a structured field rather than an opaque token list, and to dodge a misleading agent-deck CLI success-message bug that prints only the first positional arg.

**Level 2 — narrow allow list in the conductor's project settings**. `<conductor-dir>/.claude/settings.json` (written by `march legate init`) pre-approves exactly what the two skills need and nothing else:

```json
{
  "permissions": {
    "allow": [
      "Skill(legate.babysit:*)",
      "Skill(legate.dispatch:*)",
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)",
      "Bash(.claude/skills/legate.babysit/scripts/babysit-pr.sh *)",
      "Bash(.claude/skills/legate.dispatch/scripts/launch-worker.sh *)",
      "...one Bash(...) entry per deployed script...",
      "Bash(agent-deck * session show *)",
      "Bash(agent-deck * list *)",
      "Bash(agent-deck * status *)"
    ]
  }
}
```

The `Skill(legate.<name>:*)` lines authorize invoking each skill. Each skill's own `SKILL.md` frontmatter declares `allowed-tools: Bash(.claude/skills/legate.<name>/scripts/<each>:*)` — but in practice that grant doesn't always propagate to the auto-mode classifier on the conductor's first bash call after `Skill(...)`. The per-script `Bash(...)` lines in this settings file are belt-and-suspenders that close the gap.

The `Bash(agent-deck * session show *)` / `... list *` / `... status *` lines are a separate belt-and-suspenders layer for direct read invocations. The dispatch skill's `inspect-worker.sh` covers the common case (post-launch session detail capture); allowing the underlying read patterns means a future ad-hoc invocation doesn't stall the heartbeat loop on a permission prompt — a failure mode that historically locked the live conductor for hours.

`Read(./**)` / `Edit(./**)` / `Write(./**)` are cwd-scoped — the conductor's cwd is its own dir, so it can update `state.json`, `task-log.md`, `LEARNINGS.md`, and any additional notes it judges useful, without prompting on every write. Reads of files outside cwd are *not* granted; auto-mode still gates those.

Deliberately *not* in the allow list: `Bash(*)`, `Read(*)`, `Edit(*)`, `Write(*)`, or any tool-wide wildcard. Those would be a permission bypass dressed as a fix; this allow list is the operationalization of the operator's choice to use the legate skill.

**Permission-key reference** (agent-deck flags + Claude Code precedence):

| Key / extra-arg                       | Maps to                                    | Use it when                                                       |
|---------------------------------------|--------------------------------------------|-------------------------------------------------------------------|
| `--permission-mode auto`              | classifier auto-approval                   | **Default for mini-legate.** Routine ops auto-approve.            |
| `--allow-dangerously-skip-permissions`| opt-in to yolo via `/dangerous` mid-session| When the operator wants to flip on yolo manually for one session. |
| `--dangerously-skip-permissions`      | yolo (overrides auto)                      | Escape valve for a slice that keeps stalling on auto mode.        |

Mini-legate prefers auto mode everywhere. The conductor escalates via a `NEED:` note when it hits a permission prompt rather than reaching for `dangerous_mode` — the auto classifier surfacing an approval prompt is itself a signal that the action deserves operator review.

If the conductor or a worker is missing the `--permission-mode auto` extra-arg (e.g. operator manually cleared it), the conductor will escalate on its first heartbeat after detection rather than silently stalling.

## Boundaries — what mini-legate will not do

- **No cross-repo work.** A conductor manages exactly one repo. The operator runs `march legate init` per repo; each gets its own conductor name (`legate-<slug>`) so they coexist in agent-deck's system-wide conductor namespace.
- **No autonomous merges.** Merging a PR is the operator's call; the conductor's role ends at "PR is green and reviewed".
- **No worktree cleanup.** Worktrees created by `--worktree -b` accumulate on disk after merges. Brood (M3) will own this; until then, the operator reclaims disk manually.
- **No force-pushes, no resets, no destructive git ops.** If `git pull --ff-only origin <default>` fails, the conductor escalates instead of forcing.
- **No re-planning of operator-approved slices** without explicit operator instruction.

## Future work that this precursor explicitly omits

- **Sandboxing** — workers run in real worktrees on the operator's host. Spawn (M1) will move them into restricted Docker containers.
- **Profile-driven security posture** — Hatchery (M2) will let different roles get different permissions; today everything is operator-trust.
- **Lifecycle management** — Brood (M3) will own worktree/branch/container cleanup at slice end.
- **Event-driven coordination** — Herald (M4) will push spawn-completion / CI / review events through a deterministic bus instead of relying on agent-deck heartbeats and `gh` polling.
- **Cross-issue dispatch** — "fix issue #123" → look up the GitHub issue, dispatch a worker — is a feature being tracked separately, not part of this precursor.

When those components ship, the conductor's interface will change (the launch command, the wait mechanism, the worker-state model) but the slice state machine drawn above should remain stable.
