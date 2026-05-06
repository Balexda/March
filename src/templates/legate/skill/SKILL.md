---
name: legate
description: "Use this skill when acting as (or directing) a Smithy pipeline conductor. Primary triggers: [HEARTBEAT] ticks requiring worker scan + PR status refresh; worker session state transitions (running→waiting→merged); CI failures or review threads that need /smithy.fix dispatch to an existing worker; launching new workers for cut/forge slices; syncing the default branch before dispatch; discovering a worker's PR after branch rename; updating state.json after slice transitions. Skip for human code review, standalone git queries, or tasks with no conductor/worker/slice context."
allowed-tools: Bash(.claude/skills/legate/scripts/sync-default-branch.sh:*) Bash(.claude/skills/legate/scripts/list-workers.sh:*) Bash(.claude/skills/legate/scripts/launch-worker.sh:*) Bash(.claude/skills/legate/scripts/discover-pr.sh:*) Bash(.claude/skills/legate/scripts/babysit-pr.sh:*) Bash(.claude/skills/legate/scripts/smithy-status.sh:*) Bash(.claude/skills/legate/scripts/send-to-worker.sh:*) Bash(.claude/skills/legate/scripts/restart-worker.sh:*) Bash(.claude/skills/legate/scripts/rerun-ci.sh:*) Bash(.claude/skills/legate/scripts/request-rebase.sh:*)
---

# Skill: legate (Smithy workflow operations)

This skill is the *mechanics layer* of mini-legate. The conductor's `CLAUDE.md` identity tells you **what** to do and when (the loop, the boundaries, escalation rules); this skill provides the **how** — the actual command sequences, packaged as audited bash scripts so Claude Code's `--permission-mode auto` classifier doesn't pause on inline `python3 -c` or other ad-hoc patterns.

When you (the conductor) need to act on the Smithy loop, prefer these operations over composing your own command pipelines.

Base directory at runtime: `.claude/skills/legate/` relative to your conductor home (`~/.agent-deck/conductor/<conductor-name>/`). Reference scripts as `.claude/skills/legate/scripts/<name>.sh`.

---

## Operation: Sync default branch

Fetch and fast-forward the repo's default branch. Required before launching any new-work dispatch (per loop step 2). Bails out with exit 1 if the local default has diverged from origin — never `--hard` reset; escalate to operator.

```bash
.claude/skills/legate/scripts/sync-default-branch.sh <repo-path>
```

Stdout: JSON `{"default_branch": "...", "synced": true, "head": "<sha>"}`.
Stderr: progress messages.
Exit 1: divergence (escalate). Exit 2: invalid input.

---

## Operation: List workers

Returns all worker sessions in your `legate-workers` group with status, branch, worktree, and parent linkage. Replaces the inline `agent-deck list --json | python3 -c ...` patterns that auto-mode flags.

```bash
.claude/skills/legate/scripts/list-workers.sh <profile> <worker-group>
```

Stdout: JSON array of `{id, title, status, worktree_branch, worktree_path, parent_session_id}` objects.

---

## Operation: Launch worker for a slice

