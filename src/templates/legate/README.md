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
    ├── legate.resume/                  ← worker session-restart recovery
    │   ├── SKILL.prompt                ← picker detection, two-tick handshake, stage-aware nudge
    │   └── scripts/                    ← check-resume-prompt, select-resume-summary, nudge-resumed-worker
    ├── legate.babysit/                 ← existing-PR mechanics
    │   ├── SKILL.prompt                ← decision tree, stage transitions, /smithy.fix composition
    │   └── scripts/                    ← babysit-pr, send-to-worker, request-rebase, …
    ├── legate.merge/                   ← auto-squash-merge under a strict gate
    │   ├── SKILL.prompt                ← gate conditions, per-candidate readiness check, squash-merge
    │   └── scripts/                    ← check-merge-readiness, squash-merge-pr
    ├── legate.cleanup/                 ← post-merge teardown
    │   ├── SKILL.prompt                ← merged-slice sweep, archive bookkeeping
    │   └── scripts/                    ← cleanup-merged-session, fetch-default-branch
    ├── legate.dispatch/                ← new-work mechanics (smithy status)
    │   ├── SKILL.prompt                ← step boundaries, sync-then-launch protocol
    │   └── scripts/                    ← smithy-status, sync-default-branch, launch-worker, inspect-worker
    └── legate.issue/                   ← operator-driven GitHub-issue intake
        ├── SKILL.prompt                ← parse → fetch → sync → launch → record protocol
        └── scripts/                    ← fetch-issue, sync-default-branch, launch-issue-worker
```

## The six skills — mechanics layer

Mini-legate's *identity* (who I am, what I own, escalation rules, the loop skeleton) lives in `CLAUDE.prompt`. Its *mechanics* are split across six Claude Code skills, each deployed alongside CLAUDE.md into the conductor dir.

**`legate.resume`** — worker session-restart recovery. Loaded **first** on every heartbeat. When a worker's Claude Code TUI restarts (after `restart-worker.sh`, after agent-deck restarts the session, after a host reboot, etc.) and Claude shows its "Resume from summary" picker, this skill detects the picker via `check-resume-prompt.sh`, types `"1"` via `select-resume-summary.sh` to select option 1 (recommended), and marks the slice `resume_pending = "selected"` in `state.json`. On a subsequent heartbeat (once the worker is back in `waiting` with the summary loaded), it composes a stage-aware nudge and delivers it via `nudge-resumed-worker.sh`, then clears the flag. Other skills skip any `resume_pending` slice for the rest of that heartbeat — a half-cleared picker silently swallows `agent-deck session send` keystrokes.

| Operation | Script |
|---|---|
| Detect the resume picker in worker output | `check-resume-prompt.sh <profile> <session-id-or-title>` |
| Select "Resume from summary" (option 1) | `select-resume-summary.sh <profile> <session-id-or-title>` |
| Send the post-resume nudge | `nudge-resumed-worker.sh <profile> <session-id-or-title> <msg-file>` |

**`legate.babysit`** — existing-PR mechanics. Loaded after resume on every heartbeat. Owns the decision tree (`MERGED → CONFLICTING → FAIL → unresolved threads → all-clear`), stage transitions, and every script that mutates an existing PR via the worker that owns it.

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

**`legate.merge`** — auto-squash-merge under a strict gate. Loaded after babysit and before cleanup on every heartbeat. For each slice that babysit has placed in `pr-open` this heartbeat, it runs `check-merge-readiness.sh` and applies the gate (all CI checks PASS, no merge conflicts, GitHub `mergeStateStatus == clean`, ≥1 human approval, 0 outstanding CHANGES_REQUESTED). Only when every condition clears does it call `squash-merge-pr.sh` (with `--match-head-commit` to defeat any race against a worker push) and transition the slice to `merged`. Every gate failure surfaces as a `NEED:` line so the operator decides whether to merge under relaxed-rules cases — the gate is conservative-by-design and there is no override flag. Operators who want every merge human-driven can omit this skill from their conductor's deployment.

| Operation | Script |
|---|---|
| Check merge readiness | `check-merge-readiness.sh <repo-path> <pr-num>` |
| Squash-merge a gated PR | `squash-merge-pr.sh <repo-path> <pr-num> <head-sha>` |

**`legate.cleanup`** — post-merge teardown. Loaded after merge and before dispatch on every heartbeat. Sweeps every slice in `state.json` whose `stage == "merged"` (set either by babysit on a human-driven merge or by `legate.merge` on an auto-merge): removes the worker session via `agent-deck session remove --prune-worktree --force` (one command stops the tmux process, prunes the git worktree, and drops the registry entry), moves the slice from `slices` into `archived_slices` (so dispatch's dep-check still sees the merge), appends a task-log entry, and — if at least one slice was cleaned — fetches origin/<default> so the next dispatch in the same heartbeat sees fresh refs. No-op when zero slices are merged.

| Operation | Script |
|---|---|
| Remove a merged slice's worker session + worktree | `cleanup-merged-session.sh <profile> <session-id> <slice-id>` |
| Fetch origin/<default> after cleanup | `fetch-default-branch.sh <repo-path>` |

**`legate.dispatch`** — new-work mechanics from `smithy status`. Loaded last on every heartbeat (only after babysit reports clean). Owns `smithy status` interpretation, default-branch sync, and the one-PR-per-step launch protocol. Operators can disable this skill on repos where the conductor should only manage existing PRs. Dispatch's dep-check consults both `slices` and `archived_slices`, so a merged predecessor is visible even after cleanup has swept it.

| Operation | Script |
|---|---|
| Refresh smithy status | `smithy-status.sh <repo-path>` |
| Sync default branch | `sync-default-branch.sh <repo-path>` |
| Launch worker for slice | `launch-worker.sh <profile> <repo> <title> <group> <branch> <verb-cmd>` |
| Inspect worker | `inspect-worker.sh <profile> <session-id-or-title>` |

**`legate.issue`** — operator-driven GitHub-issue intake. **Not** loaded on a heartbeat — invoked when the operator hands the conductor an issue reference (`issue 42`, `issue #42`, an issue URL, optionally with a trailing context note). Fetches the issue via `gh`, syncs the default branch, and launches a worker whose initial prompt is the issue body + operator notes + a job description (investigate → implement → push → open a PR with `Closes #<N>`). Records the work in `state.json.slices` as `issue-<N>` with `kind: "issue"`, after which `legate.babysit` and `legate.cleanup` track the resulting PR identically to a Smithy slice. One worker per issue (idempotent on a live `issue-<N>` slice). Operators can disable this skill on repos where the conductor should not accept issue intake.

