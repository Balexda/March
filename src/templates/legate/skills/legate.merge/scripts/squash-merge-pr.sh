#!/usr/bin/env bash
# legate skill: squash-merge a PR after the readiness gate has cleared.
#
# Wraps `gh pr merge --squash --match-head-commit <sha>`. The --match-head-commit
# pin is critical: between the readiness check and this call, a worker push
# (or operator push) could have advanced the PR head — we do NOT want to
# squash-merge an unreviewed revision. If the SHA no longer matches, gh
# fails cleanly and we leave the slice in pr-open for the next heartbeat.
#
# This script does not re-run the readiness gate; the merge skill is
# responsible for that. Calling this script directly without first
# evaluating the gate is a bug.
#
# Usage:
#   squash-merge-pr.sh <repo-path> <pr-num> <head-sha>
#
# Stdout (success): JSON `{"merged": true, "pr": N, "merge_sha": "..."}`
# Stdout (failure): JSON `{"merged": false, "pr": N, "error": "..."}`
# Exit:
#   0 success
#   1 gh pr merge failed (race, transient, etc. — slice stays at pr-open)
#   2 invalid input
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: squash-merge-pr.sh <repo-path> <pr-num> <head-sha>" >&2
  exit 2
fi

REPO="$1"
PR="$2"
HEAD_SHA="$3"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "pr-num must be a positive integer: $PR" >&2
  exit 2
fi
if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "head-sha must be a 7-40 char hex string: $HEAD_SHA" >&2
  exit 2
fi

cd "$REPO"

echo "merging PR #$PR (squash, pinned to head $HEAD_SHA)" >&2

if ! out=$(gh pr merge "$PR" --squash --match-head-commit "$HEAD_SHA" 2>&1); then
  jq -nc \
    --argjson pr "$PR" \
    --arg err "$out" \
    '{merged: false, pr: $pr, error: $err}'
  exit 1
fi

# Pull the squash-merge commit SHA back so the conductor can record it in
# task-log.md. `mergeCommit.oid` is the squash commit on the default branch.
# Best-effort: the merge already succeeded, so we must still emit the
# `merged: true` document even if this follow-up call fails transiently
# (rate limit, eventual consistency between merge and mergeCommit lookup).
# An empty merge_sha in the JSON is acceptable — the operator can recover
# the SHA from `gh pr view` themselves.
MERGE_SHA="$(gh pr view "$PR" --json mergeCommit -q '.mergeCommit.oid // ""' 2>/dev/null || true)"

jq -nc \
  --argjson pr "$PR" \
  --arg sha "$MERGE_SHA" \
  '{merged: true, pr: $pr, merge_sha: $sha}'
