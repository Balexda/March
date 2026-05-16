#!/usr/bin/env bash
# search-issues.sh — Search GitHub issues in the current repo.
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/search-issues.sh <state> <search-query> [limit]
#
#   state:        open | closed | all
#   search-query: any gh-compatible search string (e.g. "[Story] My Title in:title")
#   limit:        optional, defaults to 10
#
# Output: JSON array [{"number": N, "title": "...", "state": "...", "body": "..."}, ...].
# Returns an empty array ([]) if no issues match.

set -euo pipefail

STATE="${1:?state required (open|closed|all)}"
QUERY="${2:?search query required}"
LIMIT="${3:-10}"

gh issue list \
  --search "$QUERY" \
  --state "$STATE" \
  --json number,title,state,body \
  --limit "$LIMIT"
