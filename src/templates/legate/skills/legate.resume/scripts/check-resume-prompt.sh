#!/usr/bin/env bash
# legate skill: detect Claude Code's "Resume from summary" picker in a
# worker session's tmux output. Claude Code emits the picker on session
# restart when the prior session was long-running or token-heavy:
#
#   This session is 7h 4m old and 231.5k tokens.
#
#   Resuming the full session will consume a substantial portion of your
#   usage limits. We recommend resuming from a summary.
#
#   > 1. Resume from summary (recommended)
#     2. Resume full session as-is
#     3. Don't ask me again
#
# Until the picker is resolved, the worker cannot process any `/smithy.*`
# dispatch the conductor sends — keystrokes are intercepted by the picker.
# Running this check at the top of every heartbeat is how the conductor
# notices a worker that needs picker-clearing before babysit/merge/etc.
# decide what else to dispatch.
#
# Detection markers (any one match → stuck=true):
#   - "Resume from summary" — the option-1 label, stable across releases
#   - "Resuming the full session" — the picker preamble (belt-and-suspenders)
#
# Usage:
#   check-resume-prompt.sh <profile> <session-id-or-title>
#
# Stdout: JSON {stuck, marker, excerpt}.
#   stuck   — true if either marker matched the captured output, else false
#   marker  — which substring matched ("Resume from summary" or
#             "Resuming the full session"), empty when stuck=false
#   excerpt — the matched line, truncated, for the heartbeat reply
# Exit:
#   0 success (including the not-stuck case)
#   1 agent-deck or jq invocation failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: check-resume-prompt.sh <profile> <session-id-or-title>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi

# `session output -q` returns the last response only; on a freshly-restarted
# session the picker is what fills the pane, so the markers will be in this
# capture. Suppress agent-deck stderr so a transient lookup failure surfaces
# as stuck=false rather than killing the heartbeat — the next tick re-tries.
OUTPUT="$(agent-deck -p "$PROFILE" session output "$SESSION" -q 2>/dev/null || true)"

MARKER=""
if printf '%s' "$OUTPUT" | grep -Fq "Resume from summary"; then
  MARKER="Resume from summary"
elif printf '%s' "$OUTPUT" | grep -Fq "Resuming the full session"; then
  MARKER="Resuming the full session"
fi

if [[ -z "$MARKER" ]]; then
  jq -n '{stuck: false, marker: "", excerpt: ""}'
  exit 0
fi

EXCERPT="$(printf '%s\n' "$OUTPUT" | grep -F "$MARKER" | head -1 | cut -c1-200)"
jq -n --arg m "$MARKER" --arg e "$EXCERPT" \
  '{stuck: true, marker: $m, excerpt: $e}'
