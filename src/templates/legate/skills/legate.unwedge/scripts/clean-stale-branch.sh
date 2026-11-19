#!/usr/bin/env bash
# legate.unwedge skill: delete a stale local branch and request recovery of its
# escalated slice so the deterministic loop re-dispatches the artifact on its next
# tick. Safety re-validation happens here, NOT in the caller — this script must
# refuse to delete a branch with an open PR or with diverged work whose status
# isn't a merged PR.
#
# Since the legate loop is Herald-backed (#176) there is no state.json to edit:
# recovery is an EVENT. After cleaning the local branch this script appends a
# `slice.recovery.requested` event via `march legate recover <slice-id>` (#238).
# The running loop drops the escalated slice from its working state and
# re-dispatches the still-ready smithy work fresh — no restart, no state surgery.
#
# Usage:
#   clean-stale-branch.sh <repo-path> <branch-name> <slice-id>
#
# Exit (distinct so callers can tell "do not retry" from "retry recover"):
#   0 cleaned successfully (+ recovery requested)
#   1 refused — branch unsafe to delete; operator must reconcile (do NOT retry)
#   2 invalid input or environment
#   3 branch cleaned but `march legate recover` failed — re-run it once Herald is reachable
#
# Stdout: one line per action taken (branch deleted, recovery requested).
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: clean-stale-branch.sh <repo-path> <branch-name> <slice-id>" >&2
  exit 2
fi

REPO="$1"
BRANCH="$2"
SLICE_ID="$3"

if [[ ! -d "$REPO/.git" ]]; then
  echo "error: $REPO is not a git checkout" >&2
  exit 2
fi
if [[ -z "$SLICE_ID" ]]; then
  echo "error: slice id must not be empty" >&2
  exit 2
fi

FORGE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../tessera-forge.mjs"
cd "$REPO"

export MARCH_TESSERA_SLICE_ID="$SLICE_ID"
if ! git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  SAFETY="no-such-branch"
else
  DEFAULT="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  DEFAULT="${DEFAULT#origin/}"
  if [[ -z "$DEFAULT" ]]; then
    DEFAULT="$(node "$FORGE" gh read repo view --json defaultBranchRef -q .defaultBranchRef.name)" || exit 1
  fi

  # Inability to see PRs makes it unsafe to remove a branch.
  PRS="$(node "$FORGE" gh read pr list --head "$BRANCH" --state all --json number,state)" || exit 1
  OPEN="$(jq -r '[.[] | select(.state == "OPEN") | "#\(.number)"] | join(",")' <<< "$PRS")"
  MERGED="$(jq -r '[.[] | select(.state == "MERGED") | "#\(.number)"] | join(",")' <<< "$PRS")"
  if [[ -n "$OPEN" ]]; then
    SAFETY="refuse:open-pr:$OPEN"
  elif [[ -n "$DEFAULT" ]] && git merge-base --is-ancestor "refs/heads/$BRANCH" "refs/heads/$DEFAULT" 2>/dev/null; then
    SAFETY="safe:orphan-ref"
  elif [[ -n "$MERGED" ]]; then
    SAFETY="safe:post-merge-stale:$MERGED"
  else
    SAFETY="refuse:diverged-unknown"
  fi
fi

if [[ "$SAFETY" == "no-such-branch" ]]; then
  echo "noop: branch $BRANCH does not exist locally"
elif [[ "$SAFETY" == refuse:* ]]; then
  echo "refused: $SAFETY" >&2
  echo "this branch is not safe to delete autonomously; operator must reconcile" >&2
  exit 1
elif [[ "$SAFETY" == safe:* ]]; then
  echo "verdict: $SAFETY"
  git branch -D -- "$BRANCH"
  echo "deleted branch: $BRANCH"
else
  echo "error: unexpected safety verdict: $SAFETY" >&2
  exit 2
fi

# Recovery is an event, not a state-file edit (#176/#238). Append it via the CLI;
# the running loop honors it on its next tick. Idempotent on the loop side, but if
# it fails (Herald unreachable) the branch is already cleaned, so surface the exact
# retry command rather than silently leaving the slice wedged.
if march legate recover "$SLICE_ID"; then
  echo "done. requested recovery of $SLICE_ID — loop will re-dispatch on next tick."
else
  # Distinct from a safety refusal (exit 1): the branch IS cleaned, so the operator
  # should re-run recover (idempotent) once Herald is back, not reconcile by hand.
  echo "error: branch cleaned but 'march legate recover $SLICE_ID' failed." >&2
  echo "re-run once Herald is reachable: march legate recover $SLICE_ID" >&2
  exit 3
fi
