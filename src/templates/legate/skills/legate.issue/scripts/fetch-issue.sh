#!/usr/bin/env bash
# legate.issue skill: fetch a GitHub issue's full detail as JSON.
#
# Reads the issue using an app/read entitlement for the managed repository.
#
# Usage:
#   fetch-issue.sh <repo-path> <issue-number>
#
# Stdout: JSON with shape:
#   {
#     "number":   <int>,
#     "title":    "...",
#     "body":     "...",
#     "url":      "https://github.com/Owner/Repo/issues/<N>",
#     "author":   "<login>",
#     "labels":   ["...","..."],
#     "state":    "OPEN" | "CLOSED",
#     "comments": [
#       {"author": "<login>", "createdAt": "<iso8601>", "body": "..."},
#       ...
#     ]
#   }
# Stderr: progress / error messages.
# Exit:
#   0 success
#   1 gh call failed (issue not found, gh not authenticated, network error, ...)
#   2 invalid input
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: fetch-issue.sh <repo-path> <issue-number>" >&2
  exit 2
fi

REPO="$1"
NUM="$2"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if ! [[ "$NUM" =~ ^[1-9][0-9]*$ ]]; then
  echo "issue number must be a positive integer: $NUM" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi

echo "fetch-issue: repo=$REPO num=$NUM" >&2

FORGE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../tessera-forge.mjs"
cd "$REPO"

# `gh issue view --json` shapes label/author/comment objects with extra
# bookkeeping fields. Normalize to the schema documented above so the
# conductor doesn't need to re-pick fields.
RAW="$(MARCH_TESSERA_SLICE_ID="issue-$NUM" node "$FORGE" gh read issue view "$NUM" \
        --json number,title,body,url,author,labels,state,comments)"

echo "$RAW" | jq '{
  number,
  title,
  body,
  url,
  author:   (.author.login // null),
  labels:   ([.labels[]?.name]),
  state,
  comments: ([.comments[]? | {
    author:    (.author.login // null),
    createdAt: (.createdAt // null),
    body
  }])
}'
