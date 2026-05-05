# Mini-Legate Conductor Template

This directory ships the prompt that turns an [agent-deck](https://github.com/asheshgoplani/agent-deck) **conductor** into a per-repo **Legate** — a Claude Code session that drives the Smithy plan→implement→PR→fix loop on a single repository.

`CLAUDE.md` is the conductor's identity prompt. It is rendered with the values of the target repository by `march legate init` (see [`src/legate.ts`](../../legate.ts)) into `~/.march/legate/<conductor-name>/CLAUDE.md`, then `agent-deck conductor setup --claude-md <path>` symlinks the conductor's own `CLAUDE.md` to that file. Editing the rendered template and restarting the conductor is the operator's iteration loop.

This README is **not** rendered or deployed — it stays here as developer-facing documentation of what the prompt is meant to do.

## What mini-legate is

Mini-legate is a precursor to the full Legate component described in March RFC `2026-001-march-orchestration-platform` (Milestone 5). It exists ahead of the M1–M4 infrastructure (Spawn, Hatchery, Brood, Herald) because Claude Code auto mode is reliable enough to handle most of Legate's reasoning today. It runs entirely on top of:

- `agent-deck conductor` for runtime, parent/child links, heartbeats, transition notifications.
- `smithy` CLI and skills for "what work to pick up next".
- `gh` CLI for high-level PR state.
- The `smithy.pr-review` skill for unresolved inline review threads.

There is no host-side spawn sandbox, no declarative profile system, no separate event bus, and no persistent session manager — those arrive with M1–M4. Mini-legate's interface to those concerns is whatever agent-deck provides today.

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
3. Stage the rendered template at `~/.march/legate/<conductor-name>/CLAUDE.md` (stable, march-owned path).
4. Run `agent-deck -p <profile> conductor setup <name> -description "..." -claude-md <staged path>`. agent-deck symlinks the conductor's own `CLAUDE.md` to the staged file, registers the conductor session, and starts it.

After that, editing `~/.march/legate/<conductor-name>/CLAUDE.md` (or re-running `march legate init` after editing the source template) and `agent-deck session restart conductor-<name>` is the iteration loop.

## Permission mode — how it's wired

agent-deck only exposes the `auto_mode` key on the global `[claude]` block (see `internal/session/userconfig.go:653`). `[groups.<name>.claude]` and `[conductors.<name>.claude]` only carry `config_dir` and `env_file`. Setting `[claude] auto_mode = true` globally would put **every** Claude session on the host into auto mode — too broad for a per-repo legate.

To scope auto mode to legate's own conductor + its workers without affecting unrelated sessions, mini-legate uses agent-deck's per-session `extra-args` mechanism, which persists CLI flags on the Instance and re-applies them on every start/restart:

- **Conductor** — `march legate init` runs, after `agent-deck conductor setup`:
  ```
  agent-deck -p <profile> session set conductor-legate-<slug> extra-args -- --permission-mode auto
  agent-deck -p <profile> session restart conductor-legate-<slug>
  ```
  No operator action required; this is part of the deploy.

- **Workers** — the conductor's CLAUDE.md tells legate to include `--extra-arg --permission-mode --extra-arg auto` on every `agent-deck launch` for a worker. agent-deck stores those tokens on `Instance.ExtraArgs` and re-applies them on restart, so the auto-mode flag survives session lifecycle events.

agent-deck exposes three claude permission keys / flags with a fixed precedence (`userconfig.go`):

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
