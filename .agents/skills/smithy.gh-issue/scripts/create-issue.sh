#!/usr/bin/env bash
# create-issue.sh — Create a GitHub issue in the current repo from a body file.
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/create-issue.sh <title> <body-file>
#
# Write the body to a temp file with a heredoc before calling, to avoid quoting
# issues with markdown content:
#
#   cat > /tmp/smithy_issue_body.md << 'BODY'
#   ## My Issue
#   ...
#   BODY
#   ${CLAUDE_SKILL_DIR}/scripts/create-issue.sh "[Story] My Title" /tmp/smithy_issue_body.md
#
# Output: JSON {"number": N, "url": "https://github.com/owner/repo/issues/N"}.

set -euo pipefail

TITLE="${1:?title required}"
BODY_FILE="${2:?body file path required}"

if [ ! -f "$BODY_FILE" ]; then
  echo "Body file not found: $BODY_FILE" >&2
  exit 1
fi

# Validate jq up front — failing after `gh issue create` would leave an issue
# behind and a non-zero exit, which callers interpret as failure and may retry,
# producing duplicate tickets.
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to format create-issue output but is not installed." >&2
  exit 1
fi

URL=$(gh issue create --title "$TITLE" --body-file "$BODY_FILE")
URL="${URL//[$'\t\r\n ']/}"
NUMBER="${URL##*/}"

if ! [[ "$NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Could not parse issue number from gh output: $URL" >&2
  exit 1
fi

jq -n --arg url "$URL" --argjson number "$NUMBER" \
  '{number: $number, url: $url}'
