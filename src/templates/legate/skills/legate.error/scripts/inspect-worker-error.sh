#!/usr/bin/env bash
# legate.error skill: inspect a worker session in agent-deck error state.
#
# Usage:
#   inspect-worker-error.sh <profile> <session-id-or-title>
#
# Stdout: plain text report containing session metadata and recent output.
# Exit:
#   0 success
#   1 agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: inspect-worker-error.sh <profile> <session-id-or-title>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

echo "== session show =="
agent-deck -p "$PROFILE" session show "$SESSION"
echo
echo "== recent output =="
agent-deck -p "$PROFILE" session output "$SESSION" -q
