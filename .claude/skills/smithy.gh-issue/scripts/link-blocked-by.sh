#!/usr/bin/env bash
# link-blocked-by.sh — Mark one issue as blocked-by another via GraphQL.
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/link-blocked-by.sh <child-number> <blocker-number>
#
# Looks up node IDs for both issues in the current repo, then posts an
# addBlockedBy mutation. Output: JSON {"child": N, "blocker": N} on success.

set -euo pipefail

CHILD="${1:?child issue number required}"
BLOCKER="${2:?blocker issue number required}"

# Validate inputs are bare positive integers — leading '#', whitespace, or any
# non-digit produces a confusing GraphQL Int coercion error or jq parse failure
# downstream. Catch it here with a clear message instead.
for arg in "$CHILD" "$BLOCKER"; do
  if ! [[ "$arg" =~ ^[0-9]+$ ]]; then
    echo "Issue numbers must be bare positive integers (got: $arg)." >&2
    exit 1
  fi
done

REPO_JSON=$(gh repo view --json owner,name)
OWNER=$(echo "$REPO_JSON" | jq -r '.owner.login')
NAME=$(echo "$REPO_JSON" | jq -r '.name')

# Look up the GraphQL node ID for an issue number; emit a clear stderr error
# if the issue does not exist in this repo (otherwise we'd pass null to the
# mutation and get an opaque GraphQL failure).
lookup_id() {
  local number="$1"
  local id
  id=$(gh api graphql \
    -F owner="$OWNER" -F name="$NAME" -F number="$number" \
    -f query='query($owner:String!, $name:String!, $number:Int!) {
      repository(owner:$owner, name:$name) { issue(number:$number) { id } }
    }' --jq '.data.repository.issue.id')
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    echo "Issue $number not found in $OWNER/$NAME." >&2
    return 1
  fi
  echo "$id"
}

CHILD_ID=$(lookup_id "$CHILD")
BLOCKER_ID=$(lookup_id "$BLOCKER")

gh api graphql \
  -F issue="$CHILD_ID" -F blocker="$BLOCKER_ID" \
  -f query='mutation($issue:ID!, $blocker:ID!) {
    addBlockedBy(input:{issueId:$issue, blockingIssueId:$blocker}) {
      issue { number } blockingIssue { number }
    }
  }' >/dev/null

jq -n --argjson child "$CHILD" --argjson blocker "$BLOCKER" \
  '{child: $child, blocker: $blocker}'
