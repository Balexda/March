#!/usr/bin/env bash
# legate skill: structured PR state for the babysit decision.
#
# Combines:
#   - `gh pr view --json state,statusCheckRollup,mergeable,reviewDecision,...`
#     for top-level PR state (CI, mergeable, review summary).
#   - `gh api repos/.../pulls/<n>/comments` for unresolved inline review
#     threads — the things /smithy.fix targets. `gh pr view --json comments`
#     does NOT surface unresolved inline threads, so we hit the API directly,
#     same as the smithy.pr-review skill.
#
# Usage:
#   babysit-pr.sh <repo-path> <pr-num>
#
# Stdout: JSON
#   {
#     "number": N,
#     "url": "...",
#     "state": "OPEN|MERGED|CLOSED",
#     "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN",
#     "checks": "PASS|FAIL|PENDING|NONE",
#     "failed_checks": [{"name": "...", "url": "..."}],
#     "review_decision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null",
#     "head_branch": "...",
#     "unresolved_threads": [{"id": ..., "path": "...", "line": ..., "body_preview": "..."}],
#     "thread_count": 0
#   }
#
# Exit:
#   0 success
#   1 gh call failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: babysit-pr.sh <repo-path> <pr-num>" >&2
  exit 2
fi

REPO="$1"
PR="$2"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "pr-num must be a positive integer: $PR" >&2
  exit 2
fi

cd "$REPO"

# Top-level state. statusCheckRollup is an array of CheckRun/StatusContext
# items; we collapse to a single PASS/FAIL/PENDING/NONE summary plus the
# names of any failures so the conductor can pass them to /smithy.fix.
SUMMARY="$(gh pr view "$PR" \
            --json number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title)"

OWNER_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

THREADS_RAW="$(gh api "repos/${OWNER_REPO}/pulls/${PR}/comments" 2>/dev/null || echo '[]')"

# Collapse into the structured response. Note: `gh api .../comments` returns
# all review comments (resolved + unresolved); the GraphQL endpoint that
# distinguishes is what smithy.pr-review uses. For now we surface all inline
# comments and let the conductor judge — that's still strictly better than
# `gh pr view --json comments` which hides them entirely.
echo "$SUMMARY" \
  | jq --argjson threads "$THREADS_RAW" '
      . as $pr
      | {
          number,
          url,
          state,
          mergeable,
          head_branch:     .headRefName,
          title,
          review_decision: .reviewDecision,
          checks: (
            .statusCheckRollup
            | if (. // []) | length == 0 then "NONE"
              elif any(.[]; .conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "ACTION_REQUIRED") then "FAIL"
              elif any(.[]; .status == "IN_PROGRESS" or .status == "QUEUED" or .status == "PENDING") then "PENDING"
              else "PASS"
              end
          ),
          failed_checks: [
            .statusCheckRollup // []
            | .[]
            | select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "ACTION_REQUIRED")
            | {name: (.name // .context // "unknown"), url: (.detailsUrl // .targetUrl // null)}
          ],
          unresolved_threads: [
            $threads
            | .[]
            | {
                id: .id,
                path: (.path // null),
                line: (.line // .original_line // null),
                body_preview: (.body | tostring | .[0:140])
              }
          ],
          thread_count: ($threads | length)
        }
    '
