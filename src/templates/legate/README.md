# Mini-Legate Conductor Template

This directory ships the prompt that turns an [agent-deck](https://github.com/asheshgoplani/agent-deck) **conductor** into a per-repo **Legate** — a Claude Code session that drives the Smithy plan→implement→PR→fix loop on a single repository.

`CLAUDE.md` is the conductor's identity prompt. It is rendered with the values of the target repository by `march legate init` (see [`src/legate.ts`](../../legate.ts)) into `~/.march/legate/<conductor-name>/CLAUDE.md` (a march-owned staged snapshot), then **copied** into `<conductor-dir>/CLAUDE.md`. The skill in `skill/` is similarly staged and **copied** to `<conductor-dir>/.claude/skills/legate/`. We deliberately use copies rather than symlinks: Claude Code's `--permission-mode auto` classifier flags symlinks pointing outside cwd as cross-boundary reads and pauses on them, which stalls the heartbeat-driven loop. With copies, every read the conductor does stays inside its own cwd. The trade-off: editing the staged file no longer auto-propagates — operators iterate by editing the source template (`src/templates/legate/`), then re-running `march legate init`, which re-renders, re-copies, and restarts the conductor.

This README is **not** rendered or deployed — it stays here as developer-facing documentation of what the prompt is meant to do.

## What mini-legate is

Mini-legate is a precursor to the full Legate component described in March RFC `2026-001-march-orchestration-platform` (Milestone 5). It exists ahead of the M1–M4 infrastructure (Spawn, Hatchery, Brood, Herald) because Claude Code auto mode is reliable enough to handle most of Legate's reasoning today. It runs entirely on top of:

- `agent-deck conductor` for runtime, parent/child links, heartbeats, transition notifications.
- `smithy` CLI and skills for "what work to pick up next".
- `gh` CLI for high-level PR state.
- The `smithy.pr-review` skill for unresolved inline review threads.

There is no host-side spawn sandbox, no declarative profile system, no separate event bus, and no persistent session manager — those arrive with M1–M4. Mini-legate's interface to those concerns is whatever agent-deck provides today.

## The `legate` skill — mechanics layer

Mini-legate's *identity* (who I am, what I own, escalation rules, the loop) lives in `CLAUDE.md`. Its *mechanics* (the actual command sequences) live in a Claude Code skill at `skill/`, which is deployed alongside CLAUDE.md into the conductor dir as `<conductor-dir>/.claude/skills/legate/`.

Six audited bash scripts back the operations:

| Operation | Script | When the conductor uses it |
|---|---|---|
| Sync default branch | `sync-default-branch.sh <repo-path>` | Before any new-work dispatch |
| List workers | `list-workers.sh <profile> <worker-group>` | Every heartbeat (inventory) |
| Launch worker for slice | `launch-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <verb-cmd>` | Dispatching new cuts/forges |
| Discover PR for worker | `discover-pr.sh <profile> <session-id> <repo-path> [<since>]` | When a worker hits `waiting`; resilient to `/smithy.*` branch renames (see [SmithyCLI#297](https://github.com/Balexda/SmithyCLI/issues/297)) |
| Babysit PR | `babysit-pr.sh <repo-path> <pr-num>` | Every heartbeat for each tracked PR |
| Refresh smithy status | `smithy-status.sh <repo-path>` | Loop step 1 (pick next work) |

Each script: `set -euo pipefail`, JSON to stdout, status to stderr, structured exit codes (0 success / 1 op-failure / 2 invalid input).

**Why a skill, not inline shell?** Claude Code's `--permission-mode auto` (which the conductor runs under) classifies inline `python3 -c "..."` and other ad-hoc patterns as arbitrary code execution and pauses for operator approval. A single such pause inside a heartbeat-driven loop stalls the orchestration. Skills self-declare permitted bash patterns via `allowed-tools` in their frontmatter, so when the legate skill is invoked, its scripts auto-approve as a unit — no per-script settings.json bash entries needed.

The skill's `allowed-tools` line:

```yaml
allowed-tools: Bash(*/legate/scripts/sync-default-branch.sh:*) Bash(*/legate/scripts/list-workers.sh:*) Bash(*/legate/scripts/launch-worker.sh:*) Bash(*/legate/scripts/discover-pr.sh:*) Bash(*/legate/scripts/babysit-pr.sh:*) Bash(*/legate/scripts/smithy-status.sh:*)
```

`SKILL.md`'s description was tuned via skill-creator's optimization loop (see `skill-workspace/optimization-report.html` for the iteration-by-iteration trigger-rate metrics).

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

| Stage           | Meaning                                                                                           |
|-----------------|---------------------------------------------------------------------------------------------------|
| `planning`      | Slice is being scoped via `/smithy.cut` etc., no PR yet.                                          |
| `implementing`  | Worker is running `/smithy.forge` (or equivalent) in its own worktree; no PR open yet.            |
| `pr-open`       | PR has been opened by the worker. CI/reviews are running. No unresolved inline threads detected. |
| `pr-in-fix`     | A `/smithy.fix` has been dispatched in response to CI failure or review feedback.                |
| `merged`        | PR is `MERGED`. Worktree is left on disk for operator cleanup until Brood (M3) ships.            |
| `escalated`     | Conductor has surfaced a `NEED:` to the operator; legate will not act on this slice until cleared.|

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
2. Render `src/templates/legate/CLAUDE.md` with `{REPO_NAME}` / `{REPO_PATH}` / `{PROFILE}` / `{CONDUCTOR_NAME}` / `{WORKER_GROUP}` substitutions.
3. Stage the rendered template at `~/.march/legate/<conductor-name>/CLAUDE.md` (stable, march-owned snapshot for inspection / debugging).
4. Stage the skill at `~/.march/legate/<conductor-name>/skill/` — wipes any previous staged copy first so scripts removed in a newer source template don't linger, then copies `SKILL.md` and the six executable scripts.
5. Run `agent-deck -p <profile> conductor setup <name> -description "..."` (no `-claude-md` — see below). agent-deck registers the conductor session, writes its default conductor `CLAUDE.md`, installs the heartbeat timer + bridge unit, and starts the session.
6. Copy the rendered CLAUDE.md and the staged skill directly into `<conductor-dir>/CLAUDE.md` and `<conductor-dir>/.claude/skills/legate/` (replacing agent-deck's defaults and any prior symlinks/copies). **Why copies, not symlinks**: Claude Code's `--permission-mode auto` classifier flags symlink reads pointing outside cwd as cross-boundary access and pauses on them, which stalls the heartbeat-driven loop. With copies, every read the conductor does stays inside its own cwd → no classifier pause → no stall.
7. Write `<conductor-dir>/.claude/settings.json` with a narrow allow list scoped to legate: `Skill(legate:*)` (authorizes invoking the skill, which cascades into the bash patterns the skill self-declares via `allowed-tools`), plus `Read(./**)` / `Edit(./**)` / `Write(./**)` so the conductor can update `state.json`, `task-log.md`, `LEARNINGS.md`, and any working notes within its own cwd. Deliberately *not* in this list: `Bash(*)`, `Read(*)`, `Edit(*)`, `Write(*)`, or any tool-wide wildcard — those would be a permission bypass.
8. `agent-deck session set conductor-<name> auto-mode true` to put the conductor into Claude Code's `--permission-mode auto`, then `agent-deck session set conductor-<name> extra-args -- --model <model>` to pin the model (default: `sonnet`; override with `march legate init --model <id>`), then `session restart` so both flags take effect immediately. The conductor's role is orchestration-heavy / reasoning-light — Sonnet is intentionally chosen as the default; workers stay on the Claude default for real implementation work.
9. (Linux/WSL2) `systemctl --user start agent-deck-conductor-bridge` and verify with `systemctl --user is-active --quiet agent-deck-conductor-bridge`. agent-deck installs and tries to enable+start this systemd unit during conductor setup, but a successful unit install does not guarantee a healthy daemon — `march legate init` re-asserts the start and verifies, so a crash-loop (e.g. a Python 3.8 host trying to run a bridge.py that uses Python 3.9 generics) is surfaced immediately rather than silently leaving the conductor inert.

After that, the iteration loop is: edit the source template (`src/templates/legate/CLAUDE.md`, `skill/SKILL.md`, or `skill/scripts/*.sh`), then re-run `march legate init` from inside the same repo. That re-renders, re-stages, re-copies, re-writes settings, and restarts the conductor in one shot.

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

**Level 2 — narrow allow list in the conductor's project settings**. `<conductor-dir>/.claude/settings.json` (written by `march legate init`) pre-approves exactly what the legate loop needs and nothing else:

```json
{
  "permissions": {
    "allow": [
      "Skill(legate:*)",
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)"
    ]
  }
}
```

`Skill(legate:*)` authorizes invoking the legate skill. The skill's own SKILL.md frontmatter declares `allowed-tools: Bash(*/legate/scripts/<each>:*)`, so granting the skill cascades into per-script bash approval — there's no need for per-script `Bash(...)` entries in this settings file.

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
