#!/usr/bin/env bash
# check-env.sh — Verify gh CLI is installed and a GitHub remote is configured.
#
# Usage: ${CLAUDE_SKILL_DIR}/scripts/check-env.sh
#
# Output: JSON {"owner": "...", "repo": "...", "ownerRepo": "owner/repo"}.
# Exits 1 with a friendly stderr message if gh is missing or no GitHub remote exists.

set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh (GitHub CLI) is required but not installed. Install it from https://cli.github.com/" >&2
  exit 1
fi

# Capture stderr so we can surface gh's real error (auth failure, no remote,
# rate limit, etc.) instead of always reporting "no GitHub remote configured."
GH_STDERR=$(mktemp)
trap 'rm -f "$GH_STDERR"' EXIT
if ! REPO_JSON=$(gh repo view --json owner,name 2>"$GH_STDERR"); then
  echo "Could not read GitHub repo info via gh:" >&2
  cat "$GH_STDERR" >&2
  exit 1
fi

OWNER=$(echo "$REPO_JSON" | jq -r '.owner.login')
NAME=$(echo "$REPO_JSON" | jq -r '.name')

jq -n --arg owner "$OWNER" --arg repo "$NAME" \
  '{owner: $owner, repo: $repo, ownerRepo: "\($owner)/\($repo)"}'
