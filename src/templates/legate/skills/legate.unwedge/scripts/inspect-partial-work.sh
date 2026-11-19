#!/usr/bin/env bash
# legate.unwedge skill: inspect a slice that's been escalated for a branch
# collision, so the agent can decide between clean-stale-branch (safe ref
# cleanup), NEED: operator (active PR or unknown divergence), or
# manual corrective dispatch (partial-work scenario).
#
# Usage:
#   inspect-partial-work.sh <repo-path> <branch-name> [slice-id]
#
# Stdout: plain-text report covering:
#   - local branch existence and HEAD commit
#   - default branch ancestry (squash-merge detection)
#   - PRs targeting this branch (open + merged)
#   - last 5 commits on the branch
#   - merged-PR diff stat + body (if exactly one merged PR)
#
# Stderr: command failures (non-fatal — partial reports still print).
# Exit: 0 for a report, 1 when GitHub data cannot be verified.
set -uo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: inspect-partial-work.sh <repo-path> <branch-name> [slice-id]" >&2
  exit 2
fi

REPO="$1"
export MARCH_TESSERA_SLICE_ID="${3:-${MARCH_TESSERA_SLICE_ID:-}}"
BRANCH="$2"

if [[ ! -d "$REPO/.git" ]]; then
  echo "error: $REPO is not a git checkout" >&2
  exit 2
fi

FORGE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../tessera-forge.mjs"
cd "$REPO" || exit 2

echo "== branch =="
echo "name: $BRANCH"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  HEAD_SHA="$(git rev-parse "$BRANCH" 2>/dev/null || echo unknown)"
  echo "local: yes"
  echo "head:  $HEAD_SHA"
  echo
  echo "== last 5 commits on branch =="
  git log -5 --format='%h %ad %an : %s' --date=short "$BRANCH" 2>/dev/null || echo "(log failed)"
else
  echo "local: no"
fi

echo
echo "== default branch ancestry =="
DEFAULT="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
if [[ -z "$DEFAULT" ]]; then
  DEFAULT="$(node "$FORGE" gh read repo view --json defaultBranchRef -q .defaultBranchRef.name)" || exit 1
fi
echo "default branch: ${DEFAULT:-unknown}"
if [[ -n "${DEFAULT:-}" ]] && git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  if git merge-base --is-ancestor "$BRANCH" "$DEFAULT" 2>/dev/null; then
    echo "is-ancestor-of-$DEFAULT: yes (orphan ref — no diverged work)"
  else
    echo "is-ancestor-of-$DEFAULT: no (HEAD diverged)"
  fi
fi

echo
echo "== PRs targeting this branch =="
PRS_JSON="$(node "$FORGE" gh read pr list --head "$BRANCH" --state all --json number,state,title,mergedAt,url)" || exit 1
if [[ "$PRS_JSON" == "[]" || -z "$PRS_JSON" ]]; then
  echo "(none)"
else
  echo "$PRS_JSON" | jq -r '.[] | "  #\(.number) \(.state) \(.mergedAt // "") \(.title)\n    \(.url)"'
  # If exactly one merged PR, show its diff stat and body so the agent
  # can reason about what landed.
  MERGED_NUM="$(echo "$PRS_JSON" | jq -r '[.[] | select(.state == "MERGED")] | if length == 1 then .[0].number else empty end')" || exit 1
  if [[ -n "$MERGED_NUM" ]]; then
    echo
    echo "== merged PR #$MERGED_NUM body =="
    BODY="$(node "$FORGE" gh read pr view "$MERGED_NUM" --json body -q .body)" || exit 1
    head -40 <<< "$BODY"
    echo
    echo "== merged PR #$MERGED_NUM diff stat =="
    DIFF="$(node "$FORGE" gh read pr diff "$MERGED_NUM")" || exit 1
    diffstat -p1 <<< "$DIFF" 2>/dev/null \
      || awk '/^(diff|---|[+][+][+]|@@)/ && ++lines <= 30' <<< "$DIFF"
  fi
fi

echo
echo "== verdict hint =="
echo "Use the data above to classify the collision:"
echo "  - HEAD is ancestor of default + no PR        -> orphan ref      (clean-stale-branch safe)"
echo "  - HEAD diverged + exactly merged PR + no open -> post-merge stale (clean-stale-branch safe)"
echo "  - any open PR                                -> NEED: operator (active work)"
echo "  - HEAD diverged + no PR / unknown            -> NEED: operator (diverged unknown)"
echo "  - merged PR(s) + smithy still says ready     -> partial work — corrective dispatch needed"
