## State Management — `./state.json`

Maintain a slim, structured state file across compactions:

```json
{
  "profile": "{{PROFILE}}",
  "repo": {
    "name": "{{REPO_NAME}}",
    "path": "{{REPO_PATH}}",
    "default_branch": "main",
    "owner_with_name": "Owner/Repo"
  },
  "slices": {
    "<slice-id>": {
      "worker_session_id": "...",
      "worker_title": "...",
      "branch": "feature/...",
      "actual_branch": "feature/... (or null until babysit's discover-pr.sh fills it on the worker's first push)",
      "worktree_path": "/home/.../{{REPO_NAME}}-feature-...",
      "stage": "planning|implementing|pr-open|pr-in-fix|pr-rebasing|pr-in-rerun|pr-resolving-conflicts|merged|escalated",
      "pr": { "number": 123, "url": "...", "state": "OPEN|MERGED|CLOSED", "checks": "PASS|FAIL|PENDING", "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN" },
      "last_action": "2026-05-04T18:30:00Z",
      "last_action_note": "Launched cut: spawn-dispatch US5 via /smithy.cut"
    }
  },
  "archived_slices": {
    "<merged-slice-id>": {
      "pr_number": 124,
      "pr_url": "https://github.com/Owner/Repo/pull/124",
      "worker_title": "cut: spawn-dispatch US5",
      "merged_at": "2026-05-07T22:30:00Z"
    }
  },
  "last_smithy_status_at": "2026-05-04T18:30:00Z",
  "last_heartbeat": "2026-05-04T18:30:00Z"
}
```

`repo.default_branch` and `repo.owner_with_name` are detected once on first run and reused — they do not change for the life of a conductor. `slices[].worktree_path` is the per-slice checkout created by `--worktree`; capture it from `inspect-worker.sh` (legate.dispatch skill) after launch.

Three slice fields fill in over time and are `null` (or absent) on a freshly-launched slice:

- `slices[].pr` is `null` until the worker runs `gh pr create` and babysit's `discover-pr.sh` finds the PR URL on the next `running → waiting` transition. Once populated, it carries `{number, url, state, checks, mergeable}` per the babysit decision tree.
- `slices[].actual_branch` is `null` until the same `discover-pr.sh` pass — `/smithy.*` slash-commands sometimes rename the worker's branch on push (see SmithyCli#297), so the originally-requested `branch` and the actual branch on origin can diverge. Babysit captures the actual one here so subsequent rebase/conflict-resolution dispatches target the right branch.
- `slices[].last_action_note` is a free-form summary of the most recent state-changing action — written by dispatch on launch (`"Launched ... via /smithy.<verb>"`), by babysit on stage transitions, and by cleanup on retry-able failures (`"cleanup failed: <error>"`). Read it before acting on a slice; the verification-rule snippet documents how to interpret it.

`archived_slices` is the breadcrumb store written by `legate.cleanup` after a slice's PR merges and its worker session has been torn down. Each entry holds only what's needed downstream: the PR number/URL (audit), the worker title (debugging), and the merge timestamp. The full slice record does not carry forward — `task-log.md` is the audit trail. `legate.dispatch` consults both `slices.<id>` (with `pr.state == "MERGED"` for slices merged this heartbeat that cleanup hasn't yet processed) and `archived_slices.<id>` (for slices merged in a prior heartbeat) when checking whether a downstream slice's dependencies have all merged.

Read `state.json` at the start of every turn. Update it after any state-changing action. Store summaries, not transcripts.
