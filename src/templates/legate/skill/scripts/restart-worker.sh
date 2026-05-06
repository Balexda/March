#!/usr/bin/env bash
# legate skill: restart a worker session whose agent-deck status is `error`.
# Wraps `agent-deck session restart`. Per CLAUDE.md, the conductor tries
# this once on `running → error` transition; if it errors again on the
# next heartbeat, escalate via NEED:.
#
# Usage:
#   restart-worker.sh <profile> <session-id-or-title>
#
# Stdout: agent-deck's confirmation line.
# Exit:
#   0 success
#   1 agent-deck call failed
#   2 invalid input
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

echo "restart: profile=$PROFILE session=$SESSION" >&2

agent-deck -p "$PROFILE" session restart "$SESSION"
