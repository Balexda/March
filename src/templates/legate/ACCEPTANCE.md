# Acceptance criteria — mini-legate

What we expect a deployed legate conductor to do, as a checklist for regression-testing changes and for post-deploy validation.

> Companion docs in this directory:
> - [`README.md`](./README.md) — what mini-legate is and how it works conceptually.
> - [`CLAUDE.md`](./CLAUDE.md) — programmatic state inspection (the commands referenced below).
> - [`CONTRIBUTING.md`](./CONTRIBUTING.md) — the dev loop, including the operator-nudge step for SKILL.md reloads.

Each criterion follows the form: **invariant** / **how to verify** / **failure mode**. They are written so a human (or another agent) can walk a single live conductor and tick boxes. None of these are unit tests — they assert observable conductor behavior. Use them after any change that touches `CLAUDE.prompt`, a `SKILL.prompt`, or a skill script.

The shorthand `<conductor-dir>` means `~/.agent-deck/conductor/<conductor-name>/`. The shorthand `<profile>` is the agent-deck profile (typically the repo slug).

## A. Conductor liveness

**A1. The bridge daemon delivers heartbeats on schedule.**
- Verify: `jq -r '.last_heartbeat' <conductor-dir>/state.json` should be within the last bridge-tick interval (default 15 min) plus a few seconds of slack.
- Failure: a stale `last_heartbeat` means the bridge daemon is dead, the heartbeat script is exiting before sending, or the conductor's `agent-deck session send` is being rejected. See `CLAUDE.md` § *Forcing a heartbeat* for the manual fallback.

**A2. The conductor responds to forced heartbeats within ~2 minutes.**
- Verify: run `bash <conductor-dir>/heartbeat.sh`, wait until the conductor's `agent-deck session show` flips back to `waiting`, then re-read `last_heartbeat` in state.json. It should be updated; the elapsed time should be O(minutes).
- Failure: the conductor is wedged on a permission prompt, a stuck picker, or a half-typed message in its TUI. Capture the pane with `tmux capture-pane -pS -200` to triage.

**A3. The conductor's tmux pane is clean of stray operator input.**
- Verify: `tmux capture-pane -t "$(agent-deck -p <profile> session show conductor-<name> --json | jq -r .tmux_session)" -p | tail -5` — the bottom prompt should be empty (just `❯`) when the conductor is `waiting`. A half-typed message ("merge PR #77") or a feedback survey ("How is Claude doing this session?") blocks the next heartbeat.
- Failure: clear the input manually with `tmux send-keys C-u` or dismiss the survey by sending the appropriate digit. If this happens repeatedly, the heartbeat sender is mis-targeted.

## B. New-work dispatch (`legate.dispatch`)

**B1. Ready slices get workers within one heartbeat.**
- Verify: `bash <conductor-dir>/.claude/skills/legate.dispatch/scripts/find-ready-slices.sh <repo-path>` enumerates the ready set. Each item not already present in `state.json.slices` should appear as a worker session within one heartbeat after `find-ready-slices` first surfaces it.
- Failure: dispatch is either (a) treating an unmerged dep as merged, (b) treating an escalated/archived slice as in-flight, or (c) `find-ready-slices.sh` is hiding the item. Cross-check against `smithy status --graph --no-color` from the target repo.

**B2. Each worker has a staged dispatch message on disk.**
- Verify: every slice in `state.json.slices` with `stage == "implementing"` should have a `<conductor-dir>/dispatch-msg-<slice-id>.md` file. `legate.cleanup` removes it post-merge.
- Failure: a missing `dispatch-msg-*.md` means an older dispatch ran before staging was added; revival-stranded recovery will surface `NEED:` lines. Operator must re-dispatch manually.

**B3. No worker is launched on an artifact that already has an in-flight worker.**
- Verify: group sessions by `worktree_branch` — each branch should map to at most one session in the worker group.
- Failure: dispatch is mis-checking the in-flight set. Re-read `state.json.slices` for duplicate `branch` values.

## C. PR discovery (`legate.babysit` Step 2)

