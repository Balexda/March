#!/usr/bin/env bash
# legate skill: remove a merged slice's worker session and prune its worktree.
#
# Wraps `agent-deck -p <profile> session remove <id> --prune-worktree --force`.
# That single command stops the tmux process, removes the git worktree, and
# deletes the registry entry. `--force` is required because the worker may
# still be in `running`/`waiting`/`idle` state when its PR merges; once the
# PR is in main there's nothing useful left for the worker to do.
#
# Tolerates "session not found" as idempotent success — handles the case
# where a prior heartbeat's cleanup completed the agent-deck call but
# crashed before the state.json edit landed. The retry then succeeds and
# the conductor proceeds to move the slice into archived_slices.
#
# Usage:
#   cleanup-merged-session.sh <profile> <worker-session-id> <slice-id>
#
# Stdout: JSON `{"session_id": "...", "slice_id": "...", "removed": true|false, "reason"?: "session_not_found"}`
# Exit:
#   0 success (including session_not_found idempotent case)
#   1 agent-deck call failed for any other reason
#   2 invalid input
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: cleanup-merged-session.sh <profile> <worker-session-id> <slice-id>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"
SLICE_ID="$3"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

echo "cleanup: profile=$PROFILE session=$SESSION slice=$SLICE_ID" >&2

# Capture stdout+stderr together so we can pattern-match agent-deck's failure
# mode when the session is already gone.
if out=$(agent-deck -p "$PROFILE" session remove "$SESSION" --prune-worktree --force 2>&1); then
  jq -nc \
    --arg s "$SESSION" \
    --arg sl "$SLICE_ID" \
    '{session_id: $s, slice_id: $sl, removed: true}'
  exit 0
fi

# Defensive regex: agent-deck's exact "not found" wording may vary across
# versions. Match any of the common phrasings as idempotent success.
if echo "$out" | grep -qiE "not found|no such session|does not exist"; then
  jq -nc \
    --arg s "$SESSION" \
    --arg sl "$SLICE_ID" \
    '{session_id: $s, slice_id: $sl, removed: false, reason: "session_not_found"}'
  exit 0
fi

echo "$out" >&2
exit 1
