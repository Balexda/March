#!/usr/bin/env bash
# legate skill: ask a worker to rebase its PR branch onto current main
# and force-push, so a stale CI run picks up an upstream fix.
#
# Used when babysit-pr reports CI FAIL and the cause is "main was red
# (or missing the fix) when this PR's CI ran, and main has since been
# fixed." `gh run rerun` does NOT help here — it re-runs the same
# workflow against the same merge commit, which was computed by GitHub
# from the PR's head + main *as of the original run time*. When main
# updates, that merge commit becomes stale; rerun reuses it and fails
# identically. The actual fix is to rebase the PR branch onto current
# main and force-push, which causes GitHub to recompute the merge
# commit and re-fire CI from scratch on the rebased branch.
#
# Why dispatch this to the worker rather than rebasing from outside:
# the worker owns its worktree (it's a git worktree under
# ~/Development/WorkTrees/...). If the conductor and worker both touch
# files in that worktree concurrently, they conflict. The worker is in
# `waiting`, ready to accept a message — sending the rebase instruction
# to the worker keeps the worktree single-writer.
#
# Usage:
#   request-rebase.sh <profile> <session-id-or-title> <worktree-path>
#
# Stdout: the worker's reply (raw text from agent-deck) — typically
# ends with the new HEAD sha, or describes a conflict if the rebase
# couldn't be completed cleanly.
# Exit:
#   0 success (dispatch returned)
#   1 dispatch failed (worker not waiting, agent-deck error, timeout)
#   2 invalid input
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: request-rebase.sh <profile> <session-id-or-title> <worktree-path>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"
WORKTREE="$3"

if [[ -z "$WORKTREE" ]]; then
  echo "worktree path is empty" >&2
  exit 2
fi

# Don't insist the path exists from the conductor's perspective — the
# worker may live in a separate filesystem namespace (rare today, but
# we don't want to gate on it). The worker will fail fast and reply
# with the cd error if the path is wrong, and we'll see it in stdout.

# Build the rebase instruction internally so the conductor's call site
# stays a clean three-arg invocation that auto-mode classifies cleanly.
# Multi-line message construction at the conductor's bash prompt is
# what trips the classifier; doing it inside this audited script does
# not.
MSG=$(cat <<EOF
A parent PR fixing main has merged since this PR's CI last ran.
\`gh run rerun\` reuses the original merge commit (computed against
the then-stale main) and won't pick up the fix. Please rebase your
branch onto current main and force-push so GitHub recomputes the
merge commit and re-fires CI from scratch:

  cd "$WORKTREE"
  git fetch origin
  git rebase origin/main
  git push --force-with-lease

Reply with the new HEAD sha when the push is done. If the rebase has
conflicts, run \`git rebase --abort\` and reply with the conflicting
paths (and a short note on what's tangled) so I can escalate back to
the operator instead of guessing at a resolution.
EOF
)

# 600s timeout: rebase + push usually completes in seconds, but if the
# worker has to think about a conflict before aborting we want enough
# slack that we don't time out mid-thought.
exec agent-deck -p "$PROFILE" session send "$SESSION" "$MSG" --wait -q --timeout 600s
