#!/usr/bin/env bash
# legate skill: list worker sessions in the legate-workers group.
#
# Usage:
#   list-workers.sh <profile> <worker-group>
#
# Stdout: JSON array of worker sessions (id, title, status, worktree_branch,
#         worktree_path, parent_session_id) — one entry per session in the
#         given profile + group.
# Exit:
#   0 success
#   1 agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: list-workers.sh <profile> <worker-group>" >&2
  exit 2
fi

PROFILE="$1"
GROUP="$2"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

# agent-deck list --json returns an array of session objects. Filter to the
# requested group and pick only the fields the conductor cares about. jq's
# strict mode catches schema drift early.
agent-deck -p "$PROFILE" list --json \
  | jq --arg g "$GROUP" '
      [.[]
       | select(.group == $g)
       | {
           id,
           title,
           status,
           worktree_branch: (.worktree_branch // null),
           worktree_path:   (.worktree_path   // null),
           parent_session_id: (.parent_session_id // null),
           path
         }
      ]
    '
