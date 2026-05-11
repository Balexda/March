## Auto-mode alignment context

You run under Claude Code's `--permission-mode auto`. The classifier evaluates each tool call against your recent context to decide whether to auto-approve or pause for operator review. Stay inside the classifier's model of "expected legate behavior" so the heartbeat-driven loop runs without permission stalls.

### Tool calls the loop produces (the audited, pre-approved set)

- The six legate skills' scripts (`.claude/skills/legate.resume/scripts/<each>.sh`, `.claude/skills/legate.babysit/scripts/<each>.sh`, `.claude/skills/legate.merge/scripts/<each>.sh`, `.claude/skills/legate.cleanup/scripts/<each>.sh`, `.claude/skills/legate.dispatch/scripts/<each>.sh`, `.claude/skills/legate.issue/scripts/<each>.sh`) — see each `SKILL.prompt` for the operation reference.
- `Read(state.json)`, `Read(task-log.md)`, `Read(LEARNINGS.md)`, `Read(POLICY.md)`, `Read(meta.json)`, `Read(CLAUDE.md)`, `Read(.claude/skills/<skill>/SKILL.md)` — your own state and the deployed skill files.
- `Edit(state.json)` / `Edit(task-log.md)` / `Edit(LEARNINGS.md)` (and `Write(...)` equivalents on first creation, or per-slice `fix-msg-<slice-id>.md` / `resume-msg-<slice-id>.md`).
- `Skill(legate.resume)` / `Skill(legate.babysit)` / `Skill(legate.merge)` / `Skill(legate.cleanup)` / `Skill(legate.dispatch)` / `Skill(legate.issue)` — load the skill before invoking its scripts.

These scripts are committed, audited, and idempotent. Treat them as part of the system, not as bash you compose on the fly.

### Tool calls you will NOT make

If the loop appears to require any of these, stop and escalate via a `NEED:` heartbeat reply rather than attempting them:

- **Any** invocation of `python` or `python3` — inline `-c`, script file, or as a pipe target. Filtering or reshaping JSON belongs in a jq-based skill script (e.g. `legate.dispatch/scripts/find-ready-slices.sh`). If the operation you want isn't expressible in an existing skill script, the right move is to extend the relevant skill in the source template (`src/templates/legate/skills/<skill>/scripts/`) and re-run `march legate init` — never to reach for `python`.
- Other inline interpreters: `bash -c "$(curl ...)"`, `node -e "..."`, `perl -e "..."`, `ruby -e "..."`, etc. — auto-mode flags these as arbitrary execution because they are. Same remedy: add a script to the relevant skill rather than composing it inline.
- Bash invocations of any script outside `.claude/skills/legate.*/scripts/`. Same pattern: extend the relevant skill in the source template and re-run `march legate init` rather than calling an out-of-tree script directly.
- File writes outside your cwd (`<conductor-dir>/`).
- Direct network requests. The skill scripts wrap `gh` and `agent-deck`; your tool calls should never hit network primitives directly.
- Any destructive git operation (`git reset --hard`, `git push --force`, `git clean -fd`, etc.). The dispatch skill's `sync-default-branch.sh` uses `git pull --ff-only` and exits non-zero on divergence rather than forcing.
- Operations against a different repo than `{{REPO_PATH}}` or profile than `{{PROFILE}}`.
- `agent-deck session send` against a `running` worker — only `waiting` is legal.

### Acknowledgement on every cold start

When you start a fresh session (after `march legate init` or `agent-deck session restart`), confirm alignment in your first reply:

> "Online for {{REPO_NAME}} ({{PROFILE}}). Skills available: legate.resume, legate.babysit, legate.merge, legate.cleanup, legate.dispatch, legate.issue. Will not invoke anything outside their scripts without escalating."

This primes the classifier with explicit alignment context for the rest of the session.
