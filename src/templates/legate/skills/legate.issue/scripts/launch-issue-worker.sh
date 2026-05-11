#!/usr/bin/env bash
# legate.issue skill: launch a new worker session for a GitHub issue.
#
# Variant of legate.dispatch's launch-worker.sh. Two differences:
#
#   1. The initial message is read from a file rather than passed inline. Issue
#      prompts contain newlines, code fences, and reproduction snippets — building
#      that inline forces shell-escape constructs (`$'...\n...'`, heredocs) that
#      auto-mode's classifier flags as risky and pauses on. Write the prompt
#      with the Write tool first (auto-approved within cwd), then point this
#      script at it. (Same convention as legate.babysit's send-to-worker.sh.)
#
#   2. The launch flags are otherwise identical: `--worktree <branch> -b`,
#      `--title-lock`, `-c claude`, `--extra-arg --permission-mode --extra-arg
#      auto`. Workers spawned for issues run under the same auto-mode + worktree
#      isolation as Smithy slice workers; nothing about origin (smithy vs issue)
#      changes their runtime posture.
#
# Usage:
#   launch-issue-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <prompt-file>
#
# Stdout: JSON `{"session_id": "...", "title": "...", "branch": "...",
#                "worktree_path": "...", "status": "..."}` derived by querying
#          agent-deck immediately after launch (same shape as launch-worker.sh).
# Exit:
#   0 success
#   1 launch failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: launch-issue-worker.sh <profile> <repo-path> <slice-title> <worker-group> <branch> <prompt-file>" >&2
  echo "  Pass the worker's initial prompt as a path to a file (use the Write" >&2
  echo "  tool to create it under cwd; that's auto-approved). Inline messages" >&2
  echo "  with newlines force shell-escape constructs that auto-mode pauses on." >&2
  exit 2
fi

PROFILE="$1"
REPO="$2"
TITLE="$3"
GROUP="$4"
BRANCH="$5"
PROMPT_FILE="$6"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "prompt file not found: $PROMPT_FILE" >&2
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

# Read the prompt. Single positional `-m` argument; agent-deck handles the
# eventual delivery to Claude Code (no shell quoting from us).
PROMPT="$(<"$PROMPT_FILE")"
if [[ -z "$PROMPT" ]]; then
  echo "prompt file is empty: $PROMPT_FILE" >&2
  exit 2
fi

echo "launching issue worker: title='$TITLE' branch='$BRANCH' prompt-bytes=${#PROMPT}" >&2

# Snapshot existing sessions in the group so we can identify the new one
# afterward — same approach as legate.dispatch's launch-worker.sh. agent-deck
# launch doesn't reliably print a parseable session id on stdout across
# versions, so we diff before/after by created_at.
#
# Carry the snapshot as a JSON array (passed via --argjson below) rather than
# a comma-joined string + substring match: substring matching can false-filter
# a new session whose id happens to be a substring of an existing one in the
# same group, and the failure mode is silent ("could not identify newly
# launched issue worker") — a class of bug that only surfaces under specific
# id collisions.
BEFORE_IDS="$(agent-deck -p "$PROFILE" list --json \
              | jq -c --arg g "$GROUP" '[.[] | select(.group == $g) | .id]')"

# Same launch invariants as Smithy-slice workers:
#   --worktree <branch> -b   isolated git worktree on a new branch per worker
#   --title-lock             prevent Claude's auto-rename from clobbering title
#   -c claude                agent runtime
#   --extra-arg pair         pin --permission-mode auto on the worker session
agent-deck -p "$PROFILE" launch "$REPO" \
  -t "$TITLE" \
  -c claude \
  -g "$GROUP" \
  --worktree "$BRANCH" -b \
  --title-lock \
  --extra-arg --permission-mode --extra-arg auto \
  -m "$PROMPT" >&2

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
  echo "could not identify newly launched issue worker via diff" >&2
  exit 1
fi

echo "$AFTER" | jq '{
  session_id: .id,
  title: .title,
  branch:        (.worktree_branch // null),
  worktree_path: (.worktree_path   // null),
  status:        .status
}'
