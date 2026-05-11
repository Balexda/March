#!/usr/bin/env bash
# legate skill: send the post-resume "continue your work" nudge to a worker
# that just finished loading from a summary. Modeled after
# legate.babysit/scripts/send-to-worker.sh — file-based message body so
# embedded newlines and code fences don't force shell-escape constructs
# that auto-mode's classifier pauses on.
#
# When to call: after `check-resume-prompt.sh` reported stuck=true on a
# prior heartbeat, you sent "1" via select-resume-summary.sh, and the
# worker's status has now transitioned back to `waiting` (i.e. the summary
# has loaded and Claude is idle at the input prompt). The conductor reads
# state.json + slices.<id>.stage and writes the contextual nudge to a
# file, then calls this script.
#
# Usage:
#   nudge-resumed-worker.sh <profile> <session-id-or-title> <message-file>
#
# Stdout: the worker's reply (raw text, captured via --wait -q).
# Stderr: progress messages.
# Exit:
#   0 success
#   1 agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: nudge-resumed-worker.sh <profile> <session-id-or-title> <message-file>" >&2
  echo "  Pass the nudge body as a path to a file under cwd (Write tool is" >&2
  echo "  auto-approved there). Inline messages with newlines force shell" >&2
  echo "  escape constructs that auto-mode pauses on." >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"
MESSAGE_FILE="$3"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi
if [[ ! -f "$MESSAGE_FILE" ]]; then
  echo "message file not found: $MESSAGE_FILE" >&2
  exit 2
fi

MESSAGE="$(<"$MESSAGE_FILE")"
echo "nudge: profile=$PROFILE session=$SESSION ($(printf '%s' "$MESSAGE" | head -c 60)...)" >&2

# `--wait` blocks until the worker is ready + replies; `-q` returns only
# the raw reply (no headers); the 600s timeout matches send-to-worker.sh
# so a nudge that triggers `/smithy.fix`-style follow-up work doesn't time
# out before the worker can push and respond.
agent-deck -p "$PROFILE" session send "$SESSION" "$MESSAGE" --wait -q --timeout 600s
