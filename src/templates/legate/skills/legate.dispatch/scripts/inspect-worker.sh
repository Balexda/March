#!/usr/bin/env bash
# legate.dispatch skill: read agent-deck session details for a worker as JSON.
#
# Wraps `agent-deck session show --json` so the conductor can capture the
# session ID, worktree path, branch, and parent linkage after `launch-worker.sh`
# returns. Without this script the conductor would call `agent-deck session
# show` directly, which is NOT covered by either skill's allowed-tools and
# stalls auto-mode's classifier on a permission prompt — which historically
# locked up the heartbeat loop until manually unstuck.
#
# Usage:
#   inspect-worker.sh <profile> <session-id-or-title>
#
# Stdout: JSON from `agent-deck session show` (id, title, status, group,
# tmux_session, claude_session_id, path, parent_session_id, ...). Includes
# the worktree path under `path` when the session was launched with --worktree.
# Stderr: progress messages.
# Exit:
#   0 success
#   1 agent-deck call failed (session not found, agent-deck error)
#   2 invalid input
#
# When NOT to use:
#   - To send a message to a worker → `send-to-worker.sh` (legate.babysit).
#   - To list every worker in your group → `list-workers.sh` (legate.babysit).
#     This script is for reading a single, named session's full detail.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: inspect-worker.sh <profile> <session-id-or-title>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"

if [[ -z "$PROFILE" ]]; then
  echo "profile is empty" >&2
  exit 2
fi
if [[ -z "$SESSION" ]]; then
  echo "session id/title is empty" >&2
  exit 2
fi

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

echo "inspect: profile=$PROFILE session=$SESSION" >&2

exec agent-deck -p "$PROFILE" session show "$SESSION" --json
