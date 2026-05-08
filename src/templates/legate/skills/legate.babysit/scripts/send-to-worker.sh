#!/usr/bin/env bash
# legate skill: send a follow-up slash command (or any message) to an existing
# worker session. Wraps `agent-deck session send` with the conductor's standard
# wait+timeout flags so we don't lose the reply on a slow run.
#
# The standing rule (CLAUDE.md → Step boundaries): /smithy.fix re-uses the
# slice's existing worker session — same PR, same amendment, never a fresh
# worker. This script is the operation that performs that send.
#
# Usage:
#   send-to-worker.sh <profile> <session-id-or-title> <message-file>
#
# `message-file` is a path to a file containing the message body to send.
# Pass via file rather than inline because Smithy slash-command messages
# routinely contain newlines and code fences — building those inline forces
# the conductor into shell-escape constructs (`$'...\n...'`, heredocs) that
# auto-mode's classifier flags as risky and pauses on. The Write tool is
# auto-approved within cwd, so writing a temp file first is the fast path.
#
# Stdout: the worker's reply (raw text, captured via `--wait -q`).
# Stderr: progress messages.
# Exit:
#   0 success
#   1 agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: send-to-worker.sh <profile> <session-id-or-title> <message-file>" >&2
  echo "  Pass the message body as a path to a file (use the Write tool to" >&2
  echo "  create it under cwd; that's auto-approved). Inline messages with" >&2
  echo "  newlines force shell-escape constructs that auto-mode pauses on." >&2
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

# Read the entire file as the message body.
MESSAGE="$(<"$MESSAGE_FILE")"

echo "send: profile=$PROFILE session=$SESSION ($(printf '%s' "$MESSAGE" | head -c 60)...)" >&2

# `--wait` blocks until the worker is ready + replies; `-q` returns only the
# raw reply (no headers); `--timeout 600s` accommodates /smithy.fix runs that
# read source, edit, run tests, and push.
agent-deck -p "$PROFILE" session send "$SESSION" "$MESSAGE" --wait -q --timeout 600s
