#!/usr/bin/env bash
# legate skill: launch a new worker session for a Smithy slice.
#
# Atomically: create a worktree on a fresh slice branch, start a Claude session
# in it under the worker group, lock the title, pin --permission-mode auto via
# agent-deck's --extra-arg, and send the initial slash command.
#
# Usage:
#   launch-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <verb-cmd>
#
# Stdout: JSON `{"session_id": "...", "branch": "...", "worktree_path": "..."}`
#         derived by querying agent-deck immediately after launch.
# Exit:
#   0 success
#   1 launch failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: launch-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <verb-cmd>" >&2
  exit 2
fi

PROFILE="$1"
REPO="$2"
TITLE="$3"
GROUP="$4"
BRANCH="$5"
VERB_CMD="$6"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

echo "launching worker: title='$TITLE' branch='$BRANCH' verb='$VERB_CMD'" >&2

# Snapshot existing sessions in the group so we can identify the new one
# afterward. agent-deck launch doesn't reliably print a parseable session id
# on stdout across versions, so we diff before/after by created_at.
#
# Carry the snapshot as a JSON array (passed via --argjson below) rather than
# a comma-joined string + substring match: substring matching can false-filter
# a new session whose id happens to be a substring of an existing one in the
# same group, and the failure mode is silent ("could not identify newly
# launched worker") — a class of bug that only surfaces under specific id
# collisions.
BEFORE_IDS="$(agent-deck -p "$PROFILE" list --json \
              | jq -c --arg g "$GROUP" '[.[] | select(.group == $g) | .id]')"

# The launch itself. --title-lock prevents Claude's auto-rename from clobbering
# the title; --extra-arg pair pins --permission-mode auto on the worker session
# (agent-deck has no per-launch --auto-mode flag, so we go through extra-args).
agent-deck -p "$PROFILE" launch "$REPO" \
  -t "$TITLE" \
  -c claude \
  -g "$GROUP" \
  --worktree "$BRANCH" -b \
  --title-lock \
  --extra-arg --permission-mode --extra-arg auto \
  -m "$VERB_CMD" >&2

# Find the new session: anything in the group whose id is not in the
# BEFORE_IDS array. `index` over an array does exact-element membership;
# unlike `inside` over a comma-joined string it doesn't risk a false positive
# from substring matches.
AFTER="$(agent-deck -p "$PROFILE" list --json \
         | jq --arg g "$GROUP" --argjson b "$BEFORE_IDS" '
             [.[] | select(.group == $g)
              | select($b | index(.id) | not)]
             | sort_by(.created_at // 0)
             | last // null
         ')"

if [[ "$AFTER" == "null" ]]; then
  echo "could not identify newly launched worker via diff" >&2
  exit 1
fi

# Extract the fields the conductor needs for state.json. worktree_branch /
# worktree_path may be null on some agent-deck versions for sessions launched
# this way (see SmithyCLI#297 / agent-deck behavior); pass through whatever's
# there and let the conductor reconcile via discover-pr.sh later.
echo "$AFTER" | jq '{
  session_id: .id,
  title: .title,
  branch:        (.worktree_branch // null),
  worktree_path: (.worktree_path   // null),
  status:        .status
}'