Atomically create a new worktree on a fresh slice branch, launch a Claude session in it under your worker group, lock the title (#agent-deck-697), pin auto-mode permission, and send the initial slash command. Returns the new session ID.

```bash
.claude/skills/legate/scripts/launch-worker.sh \
  <profile> <repo-path> <slice-title> <worker-group> <branch> <verb-cmd>
```

- `slice-title`: e.g. `cut: spawn-dispatch US5`
- `branch`: the worktree branch name; you choose (e.g. `smithy/cut/spawn-dispatch-us5`). Note: `/smithy.*` slash-commands may rename this when they push (see SmithyCLI#297) — the **Discover PR for worker** operation handles that case.
- `verb-cmd`: the initial message to send, e.g. `/smithy.cut specs/2026-04-11-002-spawn-dispatch 5`

Stdout: JSON `{"session_id": "...", "branch": "...", "worktree_path": "..."}`.
Exit 1: launch failed. Exit 2: invalid input.

After this returns, record the session id, slice id, branch, and worktree path in your `state.json` under `slices.<slice-id>` per the schema in `CLAUDE.md`. PR will be discovered on the worker's next transition to `waiting`.

---

## Operation: Discover PR for a worker

Two-tier PR discovery, resilient to branch renames by `/smithy.*`:

1. **Primary** — grep the worker's last tmux output for the `https://github.com/.../pull/N` URL the agent printed when it ran `gh pr create`.
2. **Fallback** — `gh pr list --author @me --state open` and pick the most recent matching the slice (by `createdAt > <dispatch-time>` and title-pattern match).

```bash
.claude/skills/legate/scripts/discover-pr.sh <profile> <session-id> <repo-path> [<dispatch-iso-timestamp>]
```

`dispatch-iso-timestamp` is optional but recommended for the fallback path (filters out unrelated open PRs); pass the slice's `last_action` from `state.json`.

Stdout (success): JSON `{"number": N, "url": "...", "headRefName": "...", "state": "OPEN", ...}`.
Stdout (no PR yet): empty JSON object `{}`.
Stderr: which tier matched (`primary` or `fallback`), or `none`.

Always record `pr.actual_branch` (from `headRefName`) alongside the worker's launch branch in `state.json` — they may differ.

---

## Operation: Babysit a PR

Returns the structured state of a PR — CI checks, mergeable flag, top-level reviews, and unresolved inline comment count — that you need to decide whether to dispatch `/smithy.fix` or do nothing.

```bash
.claude/skills/legate/scripts/babysit-pr.sh <repo-path> <pr-num>
```

Stdout: JSON
```json
{
  "number": 123,
  "url": "...",
  "state": "OPEN|MERGED|CLOSED",
  "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN",
  "checks": "PASS|FAIL|PENDING|NONE",
  "failed_checks": [{"name": "...", "url": "..."}],
  "review_decision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null",
  "unresolved_threads": [{"id": ..., "path": "...", "line": ..., "body_preview": "..."}],
  "thread_count": 0
}
```

Decision rules per the conductor's CLAUDE.md:
- `state == MERGED` → mark slice merged in `state.json`; only this event unblocks the next step.
- `checks == "FAIL"` → dispatch `/smithy.fix` to the slice's existing worker (NOT a new worker — same-PR amendment).
- `thread_count > 0` → dispatch `/smithy.fix` to the slice's existing worker with the threads as context.
- Otherwise → no action; report status on heartbeat.

The unresolved-thread list comes from GitHub's PR review-thread API (the same source `smithy.pr-review` uses) — `gh pr view --json reviews,comments` does *not* surface unresolved inline threads.

---

## Operation: Refresh smithy status

Returns the parsed Smithy status for the loop's "pick next work" step.

```bash
.claude/skills/legate/scripts/smithy-status.sh <repo-path>
```

Stdout: JSON from `smithy status --format json`, run from inside `<repo-path>`.

---

## Operation: Send to existing worker

Dispatch a follow-up slash command (or any message) to a worker that's already in `waiting`. This is how `/smithy.fix` gets sent to the slice's existing worker — same PR, same amendment, never a fresh worker.

The message body is passed via a **file path**, not inline:

```bash
# Step 1: write the message body to a file under cwd. Use the Write tool
#         (auto-approved per .claude/settings.json's Write(./**) entry).
#         File path: ./fix-msg-<slice-id>.md works. Newlines, code fences,
#         and any other content go into the file directly — no escaping.

# Step 2: dispatch
.claude/skills/legate/scripts/send-to-worker.sh <profile> <session-id-or-title> <message-file>
```

Why a file and not an inline arg: Smithy `/smithy.fix` messages routinely include newlines and code fences. Building those inline forces shell-escape constructs (`$'...\n...'`, heredocs) which auto-mode's classifier flags as risky and pauses on. Writing the body to a file first sidesteps that — the bash command that calls send-to-worker.sh stays a clean `<script> <profile> <session-id> <path>` invocation that matches its `allowed-tools` pattern cleanly.

Wraps `agent-deck -p <profile> session send <id> <message> --wait -q --timeout 600s`. Stdout: the worker's reply (raw text). Use this for `/smithy.fix` dispatch on CI failure or unresolved review threads, and for any operator-style follow-up you want to forward to a specific worker.

---

## Operation: Restart errored worker

Restart a worker session whose agent-deck status is `error`. Per CLAUDE.md, the conductor tries this **once** on `running → error` transition; if the worker errors again on the next heartbeat, escalate via `NEED:` instead of restarting again.

```bash
.claude/skills/legate/scripts/restart-worker.sh <profile> <session-id-or-title>
```

Stdout: agent-deck's confirmation. Don't loop on this — repeated restarts indicate the worker has a deeper problem the operator needs to look at.

---

## Operation: Re-trigger failed CI run

Re-run a GitHub Actions workflow run **on the same workflow file and the same merge commit** when the failure was a transient infra/network hiccup that should pass on a second attempt.

```bash
.claude/skills/legate/scripts/rerun-ci.sh <repo-path> <run-id>
```

`<run-id>` is the GitHub Actions run id, extractable from `babysit-pr`'s `failed_checks[].url` field (`https://github.com/<owner>/<repo>/actions/runs/<RUN-ID>/job/<job-id>` → take the `<RUN-ID>` segment).

**Important: rerun-ci does NOT pick up changes that have landed on main since the original run.** `gh run rerun` reuses the merge commit GitHub computed from `(PR head, main HEAD)` *at the time the original run started*. If the failure was caused by a bug in main that has since been fixed by a parent PR merging, rerun-ci will fail identically — same code, same merge commit, same failure. For that case use `request-rebase.sh` instead, which makes the worker rebase its branch onto current main and force-push so GitHub recomputes the merge commit and re-fires CI from scratch.

When to choose this:
- **Use rerun-ci.sh** when the failure looks transient — a network blip, a flaky test, an Actions infra timeout — and main hasn't materially changed in a way that would cause the test to behave differently. No code change needed on this PR.
- **Use request-rebase.sh** when the failure is "stale main" — the failed run started *before* a known fix landed on main, or the failure shape matches a problem main has since fixed. Force-push after rebase causes a fresh CI on a fresh merge commit.
- **Use send-to-worker.sh /smithy.fix** when the failure is rooted in this PR's own diff — needs a real amendment.

---

## Operation: Request rebase

Ask a worker to rebase its PR branch onto current `origin/main` and force-push. Used when CI is failing on a stale merge commit that doesn't include a fix from a recently-merged parent PR.

```bash
.claude/skills/legate/scripts/request-rebase.sh <profile> <session-id-or-title> <worktree-path>
```

`worktree-path` comes from the slice's `worktree_path` field in `state.json` — recorded by `launch-worker.sh` when the worker was created. The script dispatches a single message to the worker (which owns the worktree) instructing it to `git fetch origin && git rebase origin/main && git push --force-with-lease`, and returns the worker's reply. The worker handles conflicts and reports back so the conductor can escalate via `NEED:` rather than guessing at a resolution.

Why dispatch this through the worker rather than rebasing from outside: the worker owns the worktree as a single writer. If the conductor and the worker both touch files in the same worktree concurrently, they conflict. Workers in `waiting` are ready to act on a message; that's the safe way to mutate the worktree.

Wait for the worker's reply before declaring the slice fixed — and on the next heartbeat, re-run `babysit-pr` to confirm CI actually passes on the rebased branch (the rebase pushes a new SHA, which fires fresh CI; that fresh run is what determines whether the fix worked). Don't loop rebases — if the first rebase doesn't make CI green, the failure is more likely in the PR's own diff and warrants `/smithy.fix`.

---

## Why scripts and not inline pipelines

The conductor runs under Claude Code's `--permission-mode auto`. Its classifier auto-approves common shell tools (`jq`, `gh`, `git`, `agent-deck`, the Read/Edit/Write IDE tools) but pauses on patterns it deems risky — most notably **`python3 -c "<inline script>"`** and `bash -c "$(curl ...)"` chains, because both are arbitrary code execution from an unaudited source.

When the classifier pauses, your tmux session blocks waiting for operator approval. A single such pause inside a heartbeat-driven loop stalls the whole orchestration until someone types `2` (approve + don't-ask-again).

These scripts are pre-canned, version-controlled bash that the operator has audited and committed to the codebase. Claude Code treats `bash <known-script>.sh` as a single-tool invocation that auto-mode classifies as low-risk — no permission prompt, no stall.

The trade-off: when you need a slightly-different shape of operation (e.g. filter workers by *status* instead of group), prefer extending an existing script (or filing an issue to do so) over composing an inline pipeline.

---

## Standing rules (mirror of CLAUDE.md)

- **One PR per Smithy step. Never chain.** A merged PR is the only event that unblocks the next step. Never auto-merge.
- **`/smithy.fix` re-uses the existing worker** (same-PR amendment); never launch a fresh worker for a fix.
- **Cuts on different specs/user-stories** run in parallel as separate workers. **Forges on independent slices** run in parallel; dependent forges wait for the predecessor's PR to merge.
- **Always escalate when about to bypass a merge gate.** Surface a `NEED:` note instead of acting.
