#!/usr/bin/env bash
# get-comments.sh — Fetch unresolved PR review threads and PR conversation comments
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/get-comments.sh <owner/repo> <pr-number>
#
# Output: JSON array of unresolved review items. Inline review threads have:
#   - kind: "inline_thread"
#   - replyMode: "inline"
#   - isResolved (always false in output — resolved threads are filtered)
#   - comments[]: array of comment objects with databaseId, body, path, diffHunk,
#                 author.login, createdAt (ordered oldest → newest)
# Top-level PR conversation comments have:
#   - kind: "conversation_comment"
#   - replyMode: "conversation"
#   - comments[]: a single comment object with databaseId, body, author.login,
#                 createdAt, and null path/diffHunk fields
# Conversation comments authored by the authenticated viewer, or already
# followed by a viewer comment containing the smithy-pr-review response marker,
# are filtered out.
#
# Returns an empty array ([]) if there are no unresolved review items.

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
  viewer { login }
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
      comments(last: 100) {
        nodes {
          databaseId
          body
          author { login }
          createdAt
        }
      }
    }
  }
}' --jq '
.data as $data
| ($data.viewer.login // "") as $viewer
| ($data.repository.pullRequest.comments.nodes | sort_by(.createdAt)) as $conversationComments
| [
  (.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | . + {
    kind: "inline_thread",
    replyMode: "inline",
    comments: (.comments.nodes | sort_by(.createdAt))
  }),
  ($conversationComments[] as $comment
  | select(($comment.author.login // "") != $viewer)
  | select([
      $conversationComments[]
      | select((.author.login // "") == $viewer)
      | select(.createdAt > $comment.createdAt)
      | select((.body // "") | contains("smithy-pr-review-response-to:" + ($comment.databaseId | tostring)))
    ] | length == 0)
  | {
    kind: "conversation_comment",
    replyMode: "conversation",
    isResolved: false,
    comments: [{
      databaseId: $comment.databaseId,
      body: $comment.body,
      path: null,
      diffHunk: null,
      author: $comment.author,
      createdAt: $comment.createdAt
    }]
  })
] | sort_by(.comments[0].createdAt)'
