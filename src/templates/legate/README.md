# Mini-Legate Conductor Template

This directory ships the prompt and skills that turn an [agent-deck](https://github.com/asheshgoplani/agent-deck) **conductor** into a per-repo **Legate** — a Claude Code session that drives the Smithy plan→implement→PR→fix loop on a single repository.

> Companion docs in this directory:
> - [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to develop, build, deploy, and iterate on the template.
> - [`CLAUDE.md`](./CLAUDE.md) — context for agents working on the template: programmatic inspection of conductor state, the auto-mode permission wiring, and other facts that don't show up in a TUI walk-through.

`CLAUDE.prompt` is the conductor's identity prompt. It is rendered by `march legate init` (see [`src/legate/init.ts`](../../legate/init.ts)) — `{{REPO_NAME}}`/`{{REPO_PATH}}`/`{{PROFILE}}`/`{{CONDUCTOR_NAME}}`/`{{WORKER_GROUP}}` are substituted, and any `{{>partial-name}}` includes are resolved against `snippets/` via [Dotprompt](https://www.npmjs.com/package/dotprompt) — into `~/.march/legate/<conductor-name>/CLAUDE.md` (a march-owned staged snapshot), then **copied** into the conductor's working directory. Each skill under `skills/<name>/SKILL.prompt` is similarly rendered to `SKILL.md` and copied alongside its `scripts/`.

This README, `CONTRIBUTING.md`, and `CLAUDE.md` are **not** rendered or deployed — they stay here as developer-facing documentation of what the template is meant to do.

## What mini-legate is

Mini-legate is a precursor to the full Legate component described in March RFC `2026-001-march-orchestration-platform` (Milestone 5). It exists ahead of the M1–M4 infrastructure (Spawn, Hatchery, Brood, Herald) because Claude Code auto mode is reliable enough to handle most of Legate's reasoning today. It runs entirely on top of:

- `agent-deck conductor` for runtime, parent/child links, heartbeats, transition notifications.
- `smithy` CLI and skills for "what work to pick up next".
- `gh` CLI for high-level PR state.
- The `smithy.pr-review` skill for unresolved inline review threads.

There is no host-side spawn sandbox, no declarative profile system, no separate event bus, and no persistent session manager — those arrive with M1–M4. Mini-legate's interface to those concerns is whatever agent-deck provides today.

## How it works — at a glance

A conductor is one Claude Code session pinned to one repository. agent-deck's bridge daemon fires a `[HEARTBEAT]` message at the conductor on a fixed cadence (default 15 minutes); the conductor wakes, runs its skill suite in a fixed order, and goes back to `waiting`. Worker sessions (one per Smithy slice) live in the same agent-deck profile under the `legate-workers` group. The conductor never polls on its own schedule — heartbeats and agent-deck transition notifications are the only timers.

The conductor's identity (who I am, what I own, escalation rules, the loop skeleton) lives in `CLAUDE.prompt`. Claude-side mechanics are split across **five skills**, each deployed as `.claude/skills/<name>/SKILL.md` plus `.claude/skills/<name>/scripts/`. Routine PR babysitting, terminal cleanup, and heartbeat-driven Smithy dispatch live in the paired deterministic loop.

## The five skills — mechanics layer

**`legate.resume`** — worker session-restart recovery. Loaded **first** on every heartbeat. When a worker's Claude Code TUI restarts (after `restart-worker.sh`, after agent-deck restarts the session, after a host reboot, etc.) and Claude shows its "Resume from summary" picker, this skill detects the picker, types `"1"` to select option 1 (recommended), and marks the slice `resume_pending = "selected"` in `state.json`. On a subsequent heartbeat (once the worker is back in `waiting` with the summary loaded), it composes a stage-aware nudge and delivers it, then clears the flag. Other skills skip any `resume_pending` slice for the rest of that heartbeat — a half-cleared picker silently swallows `agent-deck session send` keystrokes.

**`legate.error`** — opaque worker-error recovery. Loaded after resume and before babysit when a worker is in agent-deck `error`, or when the deterministic loop emits `[PROCESSOR]` with `reason == "worker_session_error"` or `reason == "claude_api_401_login_required"`. It inspects the worker output, classifies the failure (auth/login, resume picker, stale status, actionable failure, transient crash, unknown), then sends a resume/diagnostic prompt, restarts once, or escalates via `NEED:`.

**`legate.babysit`** — PR judgement escalations. Loaded when the deterministic loop writes a loop request that needs Claude/operator judgement: failed CI classification, repeated conflicts, or a worker action send failure. Routine PR discovery, PR-state refresh, first conflict prompts, review-thread `/smithy.fix`, all-clear transitions, terminal cleanup, and Smithy dispatch are loop-owned. Failed CI, persistent conflicts, opaque worker `error` states, and Claude login-refresh blocks are written to `legate-loop-requests.ndjson` and announced to the Legate agent with `[PROCESSOR]`.

**`legate.merge`** — auto-squash-merge under a strict gate. Loaded after loop/babysit PR refresh on every heartbeat. For each slice that the loop has placed in `pr-open`, it applies the gate (all CI checks PASS, no merge conflicts, GitHub `mergeStateStatus == clean`, ≥1 human approval, 0 outstanding CHANGES_REQUESTED). Only when every condition clears does it call the squash-merge script (with `--match-head-commit` to defeat any race against a worker push) and transition the slice to `merged`. The deterministic loop archives terminal PRs and tears down their worker sessions on its next tick. Every gate failure surfaces as a `NEED:` line so the operator decides whether to merge under relaxed-rules cases — the gate is conservative-by-design and there is no override flag.

**Deterministic Smithy dispatch** — new-work mechanics from `smithy status` now live in the paired deterministic loop, not a Claude skill. The loop runs every tick, syncs the default branch before the first launch, and launches ready Smithy items through `march hatchery spawn --backend codex`. Hatchery runs Codex in a container to produce a patch, then fronts it with a Claude auto-mode manager session that applies/reviews the patch and opens the PR. The manager session is recorded as the tracked worker in `state.json`.

**`legate.issue`** — operator-driven GitHub-issue intake. **Not** loaded on a heartbeat — invoked when the operator hands the conductor an issue reference (`issue 42`, `issue #42`, an issue URL, optionally with a trailing context note). Fetches the issue, syncs the default branch, and launches a worker whose initial prompt is the issue body + operator notes + a job description (investigate → implement → push → open a PR with `Closes #<N>`). Records the work in `state.json.slices` as `issue-<N>` with `kind: "issue"`, after which the deterministic loop, `legate.babysit`, and `legate.merge` track the resulting PR identically to a Smithy slice. One worker per issue (idempotent on a live `issue-<N>` slice).

**Why five skills, not one?** Three reasons. (a) **Per-repo enablement** — disabling issue intake or merge on a repo where every merge should be human-driven is a config flip rather than a prompt rewrite. Resume and error are non-disable-able because leaving a stuck "Resume from summary" picker or opaque worker error wedges the loop. (b) **Narrower `allowed-tools`** — each skill grants only its own scripts; an operator can audit one skill's surface area without paging through fifteen others. (c) **Side-effect locality** — resume is the only thing that types raw TUI picker input into a worker session; error is the only thing that chooses recovery for opaque worker failures; issue is the Claude-owned path that creates operator-requested worker sessions; merge is the only thing that calls `gh pr merge`; babysit is limited to PR judgement escalations the deterministic loop cannot decide.

**Why a skill, not inline shell?** Claude Code's `--permission-mode auto` (which the conductor runs under) classifies inline `python3 -c "..."` and other ad-hoc patterns as arbitrary code execution and pauses for operator approval. A single such pause inside a heartbeat-driven loop stalls the orchestration. Skills self-declare permitted bash patterns via `allowed-tools` in their frontmatter, so when a legate skill is invoked, its scripts auto-approve as a unit.

Operators iterate on these skills by editing the source template and re-running `march legate init` — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev loop, and [`skills/<name>/SKILL.prompt`](./skills/) for each skill's decision tree.

## Slice state machine

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
                                                          (legate.merge auto-     (loop removes
                                                           merges OR operator     worker + worktree;
                                                           merges in UI; loop     slice moves into
                                                           marks slice merged)    archived_slices)
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
| `pr-resolving-conflicts`   | The loop has dispatched a first conflict-resolution prompt for a real merge conflict against default. |
| `merged`                   | PR is `MERGED`. Cleanup will sweep the slice on the same heartbeat: worker session removed, worktree pruned, slice moved into `archived_slices`. |
| `escalated`                | Conductor has surfaced a `NEED:` to the operator; legate will not act on this slice until cleared.|

### What drives transitions

| Trigger                                       | Source                                                              |
|-----------------------------------------------|---------------------------------------------------------------------|
| Worker `running → waiting | error | idle`     | agent-deck transition notifier (`agent-deck notify-daemon`)         |
| Periodic re-scan of all workers + PRs         | agent-deck heartbeat (`[HEARTBEAT]` messages from the bridge)       |
| Operator instruction                          | Telegram/Slack message via the conductor bridge, or direct attach   |
| New commit on PR / CI completion / new review | discovered via `gh pr ...` during a heartbeat or transition wake-up |

## Per-repo model

A conductor manages exactly one repo. The operator runs `march legate init` per repo; each gets its own conductor name (`legate-<slug>`) and its own agent-deck profile (also `<slug>` by default), so multiple repos coexist in agent-deck's system-wide conductor namespace without interfering. All workers for a given repo live in the same profile under a `legate-workers` group. Cross-repo coordination is explicitly out of scope until Hatchery (M2).

## Boundaries — what mini-legate will not do

- **No cross-repo work.** A conductor manages exactly one repo.
- **No autonomous merges under relaxed rules.** `legate.merge` will squash-merge only when *all* of: the PR is `OPEN`, has no merge conflicts (`mergeable == MERGEABLE`), all CI checks pass, GitHub `mergeStateStatus == clean`, ≥1 human (non-bot) APPROVED review, and 0 outstanding CHANGES_REQUESTED — applied to a slice already in `stage == "pr-open"`. Any condition unmet is surfaced as a `NEED:` so the operator decides; the conductor never bypasses the gate.
- **No worktree cleanup beyond merged slices.** Worktrees created by `--worktree -b` accumulate on disk for *escalated* slices. Brood (M3) will own this; until then, the operator reclaims disk manually.
- **No force-pushes, no resets, no destructive git ops.** If `git pull --ff-only origin <default>` fails, the conductor escalates instead of forcing.
- **No re-planning of operator-approved slices** without explicit operator instruction.

## Future work this precursor explicitly omits

- **Sandboxing** — workers run in real worktrees on the operator's host. Spawn (M1) will move them into restricted Docker containers.
- **Profile-driven security posture** — Hatchery (M2) will let different roles get different permissions; today everything is operator-trust.
- **Lifecycle management** — Brood (M3) will own worktree/branch/container cleanup at slice end.
- **Event-driven coordination** — Herald (M4) will push spawn-completion / CI / review events through a deterministic bus instead of relying on agent-deck heartbeats and `gh` polling.
- **Cross-repo work** — a single conductor manages a single repo. Future routing of an issue cross-repo is a Hatchery (M2) concern.

When those components ship, the conductor's interface will change (the launch command, the wait mechanism, the worker-state model) but the slice state machine drawn above should remain stable.
