#!/usr/bin/env bash
# legate skill: structured PR state for the babysit decision.
#
# Combines:
#   - `gh pr view --json state,statusCheckRollup,mergeable,reviewDecision,...`
#     for top-level PR state (CI, mergeable, review summary, head branch).
#   - GraphQL `pullRequest.reviewThreads` for *unresolved* inline review
#     threads — REST `pulls/<n>/comments` returns *every* inline comment
#     including the worker's own replies, which falsely inflates the
#     thread count and causes the conductor to loop `/smithy.fix` after
#     the worker has already addressed the threads. The GraphQL query
#     exposes `isResolved` so we filter to only threads still needing
#     attention. Same pattern smithy.pr-review's get-comments.sh uses.
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
#     "head_branch": "...",
#     "title": "...",
#     "review_decision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null",
#     "checks": "PASS|FAIL|PENDING|NONE",
#     "failed_checks": [{"name": "...", "url": "..."}],
#     "unresolved_threads": [{"id": ..., "path": "...", "line": ...,
#                             "author": "...", "body_preview": "...",
#                             "last_author": "...", "last_comment_at": "ISO-8601",
#                             "comment_count": ...,
#                             "needs_response": bool}],
#     "thread_count": <count of unresolved>,
#     "needs_response_count": <subset where last comment is NOT by PR author>
#   }
#
# `last_comment_at` is the createdAt of the most recent comment in the
# thread (matches `last_author`). The caller cross-references this against
# `state.json.slices[id].pr_open_at` to detect new reviewer activity in
# single-user setups where worker and reviewer share a GitHub identity
# (a `last_author == pr_author` thread is "addressed" by author-identity
# alone, but if the comment was made after the slice last transitioned to
# pr-open it's almost certainly the operator reviewing). The caller (the
# babysit SKILL.prompt's decision tree) does the timestamp comparison —
# this script just surfaces the data.
#
# Decision rules per the conductor's CLAUDE.md:
#   - state == MERGED → mark slice merged.
#   - checks == "FAIL"  → dispatch /smithy.fix with failed_checks summary.
#   - needs_response_count > 0 → dispatch /smithy.fix with unresolved threads
#                               whose last comment is from a reviewer (the
#                               worker hasn't responded yet, or the operator
#                               followed up on a previous reply).
#   - thread_count > 0, needs_response_count == 0, but ANY thread has
#     last_comment_at > slice.pr_open_at → dispatch /smithy.fix anyway
#     (single-user override: a worker-identity reply that arrived after
#     the slice opened is almost certainly the operator).
#   - thread_count > 0 but needs_response_count == 0 and no
#     last_comment_at > slice.pr_open_at → worker has replied to every
#     unresolved thread. No re-dispatch — operator needs to click Resolve
#     on github (or there's something the worker missed and operator will
#     route via NEED:).
#   - Otherwise → no action.
#
# Exit: 0 success / 1 gh call failed / 2 invalid input.
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

OWNER_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${OWNER_REPO%%/*}"
NAME="${OWNER_REPO##*/}"

# Top-level PR state: CI, mergeable, review summary, head branch, author.
# We pull `author` so we can identify worker-pushed replies vs reviewer
# comments when filtering threads.
SUMMARY="$(gh pr view "$PR" \
            --json number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author)"

# Unresolved review threads via GraphQL. Each thread keeps the original
# review comment (oldest in the thread) plus a `last_author` field naming
# whoever posted the most recent reply — this is the signal we use to tell
# "thread is open and reviewer is waiting" from "worker already replied,
# unresolved only because nobody clicked the Resolve button."
THREADS_RAW="$(gh api graphql \
  -F owner="$OWNER" \
  -F name="$NAME" \
  -F pr="$PR" \
  -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes {
              databaseId
              body
              path
              line
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}' \
  --jq '[
    .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false)
    | (.comments.nodes | sort_by(.createdAt)) as $sorted
    | {
        id: $sorted[0].databaseId,
        path: $sorted[0].path,
        line: $sorted[0].line,
        author: $sorted[0].author.login,
        body_preview: ($sorted[0].body | tostring | .[0:140]),
        last_author: $sorted[-1].author.login,
        last_comment_at: $sorted[-1].createdAt,
        comment_count: ($sorted | length)
      }
  ]' 2>/dev/null || echo '[]')"

# Combine. `needs_response` per thread is "last comment isn't by the PR
# author" — i.e. a reviewer is still waiting for action. checks status
# rolls statusCheckRollup into a single PASS/FAIL/PENDING/NONE summary.
echo "$SUMMARY" \
  | jq --argjson threads "$THREADS_RAW" '
      . as $pr
      | ($pr.author.login // "") as $pr_author
      | ($threads | map(. + {needs_response: (.last_author != $pr_author)})) as $annotated
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
              elif any(.[]; .conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "ACTION_REQUIRED" or .conclusion == "CANCELLED") then "FAIL"
              elif any(.[]; .status == "IN_PROGRESS" or .status == "QUEUED" or .status == "PENDING") then "PENDING"
              else "PASS"
              end
          ),
          failed_checks: [
            .statusCheckRollup // []
            | .[]
            | select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "ACTION_REQUIRED" or .conclusion == "CANCELLED")
            | {name: (.name // .context // "unknown"), url: (.detailsUrl // .targetUrl // null)}
          ],
          unresolved_threads: $annotated,
          thread_count: ($annotated | length),
          needs_response_count: ($annotated | map(select(.needs_response)) | length)
        }
    '
