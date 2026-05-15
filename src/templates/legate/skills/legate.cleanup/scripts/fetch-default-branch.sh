#!/usr/bin/env bash
# legate skill: fetch the repo's origin/<default> refs without switching or
# pulling.
#
# Cleanup-side companion to the deterministic loop's default-branch sync:
# the loop does fetch + switch + pull before a Hatchery Smithy launch;
# this one is the narrower "just refresh refs" used after cleanup so the next
# loop dispatch tick sees the freshly-merged commit. We deliberately do
# not switch or pull because the loop owns HEAD-update semantics.
#
# Usage:
#   fetch-default-branch.sh <repo-path>
#
# Stdout: JSON `{"default_branch": "<name>", "fetched": true}`
# Exit:
#   0 success
#   1 default-branch detection or fetch failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: fetch-default-branch.sh <repo-path>" >&2
  exit 2
fi

REPO="$1"
if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

cd "$REPO"

# Detect default branch — same two-tier detection as sync-default-branch.sh.
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

echo "fetching origin/$DEFAULT" >&2

git fetch origin "$DEFAULT" --quiet >&2

jq -nc --arg b "$DEFAULT" '{default_branch: $b, fetched: true}'
