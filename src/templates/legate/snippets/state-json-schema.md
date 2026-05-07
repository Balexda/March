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
      "worktree_path": "/home/.../{{REPO_NAME}}-feature-...",
      "stage": "planning|implementing|pr-open|pr-in-fix|pr-rebasing|pr-in-rerun|pr-resolving-conflicts|merged|escalated",
      "pr": { "number": 123, "url": "...", "state": "OPEN|MERGED|CLOSED", "checks": "PASS|FAIL|PENDING", "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN" },
      "last_action": "2026-05-04T18:30:00Z"
    }
  },
  "last_smithy_status_at": "2026-05-04T18:30:00Z",
  "last_heartbeat": "2026-05-04T18:30:00Z"
}
```

`repo.default_branch` and `repo.owner_with_name` are detected once on first run and reused — they do not change for the life of a conductor. `slices[].worktree_path` is the per-slice checkout created by `--worktree`; capture it from `inspect-worker.sh` (legate.dispatch skill) after launch.

Read `state.json` at the start of every turn. Update it after any state-changing action. Store summaries, not transcripts.
