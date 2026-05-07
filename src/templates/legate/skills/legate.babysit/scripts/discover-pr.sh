#!/usr/bin/env bash
# legate skill: two-tier PR discovery for a worker, resilient to branch
# renames by /smithy.* slash-commands (see SmithyCLI#297).
#
# Tier 1 (primary): grep the worker's last tmux output for the PR URL it
#                   printed when it ran `gh pr create`.
# Tier 2 (fallback): `gh pr list --author @me --state open` filtered by
#                    creation timestamp (post-dispatch) and sorted by recency.
#
# Usage:
#   discover-pr.sh <profile> <session-id> <repo-path> [<dispatch-iso-timestamp>]
#
# Stdout: JSON {number, url, headRefName, state, mergeable, ...}, or empty
#         object `{}` when no PR is found yet.
# Stderr: which tier matched (`primary` or `fallback`), or `none`.
# Exit:
#   0 success (including the no-PR-yet case)
#   1 gh / agent-deck call failed
#   2 invalid input
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: discover-pr.sh <profile> <session-id> <repo-path> [<dispatch-iso-timestamp>]" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"
REPO="$3"
SINCE="${4:-}"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

# Tier 1: read the worker's output and grep for a PR URL.
URL=""
if command -v agent-deck >/dev/null 2>&1; then
  OUTPUT="$(agent-deck -p "$PROFILE" session output "$SESSION" -q 2>/dev/null || true)"
  URL="$(printf '%s\n' "$OUTPUT" | grep -oE 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | tail -1 || true)"
fi

if [[ -n "$URL" ]]; then
  PR_NUM="${URL##*/}"
  echo "primary" >&2
  cd "$REPO"
  gh pr view "$PR_NUM" \
    --json number,url,headRefName,state,mergeable,statusCheckRollup,createdAt,title
  exit 0
fi

# Tier 2: gh pr list --author @me, sorted by recency, optionally filtered to
# PRs opened after the dispatch timestamp. The conductor passes `last_action`
# from state.json so we don't pick up unrelated open PRs.
cd "$REPO"
ALL="$(gh pr list --author @me --state open \
        --json number,url,headRefName,state,mergeable,statusCheckRollup,createdAt,title \
        2>/dev/null || echo '[]')"

if [[ -n "$SINCE" ]]; then
  FILTERED="$(printf '%s' "$ALL" | jq --arg t "$SINCE" '[.[] | select(.createdAt >= $t)]')"
else
  FILTERED="$ALL"
fi

CHOSEN="$(printf '%s' "$FILTERED" | jq 'sort_by(.createdAt) | reverse | (.[0] // null)')"

if [[ "$CHOSEN" == "null" ]]; then
  echo "none" >&2
  echo '{}'
  exit 0
fi

echo "fallback" >&2
printf '%s\n' "$CHOSEN"
