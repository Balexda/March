#!/usr/bin/env bash
# add-comment.sh — Post a top-level PR conversation comment
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/add-comment.sh <owner/repo> <pr-number> <body-file>
#
# The body file must contain JSON in the shape: {"body": "comment text"}
#
# Every March-posted conversation reply is prefixed with the stable `[march-bot]`
# marker (issue #374) so the legate's author-independent non-thread comment
# capture (#366) recognizes the steward's own replies and skips them instead of
# re-processing them in a loop. The prefix is added here (idempotently) so it
# holds regardless of what the caller wrote.

set -euo pipefail

REPO="$1"
PR="$2"
BODY_FILE="$3"

MARKER="[march-bot]"

PATCHED_FILE="$(mktemp)"
trap 'rm -f "$PATCHED_FILE"' EXIT

jq --arg marker "$MARKER" '
  .body = ((.body // "") | tostring)
  | if (.body | startswith($marker)) then .
    else .body = ($marker + " " + .body) end
' "$BODY_FILE" > "$PATCHED_FILE"

gh api "repos/$REPO/issues/$PR/comments" \
  --method POST \
  --input "$PATCHED_FILE"