**C1. Any slice with `pr == null` AND `stage == "implementing"` whose worker is `waiting` OR `idle` gets `discover-pr.sh` run against it on the next heartbeat.**
- Verify: capture the conductor pane (`tmux capture-pane -pS -300 | grep discover-pr.sh`) — expect a `discover-pr.sh <profile> <session> <repo>` invocation per matching slice each heartbeat. Output should map the PR (when one exists) into `state.json.slices.<id>.pr.{number,url,state,...}` within the same heartbeat.
- Failure: if the conductor instead jumps straight to `recover-stranded-worker.sh` on an idle worker that has pushed a PR, the `SKILL.md` in context is the pre-PR-#100 version. See `CONTRIBUTING.md` § *Why a re-deploy isn't enough to refresh `SKILL.md` / `CLAUDE.md` content*.

**C2. `discover-pr.sh` finds the PR via tier-1 (tmux scrollback) when the worker hasn't been recycled.**
- Verify: run `discover-pr.sh <profile> <worker-session> <repo>` manually. Stderr should print `primary`; stdout should contain `headRefName` matching the worker's pushed branch (which can differ from the originally-requested branch — `/smithy.*` slash-commands sometimes rename on push).
- Failure: `primary` missing means the tmux output got cleared (compaction, very old session). Tier-2 (`gh pr list`) should still match by branch; if tier-2 also fails to find the PR, check whether the worker actually pushed (`git ls-remote origin`).

**C3. Branch-renames on push are captured into `actual_branch`.**
- Verify: `jq '.slices[] | select(.pr != null) | {id: .id, planned: .branch, actual: .actual_branch}' <conductor-dir>/state.json` — `actual_branch` should be populated for every slice with a discovered PR, and may differ from `branch`.
- Failure: a null `actual_branch` on a slice with a PR means babysit wrote the PR object without capturing `headRefName`. Subsequent rebase/conflict-resolution dispatches will target the wrong branch.

## D. PR babysitting (`legate.babysit` Steps 3–5)

**D1. Every tracked PR is `babysit-pr.sh`-ed every heartbeat.**
- Verify: `tmux capture-pane -pS -400 | grep "babysit-pr.sh" | sort -u` — there should be one entry per tracked PR per heartbeat, regardless of stage.
- Failure: a tracked PR not in the grep means the conductor is short-circuiting on stage. The "all clear" stage (`pr-open`, no threads, PASS) is *not* a skip — it must still run babysit-pr.sh to detect new review activity.

**D2. CONFLICTING is dispatched as conflict resolution, not as a rebase or rerun.**
- Verify: when `babysit-pr.sh` returns `mergeable: "CONFLICTING"`, the next conductor action for that PR should be `request-conflict-resolution.sh`. Slice stage transitions to `pr-resolving-conflicts`. **No** parallel `request-rebase.sh` or `rerun-ci.sh` in the same heartbeat (the conflict rebase fires fresh CI; chaining is wasted work).
- Failure: dispatching both is a decision-tree ordering bug.

**D3. CI failures route to the right tool.**
- Upstream-fixed-since failures → `request-rebase.sh` (stage = `pr-rebasing`).
- Transient flakes → `rerun-ci.sh` (stage = `pr-in-rerun`).
- Real PR-diff failures → `/smithy.fix` via `send-to-worker.sh` (stage = `pr-in-fix`).
- Verify: read `last_action_note` on each pr-in-* slice for the dispatched reason; trace back through `tmux capture-pane` for the bash invocation.
- Failure: routing a real diff failure to `rerun-ci.sh` loops forever — `gh run rerun` re-runs against the same merge commit. If you see two consecutive `rerun-ci.sh` calls on the same run-id with no intervening worker push, the conductor mis-classified.

**D4. Unresolved review threads requiring a worker response trigger `/smithy.fix` exactly once.**
- Verify: when `babysit-pr.sh` returns `needs_response_count > 0`, the conductor must `Write(./fix-msg-<slice-id>.md)` + `send-to-worker.sh`. Stage transitions to `pr-in-fix`. On the *next* heartbeat with the worker still working, the slice should remain `pr-in-fix` (no re-dispatch).
- Failure: re-dispatching every heartbeat indicates the conductor isn't tracking the in-fix state correctly.

