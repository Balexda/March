#!/usr/bin/env bash
# reply-comment.sh — Post an inline reply to a PR review comment
#
# Usage: bash ${CLAUDE_SKILL_DIR}/scripts/reply-comment.sh <owner/repo> <pr-number> <comment-id> <body-file>
#
# body-file: path to a JSON file with content: {"body": "your reply text"}
# Write it with a heredoc before calling this script to avoid quoting issues:
#
#   cat > /tmp/smithy_reply_<id>.json << 'EOF'
#   {"body": "Fixed in abc1234: changed X to Y because Z"}
#   EOF
#   bash ${CLAUDE_SKILL_DIR}/scripts/reply-comment.sh owner/repo 42 123456 /tmp/smithy_reply_123456.json

set -euo pipefail

REPO="$1"
PR="$2"
COMMENT_ID="$3"
BODY_FILE="$4"

gh api "repos/$REPO/pulls/$PR/comments/$COMMENT_ID/replies" \
  --method POST \
  --input "$BODY_FILE"
