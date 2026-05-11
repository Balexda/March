#!/usr/bin/env bash
# legate skill: fetch + fast-forward the repo's default branch.
#
# Usage:
#   sync-default-branch.sh <repo-path>
#
# Detects the default branch via `git symbolic-ref refs/remotes/origin/HEAD`,
# falling back to `gh repo view --json defaultBranchRef` if that's not set.
# Then `git fetch origin <default> && git switch <default> && git pull --ff-only`.
#
# Stdout: JSON `{"default_branch": "<name>", "synced": true, "head": "<sha>"}`
# Exit:
#   0 success
#   1 divergence (operator must resolve — never --hard reset)
#   2 invalid input
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: sync-default-branch.sh <repo-path>" >&2
  exit 2
fi

REPO="$1"
if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi

cd "$REPO"

# Detect default branch
DEFAULT="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
if [[ -z "$DEFAULT" ]]; then
  if command -v gh >/dev/null 2>&1; then
    DEFAULT="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
  fi
fi
if [[ -z "$DEFAULT" ]]; then
  echo "could not determine default branch (origin/HEAD unset and gh repo view failed)" >&2
  exit 1
fi

echo "syncing default branch: $DEFAULT" >&2

git fetch origin "$DEFAULT" --quiet >&2

# Try to switch + ff. If we can't ff (diverged), bail without --hard reset.
if ! git switch "$DEFAULT" --quiet >&2; then
  echo "could not switch to $DEFAULT (uncommitted changes? detached HEAD?)" >&2
  exit 1
fi

if ! git pull --ff-only origin "$DEFAULT" --quiet >&2; then
  echo "could not fast-forward $DEFAULT — local has diverged from origin/$DEFAULT" >&2
  echo "operator must resolve before legate dispatches new work" >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
jq -nc --arg b "$DEFAULT" --arg h "$HEAD_SHA" '{default_branch: $b, synced: true, head: $h}'
