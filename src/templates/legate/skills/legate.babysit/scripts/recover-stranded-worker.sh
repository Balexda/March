#!/usr/bin/env bash
# legate skill: detect and recover a worker stranded by agent-deck revival.
#
# When the host (WSL2) restarts mid-flight, agent-deck's reviver respawns
# the worker's Claude Code process but does NOT replay the original `-m`
# launch message passed at first launch. The worker
# session keeps its id, group, and worktree — agent-deck records show
# it as alive — but Claude Code comes back to an empty splash screen and
# never sees the work prompt the conductor expects it
# to be working on. The slice sits at `stage=implementing` in state.json
# forever.
#
# The deterministic processor and issue launch path stage the original
# prompt to `<conductor-cwd>/dispatch-msg-<slice-id>.md` precisely so this
# script can detect the failure and re-dispatch.
#
# Detection: the worker's tmux pane (full scrollback) is captured and
# searched for the staged prompt string. A session that received and processed
# its launch message has the prompt echoed in its conversation history
# (Claude Code prints the user message above each response). A revived
# session has only the Claude Code splash banner. Absence of the verb-cmd
# in the scrollback is the signature.
#
# `agent-deck session output -q` is NOT sufficient — it returns only the
# most recent response chunk, not the full conversation, so it would
# always miss the original prompt on a long-running worker and false-positive
# every check. tmux's scrollback buffer is the right source.
#
# Usage:
#   recover-stranded-worker.sh <profile> <session-id-or-title> <slice-id>
#
# Stdout: JSON one of —
#   {"recovered": true,  "slice_id": "...", "resent_verb": "..."}
#   {"recovered": false, "slice_id": "...", "reason": "..."}
# Exit:
#   0 success (regardless of recovered=true|false)
#   1 agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: recover-stranded-worker.sh <profile> <session-id-or-title> <slice-id>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"
SLICE_ID="$3"

# slice-id is interpolated into a filename in cwd. Mirror the constraint
# used by every launch path so a malformed conductor invocation can't
# escape the conductor dir.
if [[ ! "$SLICE_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "invalid slice-id (must match ^[a-zA-Z0-9][a-zA-Z0-9._-]*$): $SLICE_ID" >&2
  exit 2
fi

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found on PATH" >&2
  exit 1
fi

STAGE_FILE="./dispatch-msg-${SLICE_ID}.md"

# No stage file => the slice was launched by a build that predates the
# staging fix, or the file was hand-deleted. Either way we have nothing
# to re-send. Report and exit clean.
if [[ ! -f "$STAGE_FILE" ]]; then
  jq -nc --arg id "$SLICE_ID" \
    '{recovered: false, slice_id: $id, reason: "stage file missing"}'
  exit 0
fi

VERB_CMD="$(<"$STAGE_FILE")"
# Trim trailing newline (printf '%s\n' wrote one) — needed for the
# substring search below to match exactly what Claude Code's pane shows.
VERB_CMD="${VERB_CMD%$'\n'}"

if [[ -z "$VERB_CMD" ]]; then
  jq -nc --arg id "$SLICE_ID" \
    '{recovered: false, slice_id: $id, reason: "stage file empty"}'
  exit 0
fi

# Resolve the tmux session backing this worker. agent-deck's session show
# reports the tmux session name; capture-pane against that with full
# scrollback shows every line Claude Code has emitted since launch (or
# since the host's tmux server last started — which, when it's recent and
# the verb-cmd is missing, IS the revival signature).
SESSION_JSON="$(agent-deck -p "$PROFILE" session show "$SESSION" --json 2>/dev/null || true)"
if [[ -z "$SESSION_JSON" ]]; then
  jq -nc --arg id "$SLICE_ID" \
    '{recovered: false, slice_id: $id, reason: "agent-deck session show failed"}'
  exit 1
fi
TMUX_SESSION="$(printf '%s' "$SESSION_JSON" | jq -r '.tmux_session // empty')"
if [[ -z "$TMUX_SESSION" ]]; then
  jq -nc --arg id "$SLICE_ID" \
    '{recovered: false, slice_id: $id, reason: "session has no tmux_session field"}'
  exit 1
fi

# -S -10000 grabs ~10k lines of scrollback, which is more than a
# never-compacted Claude Code session typically holds. -p prints to
# stdout. Suppress stderr because a missing tmux session would otherwise
# leak a noisy "can't find session" message into our JSON-on-stdout
# contract — we want to fall through to "stranded" in that case anyway.
PANE="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -10000 2>/dev/null || true)"

if [[ "$PANE" == *"$VERB_CMD"* ]]; then
  jq -nc --arg id "$SLICE_ID" \
    '{recovered: false, slice_id: $id, reason: "pane scrollback already contains verb-cmd"}'
  exit 0
fi

# Stranded: re-send via agent-deck (mirrors send-to-worker.sh's call
# shape). --no-wait because the conductor is still in its heartbeat loop
# and shouldn't block; the worker's reply lands on the next heartbeat
# transition.
echo "recover: profile=$PROFILE session=$SESSION slice=$SLICE_ID resending verb-cmd" >&2
agent-deck -p "$PROFILE" session send "$SESSION" "$VERB_CMD" --no-wait -q >&2

jq -nc --arg id "$SLICE_ID" --arg v "$VERB_CMD" \
  '{recovered: true, slice_id: $id, resent_verb: $v}'
