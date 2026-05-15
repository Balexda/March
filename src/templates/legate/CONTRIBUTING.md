# Contributing to mini-legate

This guide is for developers iterating on the mini-legate template: the prompt, the skills, and the deploy mechanics.

> Companion docs in this directory:
> - [`README.md`](./README.md) — what mini-legate is and how it works conceptually.
> - [`CLAUDE.md`](./CLAUDE.md) — programmatic state inspection and other agent-facing context.
> - [`ACCEPTANCE.md`](./ACCEPTANCE.md) — verifiable invariants for post-deploy validation and regression-checking after any template change.

## Source layout

```
src/templates/legate/
├── CLAUDE.prompt                       ← conductor identity, loop skeleton, universal invariants
├── snippets/                           ← shared {{>partial}} fragments (state-json schema, status grammar, …)
└── skills/
    ├── legate.resume/                  ← worker session-restart recovery
    │   ├── SKILL.prompt                ← picker detection, two-tick handshake, stage-aware nudge
    │   └── scripts/                    ← check-resume-prompt, select-resume-summary, nudge-resumed-worker
    ├── legate.babysit/                 ← PR judgement escalations
    │   ├── SKILL.prompt                ← CI classification, repeated conflicts, send failures
    │   └── scripts/                    ← babysit-pr, send-to-worker, request-rebase, …
    ├── legate.merge/                   ← auto-squash-merge under a strict gate
    │   ├── SKILL.prompt                ← gate conditions, per-candidate readiness check, squash-merge
    │   └── scripts/                    ← check-merge-readiness, squash-merge-pr
    └── legate.issue/                   ← operator-driven GitHub-issue intake
        ├── SKILL.prompt                ← parse → fetch → sync → launch → record protocol
        └── scripts/                    ← fetch-issue, sync-default-branch, launch-issue-worker
```

Conventions:

- Each script: `set -euo pipefail`, JSON to stdout, status to stderr, structured exit codes (0 success / 1 op-failure / 2 invalid input).
- `.prompt` files render through [Dotprompt](https://www.npmjs.com/package/dotprompt). The `.prompt` extension flags "this is a source template; do not deploy verbatim". Files without that extension (this one, the README, `CLAUDE.md`) are documentation only.
- `snippets/<name>.md` files are inlined via `{{>name}}` Handlebars partials. Use them whenever the same invariant appears in `CLAUDE.prompt` and one or more `SKILL.prompt` files. See [`snippets/README.md`](./snippets/README.md) for the inventory and conventions.

## Mental model: profile, conductor, workers

Each repo a legate manages gets its own **agent-deck profile**. Inside that profile:

- A single **conductor** session (`conductor-legate-<slug>`) runs Claude Code under `--permission-mode auto`. Its working directory is `~/.agent-deck/conductor/legate-<slug>/`, *not* the target repo. The conductor reads/writes the repo by path (`{{REPO_PATH}}`); its cwd is its own state directory.
- Zero or more **worker** sessions live under the `legate-workers` group in the same profile. Each worker owns a git worktree and exactly one Smithy slice. Workers run Claude Code on the Claude default model (no `--model` override).
- The agent-deck **bridge daemon** generates `[HEARTBEAT]` messages on its configured cadence and forwards them to the conductor's tmux session. The conductor responds to heartbeats and to transition-notifier wake-ups; it does not poll on its own schedule.

Different profiles → different conductors → different repos. They share the bridge daemon and notifier daemon (one each, system-wide) but nothing else.

## Build

The mini-legate template ships inside the `@balexda/march` package. To work on it locally:

```bash
npm install                # one-time, after a fresh clone or branch switch
npm run build              # produces dist/cli.js
node dist/cli.js --version # sanity check
```

`tsup` bundles `src/cli.ts` into `dist/cli.js`. Tests use the same bundle (`pretest` runs `npm run build`).

For day-to-day iteration on the template files (`.prompt`, `snippets/`, `skills/*/scripts/*.sh`) you don't need to rebuild — those are read at deploy time from `src/templates/legate/`. You only rebuild when you touch the TypeScript (`src/legate.ts`, `src/cli.ts`).

Run the tests after any change:

```bash
npm test
```

## First-time deploy for a new repo

Assume a target repo on disk that you want a legate for.

1. **Install the march CLI globally** (or run it from `dist/cli.js`).
2. **Decide on a profile name** for the repo. The default is the repo basename slugified — `Foo` → `foo`. Pass `--profile <name>` to override.
3. **From inside the target repo**, run:
   ```bash
   march legate init
   ```
   With no flags this:
   - Derives the profile, conductor name (`legate-<slug>`), and worker group (`legate-workers`) from the repo basename.
   - Renders `CLAUDE.prompt` and every `SKILL.prompt` into `~/.march/legate/<conductor-name>/` (staged copies for inspection).
   - Calls `agent-deck -p <profile> conductor setup <name>` to create the agent-deck profile (if new), register the conductor session, install the heartbeat timer + bridge unit, and start the session.
   - Copies the rendered `CLAUDE.md` and `.claude/skills/<name>/` into the conductor's working directory (replacing agent-deck's defaults).
   - Writes `<conductor-dir>/.claude/settings.json` with the narrow allow-list (see *Permission mode* below).
   - Sets `auto_mode = true` and `extra_args = ["--model","sonnet"]` on the conductor session, then restarts so both flags take effect.
   - (Linux/WSL2) Starts and verifies the `agent-deck-conductor-bridge` systemd unit.

   Flags worth knowing:
   - `--profile <name>` — override the derived profile.
   - `--name <name>` — override the conductor name.
   - `--model <id>` — override the conductor model (default `sonnet`). Workers stay on the Claude default.
   - `--no-setup` — render the template only; don't touch agent-deck (useful for inspecting the rendered output).
   - `--no-bridge-check` — skip the Python 3.9+ pre-flight (only when you intend to drive the conductor manually).

