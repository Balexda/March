#!/usr/bin/env bash
# legate skill: launch a new worker session for a Smithy slice.
#
# Atomically: create a worktree on a fresh slice branch, start a Claude session
# in it under the worker group, lock the title, pin --permission-mode auto via
# agent-deck's --extra-arg, and send the initial slash command. Stages the
# verb-cmd to `./dispatch-msg-<slice-id>.md` in the conductor's cwd so
# legate.babysit can re-send it if agent-deck revives the session without
# replaying the original `-m` argument (the WSL2-restart failure mode).
#
# Usage:
#   launch-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <verb-cmd> <slice-id>
#
# Stdout: JSON `{"session_id": "...", "branch": "...", "worktree_path": "..."}`
#         derived by querying agent-deck immediately after launch.
# Exit:
#   0 success
#   1 launch failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: launch-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <verb-cmd> <slice-id>" >&2
  exit 2
fi

PROFILE="$1"
REPO="$2"
TITLE="$3"
GROUP="$4"
BRANCH="$5"
VERB_CMD="$6"
SLICE_ID="$7"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

# slice-id goes into a filename in the conductor's cwd. Restrict it to a
# safe charset so a malformed conductor invocation can't escape the dir
# via `..` or smuggle shell metachars into a script that reads the file
# back. Mirrors the agent-deck conductor-name regex.
if [[ ! "$SLICE_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "invalid slice-id (must match ^[a-zA-Z0-9][a-zA-Z0-9._-]*$): $SLICE_ID" >&2
  exit 2
fi

if ! command -v agent-deck >/dev/null 2>&1; then
  echo "agent-deck not found on PATH" >&2
  exit 1
fi

# Stage the verb-cmd into the conductor's cwd BEFORE we launch. If
# agent-deck launch fails, we'd rather leave a stale stage file than a
# live worker without a recovery path. The babysit skill looks for this
# file when it spots a `stage=implementing` worker that's idle with no
# PR (the WSL2-restart revival signature) and re-sends the contents.
DISPATCH_MSG_PATH="./dispatch-msg-${SLICE_ID}.md"
printf '%s\n' "$VERB_CMD" > "$DISPATCH_MSG_PATH"

echo "launching worker: title='$TITLE' branch='$BRANCH' verb='$VERB_CMD' staged='$DISPATCH_MSG_PATH'" >&2

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
#
# Capture .id into $i before piping $b through index — without the binding,
# `$b | index(.id)` re-evaluates `.id` against $b (the array) and trips jq
# with "Cannot index array with string \"id\"". The binding makes the
# membership lookup explicit: "is $i (the session's id) in $b?"
AFTER="$(agent-deck -p "$PROFILE" list --json \
         | jq --arg g "$GROUP" --argjson b "$BEFORE_IDS" '
             [.[] | select(.group == $g)
              | . as $s
              | select($b | index($s.id) | not)]
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
