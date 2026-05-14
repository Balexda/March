#!/usr/bin/env bash
# legate.error skill: restart a worker session after classifying the error as
# a transient crash. Do not use for auth failures or unknown repeated errors.
#
# Usage:
#   restart-worker.sh <profile> <session-id-or-title>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: restart-worker.sh <profile> <session-id-or-title>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

agent-deck -p "$PROFILE" session restart "$SESSION"
