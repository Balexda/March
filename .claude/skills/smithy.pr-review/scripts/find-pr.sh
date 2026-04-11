#!/usr/bin/env bash
# find-pr.sh — Detect the open PR for the current branch
#
# Usage: bash ${CLAUDE_SKILL_DIR}/scripts/find-pr.sh
#
# Output: JSON with owner, repo, pr, ownerRepo fields.
# Returns empty object ({}) if no open PR exists for the current branch.

set -euo pipefail

BRANCH=$(git branch --show-current)
PR_JSON=$(gh pr list --head "$BRANCH" --json number --state open --limit 1)

# Check if any PR exists
if [ "$PR_JSON" = "[]" ]; then
  echo '{}'
  exit 0
fi

PR=$(echo "$PR_JSON" | jq -r '.[0].number')
OWNER=$(gh repo view --json owner --jq '.owner.login')
NAME=$(gh repo view --json name --jq '.name')

jq -n --arg owner "$OWNER" --arg repo "$NAME" --argjson pr "$PR" \
  '{owner: $owner, repo: $repo, pr: $pr, ownerRepo: "\($owner)/\($repo)"}'
