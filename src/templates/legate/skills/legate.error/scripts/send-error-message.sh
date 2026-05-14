#!/usr/bin/env bash
# legate.error skill: send a diagnostic or recovery prompt to an errored worker.
#
# Usage:
#   send-error-message.sh <profile> <session-id-or-title> <message-file>
#
# `message-file` contains the full message body. Passing via file keeps
# multi-line recovery prompts out of shell escaping constructs that auto-mode
# treats as risky.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: send-error-message.sh <profile> <session-id-or-title> <message-file>" >&2
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
echo "error-message: profile=$PROFILE session=$SESSION ($(printf '%s' "$MESSAGE" | head -c 60)...)" >&2
agent-deck -p "$PROFILE" session send "$SESSION" "$MESSAGE" --wait -q --timeout 600s