**D5. `thread_count > 0` AND `needs_response_count == 0` is reported, not re-dispatched.**
- Verify: capture `[STATUS]` lines from the conductor's reply. Threads addressed by the worker but unresolved-because-operator-hasn't-clicked should appear as a status note ("3 threads addressed by worker, awaiting operator-resolve"), not as a new `/smithy.fix` dispatch.
- Failure: re-dispatching here floods the worker with redundant fix instructions. Apply the single-user override carefully (see `legate.babysit/SKILL.md`).

**D6. Single-user override fires only on slices in `pr-open`.**
- Verify: a slice in `pr-in-fix` with `last_author == pr_author` should NOT be re-dispatched mid-fix-cycle; the override only applies to `pr-open` slices where reviewer ≡ operator ≡ worker identity.
- Failure: catching `pr-in-fix` slices in the override causes mid-flight fix-loop interruption.

## E. Merge gating (`legate.merge`)

**E1. Auto-merge only fires when every gate condition is satisfied.**
- Required: `checks == "PASS"` AND `mergeable == "MERGEABLE"` AND `mergeStateStatus == "clean"` AND `≥1 human approval` AND `0 outstanding CHANGES_REQUESTED`.
- Verify: run `check-merge-readiness.sh <repo> <pr>` against a candidate PR. Output JSON shows each gate; merge dispatches only when all pass.
- Failure: an auto-merge on a PR missing a human approval is a permission-bypass class bug — escalate via `NEED:` instead.

**E2. Babysit never calls `gh pr merge`.**
- Verify: grep `<conductor-dir>/.claude/skills/legate.babysit/` for `gh pr merge` — should return no results. Only `legate.merge/scripts/squash-merge-pr.sh` is allowed to merge.
- Failure: if babysit gains merge authority, the strict gate is bypassed.

## F. Cleanup (`legate.cleanup`)

**F1. Merged slices are archived within one heartbeat.**
- Verify: when `state == "MERGED"` is observed on a PR (by either babysit or merge), the slice should move from `slices` to `archived_slices` on the same heartbeat. The worker session should be removed (`agent-deck -p <profile> list --json` no longer lists it), the worktree pruned, and a task-log entry appended.
- Failure: lingering merged slices in `slices` block dispatch's dep-check.

**F2. `archived_slices` carries only the audit minimum.**
- Verify: each archived entry has exactly `{pr_number, pr_url, worker_title, merged_at}` — no full slice body, no transient stage data.
- Failure: archive bloat slows state.json reads.

**F3. Cleanup runs only for `stage == "merged"`.**
- Verify: any slice in `pr-open` / `pr-in-fix` / `escalated` / `implementing` / etc. should retain its worker session and worktree. Only `merged` triggers teardown.
- Failure: early cleanup destroys in-flight work.

## G. Resume (`legate.resume`)

**G1. Every worker is `check-resume-prompt.sh`-ed every heartbeat.**
- Verify: grep `tmux capture-pane -pS -200` for `check-resume-prompt.sh` — one invocation per worker per heartbeat.
- Failure: a missed worker leaves a "Resume from summary" picker stuck on its TUI; subsequent `agent-deck session send` is silently lost.

**G2. A detected picker is cleared via `select-resume-summary.sh` and re-nudged on a later heartbeat (two-tick handshake).**
- Verify: `state.json.slices.<id>.resume_pending == "selected"` on the picker-detected heartbeat; deleted (not nulled) after the nudge lands on a subsequent heartbeat.
- Failure: a worker stuck at `resume_pending: "selected"` for multiple heartbeats indicates the nudge never delivered; check `nudge-resumed-worker.sh` output.

**G3. Downstream skills skip slices with `resume_pending == "selected"`.**
- Verify: babysit, merge, cleanup, and dispatch must all bail on these slices for the remainder of the heartbeat — sends into a half-cleared picker are lost.
- Failure: if a slice in `resume_pending` gets `send-to-worker.sh`'d, the worker won't receive the message.

## H. Issue intake (`legate.issue`)

**H1. Operator messages matching the issue grammar trigger `legate.issue`, not anything else.**
- Grammar: `issue <N>` / `issue #<N>` / a GitHub issue URL / a free-form sentence whose meaning is "address issue N".
- Verify: send a test message ("issue 999 — investigate later") to the conductor. The reply should be a `[STATUS]` + `AUTO: launched issue-#999 worker` line (or a `NEED:` line if the issue is closed/wrong repo/ambiguous). No babysit/merge/cleanup output should appear.
- Failure: the issue grammar is silently mis-classified into babysit (or worse, ignored entirely).

