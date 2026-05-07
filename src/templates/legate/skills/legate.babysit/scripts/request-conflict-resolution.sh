#!/usr/bin/env bash
# legate skill: ask a worker to resolve a real merge conflict on its PR
# branch by rebasing onto current default and editing the conflicting
# files, then force-push.
#
# Used when babysit-pr reports `state == "OPEN"` and `mergeable ==
# "CONFLICTING"`. CI may be green, there may be zero unresolved review
# threads — but the PR cannot merge because its diff overlaps something
# that landed on the default branch since the worker last rebased.
#
# This is *not* the same situation as request-rebase.sh handles:
#   - request-rebase.sh assumes a clean rebase (the parent fix didn't
#     touch the same lines this PR touches) and treats conflicts as an
#     error path — the worker is told to abort and report tangled paths.
#   - request-conflict-resolution.sh assumes a real conflict and tells
#     the worker to *resolve* it, falling back to abort+report only if
#     the conflict reflects a genuine design disagreement the worker
#     can't adjudicate from the slice's spec/data-model/contracts.
#
# Why dispatch this to the worker rather than resolving from outside:
# same reason as request-rebase.sh — the worker owns its worktree as
# single writer, and is in `waiting` ready to accept a message. The
# conductor must not touch the worktree concurrently.
#
# Why this is /smithy.fix and not a plain message: conflict resolution
# requires semantic judgment about which side of the conflict reflects
# the slice's intent. /smithy.fix loads the worker's review skills and
# anchors the resolution against the slice's spec, data-model, and
# contracts — the same context the worker used when it first wrote the
# diff. A plain "resolve and push" message would invite mechanical
# `git checkout --ours` / `--theirs` reflexes that don't preserve
# either branch's intent.
#
# Usage:
#   request-conflict-resolution.sh <profile> <session-id-or-title> \
#                                   <worktree-path> <default-branch> \
#                                   <pr-num>
#
# Stdout: the worker's reply (raw text from agent-deck) — typically
# ends with the new HEAD sha, or describes the tangled paths and the
# nature of the disagreement if the worker chose to abort.
# Exit:
#   0 success (dispatch returned)
#   1 dispatch failed (worker not waiting, agent-deck error, timeout)
#   2 invalid input
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: request-conflict-resolution.sh <profile> <session-id-or-title> <worktree-path> <default-branch> <pr-num>" >&2
  exit 2
fi

PROFILE="$1"
SESSION="$2"
WORKTREE="$3"
DEFAULT_BRANCH="$4"
PR="$5"

if [[ -z "$WORKTREE" ]]; then
  echo "worktree path is empty" >&2
  exit 2
fi
if [[ -z "$DEFAULT_BRANCH" ]]; then
  echo "default branch is empty" >&2
  exit 2
fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "pr-num must be a positive integer: $PR" >&2
  exit 2
fi

# Build the message inside the audited script so the conductor's call
# site stays a clean five-arg invocation that auto-mode classifies
# cleanly. Multi-line `/smithy.fix` prompts composed at the conductor's
# bash prompt are exactly what trips the classifier.
MSG=$(cat <<EOF
/smithy.fix

PR #$PR is blocked from merging: GitHub reports \`mergeable=CONFLICTING\`
against \`origin/$DEFAULT_BRANCH\`. CI may be green and threads may be
clear, but the merge is dirty because something landed on
\`$DEFAULT_BRANCH\` that overlaps this PR's diff.

Please rebase onto the latest default and resolve the conflicts:

  cd "$WORKTREE"
  git fetch origin
  git rebase origin/$DEFAULT_BRANCH

For each conflicted file, treat the slice's spec, data-model, and
contracts as ground truth. The two sides of the conflict are usually:

  - **HEAD (the latest $DEFAULT_BRANCH)**: a peer slice's content that
    landed in parallel — preserve any new structure or constraints it
    introduced.
  - **the rebased commit (your slice)**: the work this PR was opened
    for — preserve its acceptance criteria and decisions.

When both sides are valid additions to the same file (e.g. two slices
each appending a section to the same tasks/spec/data-model file), the
correct resolution is usually a *merge* of both contributions, not a
pick of one side. \`git checkout --ours\` / \`--theirs\` is almost
never the right answer for a Smithy artifact conflict.

Once each file is resolved:

  git add <resolved-paths>
  git rebase --continue
  # (repeat for each rebased commit if the conflict surface spans more
  # than one)
  git push --force-with-lease

Reply with the new HEAD sha when the push completes.

If — and only if — the conflict reflects a genuine design disagreement
between the two slices (e.g. they made incompatible decisions about the
same acceptance criterion, not just neighboring edits), do this
instead:

  git rebase --abort

Then reply with:
  - the conflicting paths,
  - which slice / PR introduced the other side (find via
    \`git log $DEFAULT_BRANCH -- <path>\`),
  - a one-paragraph description of the substantive disagreement.

That puts the call back on the operator instead of guessing at a
resolution that contradicts another shipped slice.
EOF
)

# 600s timeout: a real conflict resolution can take meaningful thinking
# time on the worker's side; we want enough slack that we don't time
# out mid-resolution. Even a clean rebase finishes well inside this
# window.
exec agent-deck -p "$PROFILE" session send "$SESSION" "$MSG" --wait -q --timeout 600s
