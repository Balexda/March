#!/usr/bin/env bash
# get-comments.sh — Fetch unresolved PR review threads with full reply chains
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/get-comments.sh <owner/repo> <pr-number>
#
# Output: JSON array of unresolved review threads. Each thread has:
#   - isResolved (always false in output — resolved threads are filtered)
#   - comments[]: array of comment objects with databaseId, body, path, diffHunk,
#                 author.login, createdAt (ordered oldest → newest)
#
# Returns an empty array ([]) if there are no unresolved review threads.

set -euo pipefail

REPO="$1"
PR="$2"

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

gh api graphql \
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
              diffHunk
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | . + { comments: (.comments.nodes | sort_by(.createdAt)) }]'
