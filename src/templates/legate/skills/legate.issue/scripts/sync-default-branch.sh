#!/usr/bin/env bash
# legate skill: fetch + fast-forward the repo's default branch.
#
# Usage:
#   sync-default-branch.sh <repo-path> [slice-id]
#
# Detects the default branch via `git symbolic-ref refs/remotes/origin/HEAD`,
# falling back to `gh repo view --json defaultBranchRef` if that's not set.
# Fetches with app/read, then switches branches and fast-forwards locally.
#
# Stdout: JSON `{"default_branch": "<name>", "synced": true, "head": "<sha>"}`
# Exit:
#   0 success
#   1 divergence (operator must resolve — never --hard reset)
#   2 invalid input
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: sync-default-branch.sh <repo-path> [slice-id]" >&2
  exit 2
fi

REPO="$1"
export MARCH_TESSERA_SLICE_ID="${2:-${MARCH_TESSERA_SLICE_ID:-}}"
if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi

FORGE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../tessera-forge.mjs"
cd "$REPO"

# Detect default branch
DEFAULT="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
if [[ -z "$DEFAULT" ]]; then
  DEFAULT="$(node "$FORGE" gh read repo view --json defaultBranchRef -q .defaultBranchRef.name)"
fi
if [[ -z "$DEFAULT" ]]; then
  echo "could not determine default branch (origin/HEAD unset and gh repo view failed)" >&2
  exit 1
fi

echo "syncing default branch: $DEFAULT" >&2

git check-ref-format --branch "$DEFAULT" >/dev/null
node "$FORGE" fetch read "+refs/heads/$DEFAULT:refs/remotes/origin/$DEFAULT" >&2

# Try to switch + ff. If we can't ff (diverged), bail without --hard reset.
if ! git switch "$DEFAULT" --quiet >&2; then
  echo "could not switch to $DEFAULT (uncommitted changes? detached HEAD?)" >&2
  exit 1
fi

if ! git merge --ff-only "refs/remotes/origin/$DEFAULT" --quiet >&2; then
  echo "could not fast-forward $DEFAULT — local has diverged from origin/$DEFAULT" >&2
  echo "operator must resolve before legate dispatches new work" >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
jq -nc --arg b "$DEFAULT" --arg h "$HEAD_SHA" '{default_branch: $b, synced: true, head: $h}'
