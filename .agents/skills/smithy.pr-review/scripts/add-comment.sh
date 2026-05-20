#!/usr/bin/env bash
# add-comment.sh — Post a top-level PR conversation comment
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/add-comment.sh <owner/repo> <pr-number> <body-file>
#
# The body file must contain JSON in the shape: {"body": "comment text"}

set -euo pipefail

REPO="$1"
PR="$2"
BODY_FILE="$3"

gh api "repos/$REPO/issues/$PR/comments" \
  --method POST \
  --input "$BODY_FILE"