| Operation | Script |
|---|---|
| Fetch a GitHub issue's full detail | `fetch-issue.sh <repo-path> <issue-number>` |
| Sync default branch | `sync-default-branch.sh <repo-path>` |
| Launch worker for issue | `launch-issue-worker.sh <profile> <repo> <title> <group> <branch> <prompt-file>` |

Each script: `set -euo pipefail`, JSON to stdout, status to stderr, structured exit codes (0 success / 1 op-failure / 2 invalid input).

**Why six skills, not one?** Three reasons. (a) **Per-repo enablement** — disabling dispatch (or issue intake, or merge) on a repo where the conductor should only watch existing PRs, or where every merge should be human-driven, is a config flip rather than a prompt rewrite. Resume and cleanup are non-disable-able because (a) leaving a stuck "Resume from summary" picker in place wedges the worker indefinitely and (b) leaving merged worker sessions in place is what motivates cleanup. (b) **Narrower `allowed-tools`** — each skill grants only its own scripts; an operator can audit one skill's surface area without paging through fifteen others. (c) **Side-effect locality** — resume is the only thing that types raw TUI input into a worker session; dispatch and issue are the two things that create new worker sessions, and they live in separate skills because their *triggers* are different (heartbeat-driven smithy-status pickup vs. operator-handed issue reference); merge is the only thing that calls `gh pr merge`; cleanup is the only thing that destroys worker sessions; babysit is the only thing that touches existing PRs. Future skills (e.g. PR review, scheduled retries) can be added without expanding any of these.

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
              │  PR_OPEN                             │  CI green + no conflicts
              │  watch CI                            │  + mergeStateStatus=clean
              │  watch reviews via smithy.pr-review  │  + ≥1 human approval +
              │  watch comments via gh pr view       │  0 outstanding CR
              └──────────────────┬───────────────────┘  ──────────▶  MERGED  ─▶  **ARCHIVED**
                                                          (legate.merge auto-     (cleanup removes
                                                           merges OR operator     worker + worktree;
                                                           merges in UI; either   slice moves into
                                                           way babysit/merge      archived_slices)
                                                           marks slice merged)
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
| `merged`                   | PR is `MERGED`. Cleanup will sweep the slice on the same heartbeat: worker session removed, worktree pruned, slice moved into `archived_slices`. |
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
7. Write `<conductor-dir>/.claude/settings.json` with a narrow allow list: `Skill(legate.resume:*)`, `Skill(legate.babysit:*)`, `Skill(legate.merge:*)`, `Skill(legate.cleanup:*)`, `Skill(legate.dispatch:*)`, and `Skill(legate.issue:*)` (per-skill grants), per-script `Bash(...)` allows that mirror each skill's `allowed-tools` (belt-and-suspenders for first-call classifier behavior), `Read(./**)` / `Edit(./**)` / `Write(./**)` for cwd-scoped state updates, and read-only `Bash(agent-deck * session show *)` / `... list *` / `... status *` patterns so a future direct invocation doesn't stall (the dispatch skill's `inspect-worker.sh` covers the common case but the underlying read patterns being allowed is cheap insurance). Deliberately *not* in this list: `Bash(*)`, `Read(*)`, `Edit(*)`, `Write(*)`, or any tool-wide wildcard — those would be a permission bypass.
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

**Level 2 — narrow allow list in the conductor's project settings**. `<conductor-dir>/.claude/settings.json` (written by `march legate init`) pre-approves exactly what the six skills need and nothing else:

```json
{
  "permissions": {
    "allow": [
      "Skill(legate.resume:*)",
      "Skill(legate.babysit:*)",
      "Skill(legate.merge:*)",
      "Skill(legate.cleanup:*)",
      "Skill(legate.dispatch:*)",
      "Skill(legate.issue:*)",
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)",
      "Bash(.claude/skills/legate.resume/scripts/check-resume-prompt.sh *)",
      "Bash(.claude/skills/legate.resume/scripts/select-resume-summary.sh *)",
      "Bash(.claude/skills/legate.resume/scripts/nudge-resumed-worker.sh *)",
      "Bash(.claude/skills/legate.babysit/scripts/babysit-pr.sh *)",
      "Bash(.claude/skills/legate.merge/scripts/check-merge-readiness.sh *)",
      "Bash(.claude/skills/legate.merge/scripts/squash-merge-pr.sh *)",
      "Bash(.claude/skills/legate.cleanup/scripts/cleanup-merged-session.sh *)",
      "Bash(.claude/skills/legate.dispatch/scripts/launch-worker.sh *)",
      "Bash(.claude/skills/legate.issue/scripts/launch-issue-worker.sh *)",
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
- **No autonomous merges under relaxed rules.** `legate.merge` will squash-merge a PR only when *all* of: the PR is `OPEN`, has no merge conflicts (`mergeable == MERGEABLE`), all CI checks pass, GitHub `mergeStateStatus == clean`, ≥1 human (non-bot) APPROVED review, and 0 outstanding CHANGES_REQUESTED reviews — applied to a slice already in `stage == "pr-open"`. Any condition unmet is surfaced as a `NEED:` so the operator decides whether to merge under their repo's relaxed rules; the conductor never bypasses the gate. Operators who want every merge human-driven can omit `legate.merge` from their conductor entirely.
- **No worktree cleanup.** Worktrees created by `--worktree -b` accumulate on disk after merges. Brood (M3) will own this; until then, the operator reclaims disk manually.
- **No force-pushes, no resets, no destructive git ops.** If `git pull --ff-only origin <default>` fails, the conductor escalates instead of forcing.
- **No re-planning of operator-approved slices** without explicit operator instruction.

## Future work that this precursor explicitly omits

- **Sandboxing** — workers run in real worktrees on the operator's host. Spawn (M1) will move them into restricted Docker containers.
- **Profile-driven security posture** — Hatchery (M2) will let different roles get different permissions; today everything is operator-trust.
- **Lifecycle management** — Brood (M3) will own worktree/branch/container cleanup at slice end.
- **Event-driven coordination** — Herald (M4) will push spawn-completion / CI / review events through a deterministic bus instead of relying on agent-deck heartbeats and `gh` polling.
- **Cross-repo work** — a single conductor manages a single repo. `march legate init` per repo; future routing of an issue cross-repo is a Hatchery (M2) concern.

When those components ship, the conductor's interface will change (the launch command, the wait mechanism, the worker-state model) but the slice state machine drawn above should remain stable.