**H2. Issue-kind slices flow through babysit/cleanup identically to Smithy slices.**
- Verify: an issue-#<N> slice should appear in `state.json.slices` with `kind: "issue"` and an `issue: {number, url, title}` subobject. All other fields and lifecycle behaviors match a Smithy slice.
- Failure: babysit branching on `kind` is a smell — `kind` is audit-only.

## I. State integrity (`state.json`)

**I1. `last_heartbeat` advances monotonically.**
- Verify: capture `last_heartbeat` before and after a forced heartbeat. The value must be strictly later, in ISO-8601 form, in the actual current wall-clock window.
- Failure: a timestamp from the future (e.g. `2026-05-15T09:30:00Z` when the actual date is 2026-05-12) means the agent is hallucinating dates — a session-context corruption that justifies a hard reset (clear `claude_session_id`, restart).

**I2. `pr_open_at` is set on every `→ pr-open` transition (including the first one).**
- Verify: every slice with `stage == "pr-open"` (or any `pr-*` stage that was once `pr-open`) must have a non-null `pr_open_at`.
- Failure: a missing `pr_open_at` breaks the single-user override; treated as pessimistic catch-up on next pass (every unresolved thread is re-dispatched), which floods the worker.

**I3. State.json updates are scoped to the action taken; whole-file rewrites are not used as a shortcut.**
- Verify: `git diff` (if state.json is under version control for the conductor — it usually isn't, but agents should still treat each Update as a surgical edit) should show small, focused diffs per heartbeat.
- Failure: large unrelated rewrites mid-heartbeat indicate the agent isn't anchoring to the existing state structure.

## J. Permission mode boundaries

**J1. No `Bash(*)`, `Read(*)`, `Edit(*)`, or `Write(*)` wildcards in `<conductor-dir>/.claude/settings.json`.**
- Verify: `jq '.permissions.allow' <conductor-dir>/.claude/settings.json` — every entry should be either `Skill(legate.<name>:*)`, a per-script `Bash(.claude/skills/...:*)`, the cwd-scoped `Read(./**)` / `Edit(./**)` / `Write(./**)`, or a narrow `Bash(agent-deck * <verb> *)`.
- Failure: any tool-wide wildcard is a permission bypass dressed as a fix. Reject in code review.

**J2. The conductor never inlines `bash -c "..."`, `python3 -c "..."`, etc.**
- Verify: grep skill script bodies and the SKILL.prompt action lists for inline interpreters. All logic lives in named `.sh` files under each skill's `scripts/`.
- Failure: inline interpreters are auto-classified as "arbitrary execution" and pause the loop on operator approval.

**J3. Writes outside `<conductor-dir>` pause the loop.**
- Verify: spot-check the heartbeat output for write tool calls — `Write(./fix-msg-<id>.md)` is OK (cwd-scoped); `Write(/home/.../repo/...)` is not (workers do their own writes).
- Failure: if a SKILL.prompt drafts a write outside cwd, the conductor will pause on operator approval mid-heartbeat.

## K. Post-deploy reconciliation

**K1. After `march legate init` is re-run for an existing conductor, the file-on-disk SKILL.md matches the file-in-context SKILL.md only after a Skill re-load.**
- Verify: `diff <conductor-dir>/.claude/skills/legate.<name>/SKILL.md ~/.march/legate/<name>/skills/legate.<name>/SKILL.md` should be empty immediately after init. To make the conductor *act on* the new content, send the operator-nudge message from `CONTRIBUTING.md` § *Iterating on the template (re-deploy)*.
- Failure: skipping the nudge leaves the conductor running with stale skill semantics — exactly the failure mode that produced PR #100.

**K2. After any `CLAUDE.prompt` change, plan for a session reset.**
- Verify: changes to system context (loop skeleton, status grammar, heartbeat order) are only picked up on a fresh Claude Code session start. The operator-nudge trick does *not* work for CLAUDE.md.
- Failure: assuming a quick `march legate init` propagates CLAUDE.md changes to a running conductor is wrong; the conductor will keep operating on its session-start system context.
