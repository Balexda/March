#!/usr/bin/env bash
# legate skill: filter `smithy status` for dispatchable items.
#
# Usage:
#   find-ready-slices.sh <repo-path>
#
# Internally calls smithy-status.sh, then keeps only non-virtual records
# that carry a `next_action`. Prioritization (cut > forge > render/mark)
# stays in the SKILL.prompt — this script just trims the JSON to the
# fields the dispatch protocol consumes.
#
# Why this script exists: without it, the dispatch protocol had to inline
# `smithy-status.sh ... | python3 -c "..."` to filter the records. The
# legate's auto-mode rules explicitly list `python3 -c` as a NEED-
# escalation (inline interpreters bypass the script-allowlist), so the
# conductor stalled on operator approval every heartbeat. Wrapping the
# filter in an allow-listed bash script keeps the loop autonomous.
#
# Stdout: JSON array of `{type, path, title, status, next_action}`.
# Empty array `[]` when nothing is ready (legitimate quiescent state).
# Exit:
#   0 success (including empty list)
#   1 jq missing or smithy-status.sh failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: find-ready-slices.sh <repo-path>" >&2
  exit 2
fi

REPO="$1"
if [[ ! -d "$REPO" ]]; then
  echo "repo path not a directory: $REPO" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi

# Locate smithy-status.sh next to this script. Same directory in both the
# template tree and the deployed `.claude/skills/legate.dispatch/scripts/`
# tree, so the relative resolution works for tests and production alike.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUS_SCRIPT="$HERE/smithy-status.sh"

if [[ ! -x "$STATUS_SCRIPT" ]]; then
  echo "smithy-status.sh not found alongside find-ready-slices.sh: $STATUS_SCRIPT" >&2
  exit 1
fi

"$STATUS_SCRIPT" "$REPO" \
  | jq '[.records[]
         | select(.next_action != null and (.virtual // false | not))
         | {type, path, title, status, next_action}]'
