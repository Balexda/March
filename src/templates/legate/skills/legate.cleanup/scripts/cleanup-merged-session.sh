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

# Remove the launch-time dispatch-msg stage file if present. Safe even
# when missing (operator may be cleaning up a slice launched before the
# staging fix existed). The file lives in the conductor's cwd; rm -f
# tolerates absence rather than failing the whole cleanup.
DISPATCH_MSG_PATH="./dispatch-msg-${SLICE_ID}.md"
if [[ -f "$DISPATCH_MSG_PATH" ]]; then
  rm -f "$DISPATCH_MSG_PATH"
  echo "cleanup: removed stage file $DISPATCH_MSG_PATH" >&2
fi

# Capture stdout+stderr together so we can pattern-match agent-deck's failure
# mode when the session is already gone.
if out=$(agent-deck -p "$PROFILE" session remove "$SESSION" --prune-worktree --force 2>&1); then
  jq -nc \
    --arg s "$SESSION" \
    --arg sl "$SLICE_ID" \
    '{session_id: $s, slice_id: $sl, removed: true}'
  exit 0
fi

# Match agent-deck's session-missing shape specifically — `Error: session
# '<id>' not found` as of v1.7.79. Both alternatives require the word
# "session" near the missing-indicator so unrelated agent-deck errors
# that happen to contain "not found" / "does not exist" (config-file
# errors, profile-config errors, etc.) fail loudly instead of being
# silently swallowed and treated as an already-removed session.
if echo "$out" | grep -qiE "session [^[:space:]]+ not found|no such session|session [^[:space:]]+ does not exist"; then
  jq -nc \
    --arg s "$SESSION" \
    --arg sl "$SLICE_ID" \
    '{session_id: $s, slice_id: $sl, removed: false, reason: "session_not_found"}'
  exit 0
fi

echo "$out" >&2
exit 1
