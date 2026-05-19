#!/usr/bin/env bash
# legate.unwedge skill: inspect a slice that's been escalated for a branch
# collision, so the agent can decide between clean-stale-branch (safe ref
# cleanup), NEED: operator (active PR or unknown divergence), or
# manual corrective dispatch (partial-work scenario).
#
# Usage:
#   inspect-partial-work.sh <repo-path> <branch-name>
#
# Stdout: plain-text report covering:
#   - local branch existence and HEAD commit
#   - default branch ancestry (squash-merge detection)
#   - PRs targeting this branch (open + merged)
#   - last 5 commits on the branch
#   - merged-PR diff stat + body (if exactly one merged PR)
#
# Stderr: command failures (non-fatal — partial reports still print).
# Exit: 0 always (this is purely diagnostic; classification belongs to the agent).
set -uo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: inspect-partial-work.sh <repo-path> <branch-name>" >&2
  exit 2
fi

REPO="$1"
BRANCH="$2"

if [[ ! -d "$REPO/.git" ]]; then
  echo "error: $REPO is not a git checkout" >&2
  exit 2
fi

cd "$REPO"

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
  DEFAULT="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo)"
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
if ! command -v gh >/dev/null 2>&1; then
  echo "(gh not available)"
else
  PRS_JSON="$(gh pr list --head "$BRANCH" --state all --json number,state,title,mergedAt,url 2>/dev/null || echo '[]')"
  if [[ "$PRS_JSON" == "[]" || -z "$PRS_JSON" ]]; then
    echo "(none)"
  else
    echo "$PRS_JSON" | python3 -c '
import json,sys
prs = json.load(sys.stdin)
for p in prs:
    print(f"  #{p[\"number\"]} {p[\"state\"]} {p.get(\"mergedAt\") or \"\"} {p[\"title\"]}")
    print(f"    {p[\"url\"]}")
' 2>/dev/null || echo "$PRS_JSON"
    # If exactly one merged PR, show its diff stat and body so the agent
    # can reason about what landed.
    MERGED_COUNT="$(echo "$PRS_JSON" | python3 -c "import json,sys; print(sum(1 for p in json.load(sys.stdin) if p['state']=='MERGED'))" 2>/dev/null || echo 0)"
    if [[ "$MERGED_COUNT" == "1" ]]; then
      MERGED_NUM="$(echo "$PRS_JSON" | python3 -c "import json,sys; print(next(p['number'] for p in json.load(sys.stdin) if p['state']=='MERGED'))" 2>/dev/null)"
      if [[ -n "${MERGED_NUM:-}" ]]; then
        echo
        echo "== merged PR #$MERGED_NUM body =="
        gh pr view "$MERGED_NUM" --json body -q .body 2>/dev/null | head -40 || echo "(body fetch failed)"
        echo
        echo "== merged PR #$MERGED_NUM diff stat =="
        gh pr diff "$MERGED_NUM" 2>/dev/null | diffstat -p1 2>/dev/null \
          || gh pr diff "$MERGED_NUM" 2>/dev/null | grep -E '^(diff|---|\+\+\+|@@)' | head -30 \
          || echo "(diff fetch failed)"
      fi
    fi
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
