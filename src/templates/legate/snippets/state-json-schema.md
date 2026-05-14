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
      "kind": "smithy|issue (optional; defaults to smithy when absent)",
      "issue (only when kind == \"issue\"; omitted for smithy slices)": { "number": 42, "url": "...", "title": "..." },
      "worker_session_id": "...",
      "worker_title": "...",
      "branch": "feature/...",
      "actual_branch": "feature/... (or null until babysit's discover-pr.sh fills it on the worker's first push)",
      "worktree_path": "/home/.../{{REPO_NAME}}-feature-...",
      "stage": "planning|implementing|pr-open|pr-in-fix|pr-rebasing|pr-in-rerun|pr-resolving-conflicts|merged|escalated",
      "pr": { "number": 123, "url": "...", "state": "OPEN|MERGED|CLOSED", "checks": "PASS|FAIL|PENDING", "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN" },
      "pr_open_at": "2026-05-11T17:00:00Z (set by babysit each time the slice transitions to pr-open; used to detect new reviewer comments in single-user setups)",
      "resume_pending (optional; omitted when not in a resume cycle)": "selected",
      "last_action": "2026-05-04T18:30:00Z",
      "last_action_note": "Launched cut: spawn-dispatch US5 via /smithy.cut"
    }
  },
  "archived_slices": {
    "<merged-slice-id>": {
      "pr_number": 124,
      "pr_url": "https://github.com/Owner/Repo/pull/124",
      "worker_title": "cut: spawn-dispatch US5",
      "terminal_state": "MERGED|CLOSED",
      "merged_at": "2026-05-07T22:30:00Z"
    }
  },
  "last_smithy_status_at": "2026-05-04T18:30:00Z",
  "last_heartbeat": "2026-05-04T18:30:00Z"
}
```

`repo.default_branch` and `repo.owner_with_name` are detected once on first run and reused — they do not change for the life of a conductor. `slices[].worktree_path` is the per-slice checkout created by `--worktree`; capture it from `inspect-worker.sh` (legate.dispatch skill) after launch.

Four slice fields fill in over time and are `null` (or absent) on a freshly-launched slice:

- `slices[].pr` is `null` until the worker runs `gh pr create` and babysit's `discover-pr.sh` finds the PR URL. Discovery runs every heartbeat for any `implementing`-stage slice whose worker is `waiting` or `idle` — typically the worker's `running → waiting` transition triggers it, but workers that pass straight through to `idle` are also covered. Once populated, it carries `{number, url, state, checks, mergeable}` per the babysit decision tree.
- `slices[].actual_branch` is `null` until the same `discover-pr.sh` pass — `/smithy.*` slash-commands sometimes rename the worker's branch on push (see SmithyCli#297), so the originally-requested `branch` and the actual branch on origin can diverge. Babysit captures the actual one here so subsequent rebase/conflict-resolution dispatches target the right branch.
- `slices[].pr_open_at` is absent until babysit transitions the slice to `pr-open`. It's the ISO-8601 timestamp of that transition, refreshed every time the slice **re-enters** `pr-open` (e.g. after a `/smithy.fix` cycle completes). The babysit decision tree compares this against per-thread `last_comment_at` to detect *new* reviewer activity in single-user setups where the worker and the operator share a GitHub identity — see the babysit SKILL for the exact rule. When unset, treat any unresolved thread as needing response (one-time pessimistic catch-up; the next babysit pass will record `pr_open_at` correctly).
- `slices[].last_action_note` is a free-form summary of the most recent state-changing action — written by dispatch on launch (`"Launched ... via /smithy.<verb>"`), by issue intake on launch (`"Launched issue-#<N> worker — \"<title>\""`), by babysit on stage transitions, and by cleanup on retry-able failures (`"cleanup failed: <error>"`). Read it before acting on a slice; the verification-rule snippet documents how to interpret it.

The deterministic processor may add `last_processor_action*` and `last_processor_request*` bookkeeping fields to a live slice. These are idempotency keys and timestamps for processor-sent babysit actions or `[PROCESSOR]` escalations; keep them when editing state by hand unless you intentionally want the processor to retry that exact action.

`slices[].kind` discriminates the slice's origin: `"smithy"` (default; created by `legate.dispatch` from `smithy status`) or `"issue"` (created by `legate.issue` from an operator-handed GitHub issue). When absent, treat as `"smithy"` for backwards compatibility with state files written before this field existed. Issue-kind slices use the synthetic id `issue-<N>` (where `<N>` is the issue number) and carry an `issue: { number, url, title }` subobject for audit; Smithy-kind slices omit `issue`. `legate.babysit` and `legate.cleanup` operate uniformly on `slices` regardless of `kind` — the discriminator exists so audit trail (task-log entries, archived_slices records) and any future kind-specific filtering can branch cleanly.

`slices[].resume_pending` is an in-flight flag owned by `legate.resume`. Two states: absent (the default; no resume cycle), or `"selected"` (the resume skill detected Claude Code's "Resume from summary" picker on this worker, sent `"1"` to clear it, and owes the slice a stage-aware nudge on a subsequent heartbeat once the summary has loaded). When the nudge is delivered, the key is **deleted** — not set to `null` or `""` — so a grep for genuinely-pending slices is straightforward. Every downstream skill (babysit, merge, cleanup, dispatch) **skips** any slice whose `resume_pending == "selected"` for the rest of that heartbeat; the worker's TUI may not be fully cleared and an `agent-deck session send` into a half-cleared picker is silently lost. The field is not carried into `archived_slices`; resume state is in-flight only.

`archived_slices` is the breadcrumb store written by cleanup after a terminal PR's worker session has been torn down. Entries hold only what's needed downstream: PR number/URL (audit), worker title (debugging), terminal state, and the terminal timestamp (`merged_at` for `MERGED`, `closed_at` for `CLOSED`). The full slice record does not carry forward — `task-log.md` and the deterministic processor log are the audit trail. `legate.dispatch` consults both `slices.<id>` (with `pr.state == "MERGED"` for slices merged this heartbeat that cleanup hasn't yet processed) and `archived_slices.<id>` entries whose `terminal_state == "MERGED"` or `merged_at` is present when checking whether a downstream slice's dependencies have all merged. `CLOSED` archives mean the worker is gone, not that dependencies are satisfied.

Stage transitions into `merged` come from two sources: `legate.babysit` writes `merged` when it observes `state == "MERGED"` on a PR (i.e. the operator merged in the GitHub UI, or `legate.merge` already merged earlier this heartbeat and GitHub has reflected it); `legate.merge` writes `merged` directly after a successful auto-merge of a slice it transitioned out of `pr-open`. Both paths are equivalent from cleanup's perspective.

Read `state.json` at the start of every turn. Update it after any state-changing action. Store summaries, not transcripts.
