#!/usr/bin/env bash
# legate skill: select "Resume from summary (recommended)" on Claude Code's
# session-restart picker by typing "1" into the worker session. Pairs with
# check-resume-prompt.sh — invoke this only after detection confirms the
# picker is showing.
#
# Why "1" and not Enter: Claude Code's option pickers accept both number
# hotkeys (1/2/3) and Enter-on-cursor. The cursor lands on option 1
# (recommended) by default, so Enter would also work, but `agent-deck
# session send` doesn't ship a zero-length-message path; "1" is the
# shortest valid send and resolves the picker unambiguously.
#
# Why --no-wait: the response to a picker selection isn't a Claude reply.
# After "1" lands, the session loads the summary and then idles at the
# input prompt. `--wait` would block until the next genuine reply, which
# never comes; the heartbeat re-checks the worker state on its next tick.
#
# Usage:
#   select-resume-summary.sh <profile> <session-id-or-title>
#
# Stdout: agent-deck's confirmation line.
# Exit:
#   0 success
#   1 agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: select-resume-summary.sh <profile> <session-id-or-title>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

echo "select-resume-summary: profile=$PROFILE session=$SESSION" >&2

agent-deck -p "$PROFILE" session send "$SESSION" "1" --no-wait -q