After this the conductor is live and will receive its first `[HEARTBEAT]` on the bridge's next tick. To verify:

```bash
agent-deck -p <profile> conductor status legate-<slug>
```

## Iterating on the template (re-deploy)

`march legate init` is **idempotent and re-runnable**. The expected dev loop is:

1. Edit any of: `CLAUDE.prompt`, `snippets/*.md`, `skills/<name>/SKILL.prompt`, or `skills/<name>/scripts/*.sh`.
2. From inside the same target repo, re-run `march legate init`.
3. That re-renders, re-stages, re-copies all skill files, re-writes the settings file, and restarts the conductor in one shot. Any previous staged copy is wiped first, so scripts removed in a newer source template don't linger.
4. On the next heartbeat (or after a forced one), the conductor picks up the new **script** content (each script is re-`exec`'d every invocation) and any settings.json changes.
5. **The conductor does *not* automatically pick up new `SKILL.md` or `CLAUDE.md` content this way.** See below.

### Why a re-deploy isn't enough to refresh `SKILL.md` / `CLAUDE.md` content

`agent-deck session restart` reloads MCPs but resumes the Claude Code conversation rather than starting fresh — the agent's working memory still contains the `SKILL.md` body it loaded on the *previous* `Skill(skill="legate.<name>")` call, and CLAUDE.md is part of the system context that was set at session start. Copying new files onto disk doesn't invalidate either.

To force the running conductor to pick up new SKILL.md content, send an operator message asking it to re-invoke the skill:

```bash
agent-deck -p <profile> session send conductor-legate-<slug> "Operator note — legate.<skill> SKILL.md has been updated. Please re-load Skill(skill=\"legate.<skill>\") so the new content replaces what's cached in this session's context." --no-wait -q
```

The agent will re-call `Skill(...)`, the classifier re-reads `SKILL.md` from disk, and subsequent decisions follow the new body. Confirmed working on a live deploy: this is how the babysit Step 2 fix (PR #100) for the "PR stranded on idle implementing-stage worker" coverage gap was validated — the file copy alone was insufficient; an explicit Skill re-load was required before the conductor switched from the old recovery path to the new discovery path.

For CLAUDE.md changes (system context, loop skeleton, status grammar), the operator-nudge trick doesn't work — CLAUDE.md is loaded once at session start. Either wait for natural context compaction or do a hard session reset (clear the `claude_session_id` in the agent-deck DB and restart, or `/clear` inside the tmux pane).

If you touched `src/legate.ts` or `src/cli.ts` (not the template files), rebuild first: `npm run build`.

To iterate against multiple repos in parallel, run `march legate init` from inside each one. Each gets its own profile and its own conductor; they share the bridge daemon. You can keep all conductors on the same template version by re-running `march legate init` per repo after any template change.

## What `march legate init` does, step by step

Useful when something goes wrong and you need to know which step:

1. Detect repo basename → derive defaults: profile = repo slug, conductor name = `legate-<slug>`, worker group = `legate-workers`.
2. Render `CLAUDE.prompt` through Dotprompt: substitute `{{REPO_NAME}}` / `{{REPO_PATH}}` / `{{PROFILE}}` / `{{CONDUCTOR_NAME}}` / `{{WORKER_GROUP}}`, resolve `{{>partial}}` includes against `snippets/`.
3. Stage the rendered output at `~/.march/legate/<conductor-name>/CLAUDE.md` (stable, march-owned snapshot for inspection/debugging).
4. For each skill in `skills/<name>/`: render its `SKILL.prompt` (frontmatter preserved; body interpolated), stage at `~/.march/legate/<conductor-name>/skills/<name>/SKILL.md`, and copy its `scripts/` alongside.
5. Run `agent-deck -p <profile> conductor setup <name> --description "..."`. agent-deck registers the conductor session, writes its default conductor `CLAUDE.md`, installs the heartbeat timer + bridge unit, and starts the session.
6. Copy the rendered `CLAUDE.md` and each staged skill directly into `<conductor-dir>/CLAUDE.md` and `<conductor-dir>/.claude/skills/<name>/` (replacing agent-deck's defaults and any prior symlinks/copies, including any legacy monolithic `<conductor-dir>/.claude/skills/legate/` from older deploys — Claude Code autoloads every dir under `.claude/skills/`, so a leftover legacy dir would shadow the new per-skill grants).
7. Write `<conductor-dir>/.claude/settings.json` with the narrow allow list (see below).
8. `agent-deck session set conductor-<name> auto-mode true`, then `extra-args -- --model <model>`, then `session restart` so both flags take effect.
9. (Linux/WSL2 only) `systemctl --user start agent-deck-conductor-bridge` and verify with `systemctl --user is-active --quiet agent-deck-conductor-bridge`. agent-deck installs and tries to enable+start this unit during conductor setup, but a successful unit install does not guarantee a healthy daemon — `march legate init` re-asserts the start and verifies, so a crash-loop is surfaced immediately.

**Why copies, not symlinks?** Claude Code's `--permission-mode auto` classifier flags symlink reads pointing outside cwd as cross-boundary access and pauses on them, which stalls the heartbeat-driven loop. Copies keep every read inside cwd. The trade-off: editing the staged file under `~/.march/legate/...` no longer auto-propagates to the conductor's working directory — you have to re-run `march legate init`.

## Permission mode setup

The conductor runs under Claude Code's `--permission-mode auto`, layered with two levels of scoped pre-approval. Both are wired by `march legate init`; you usually don't touch them by hand, but you need to understand what they do.

**Level 1 — conductor session permission mode** (set via agent-deck).

The `auto_mode` key on the global `[claude]` block in `~/.agent-deck/config.toml` would put *every* Claude session on the host into auto mode. To scope auto mode to *just* this conductor, `march legate init` mutates the conductor's session record directly:

```bash
agent-deck -p <profile> session set conductor-legate-<slug> auto-mode true
```

This flips the conductor's auto-mode flag; agent-deck's launcher emits `--permission-mode auto` on every start/restart. Workers go through `agent-deck launch`'s per-launch `--extra-arg --permission-mode --extra-arg auto` because there is no `--auto-mode` flag on `agent-deck launch`.

**Level 2 — narrow allow list in the conductor's project settings**.

`<conductor-dir>/.claude/settings.json` pre-approves exactly what the five skills need and nothing else:

```json
{
  "permissions": {
    "allow": [
      "Skill(legate.resume:*)",
      "Skill(legate.error:*)",
      "Skill(legate.babysit:*)",
      "Skill(legate.merge:*)",
      "Skill(legate.issue:*)",
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)",
      "Bash(.claude/skills/legate.resume/scripts/check-resume-prompt.sh *)",
      "Bash(.claude/skills/legate.error/scripts/inspect-worker-error.sh *)",
      "Bash(.claude/skills/legate.resume/scripts/select-resume-summary.sh *)",
      "Bash(.claude/skills/legate.resume/scripts/nudge-resumed-worker.sh *)",
      "Bash(.claude/skills/legate.babysit/scripts/babysit-pr.sh *)",
      "Bash(.claude/skills/legate.merge/scripts/check-merge-readiness.sh *)",
      "Bash(.claude/skills/legate.merge/scripts/squash-merge-pr.sh *)",
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

The `Bash(agent-deck * session show *)` / `... list *` / `... status *` lines are a separate belt-and-suspenders layer for direct read invocations.

`Read(./**)` / `Edit(./**)` / `Write(./**)` are cwd-scoped — the conductor's cwd is its own dir, so it can update `state.json`, `task-log.md`, `LEARNINGS.md`, and any additional notes it judges useful, without prompting on every write. Reads of files outside cwd are *not* granted; auto-mode still gates those.

Deliberately *not* in the allow list: `Bash(*)`, `Read(*)`, `Edit(*)`, `Write(*)`, or any tool-wide wildcard. Those would be a permission bypass dressed as a fix.

If you add a new script to a skill, you need to add a corresponding `Bash(.claude/skills/<skill>/scripts/<script>.sh *)` entry to the settings template in `src/legate.ts`.

## Bridge daemon requirements

The conductor's only autonomous trigger is `[HEARTBEAT]` messages. The agent-deck bridge daemon (`bridge.py`, run as `agent-deck-conductor-bridge.service` on Linux/WSL2 or `com.agentdeck.conductor-bridge` launchd plist on macOS) is what generates those messages on a configurable cadence (default 15 min) and forwards them into the conductor's tmux session. With the bridge stopped, the conductor sits in `waiting` indefinitely — healthy but inert. Manual `agent-deck session send` is the fallback.

**Python version requirement (host-level):** agent-deck's `bridge.py` uses PEP 585 generic builtins (`list[dict]`, `dict[str, Any]`), which require Python 3.9 or newer. On hosts whose default `python3` is 3.8 or older, the bridge will crash on import and systemd will retry until it gives up, even though the unit shows as "loaded". `march legate init` surfaces this as a `Bridge daemon: NOT active` warning with the log path so you can either install Python 3.9+ or fall back to manual heartbeats.

## Testing changes

- Run `npm test` after any TypeScript or template change. The test suite covers the renderer, the deploy flow, and the script contracts.
- For interactive testing: pick a low-stakes target repo (or create a throwaway one), run `march legate init` against it, then either (a) wait for a heartbeat, or (b) trigger one manually with `bash <conductor-dir>/heartbeat.sh`. See [`CLAUDE.md`](./CLAUDE.md) for the programmatic inspection patterns.
- Skill scripts should be runnable standalone for unit checks — they take their inputs as positional args, write JSON to stdout, and use exit codes (0/1/2) so a test can assert success without parsing stderr.
- For end-to-end validation of conductor behavior — beyond what the unit tests cover — walk through [`ACCEPTANCE.md`](./ACCEPTANCE.md) against a live conductor. Each criterion has a verification command and a stated failure mode.
