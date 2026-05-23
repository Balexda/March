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

cd "$REPO"

# We do not trust upstream callers to have validated safety. Extract the safety
# validator to a temp file so the heredoc-in-command-substitution pattern doesn't
# collide with anything else.
TMP_VALIDATOR="$(mktemp -t unwedge.validate.XXXXXX.py)"
trap 'rm -f "$TMP_VALIDATOR"' EXIT

cat > "$TMP_VALIDATOR" <<'PYVALIDATE'
import json, subprocess, sys

branch = sys.argv[1]

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)

if run(["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"]).returncode != 0:
    print("no-such-branch")
    sys.exit(0)

default = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).stdout.strip().replace("origin/", "")
if not default:
    default = run(["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]).stdout.strip()

is_ancestor = bool(default) and run(["git", "merge-base", "--is-ancestor", branch, default]).returncode == 0

pr_call = run(["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "number,state"])
prs_known = pr_call.returncode == 0
prs_raw = pr_call.stdout.strip()
try:
    prs = json.loads(prs_raw) if prs_raw else []
except json.JSONDecodeError:
    prs = []
    prs_known = False
open_prs = [p for p in prs if p.get("state") == "OPEN"]
merged_prs = [p for p in prs if p.get("state") == "MERGED"]

# If we couldn't verify the PR list, refuse the safe verdicts —
# an ancestor-of-master branch might still have an open PR we can't
# see. The script's safety contract is to refuse branches with open
# PRs, so a gh failure must NOT fall through with prs = [].
if not prs_known:
    print("refuse:pr-lookup-unknown")
elif open_prs:
    print(f"refuse:open-pr:{','.join('#' + str(p['number']) for p in open_prs)}")
elif is_ancestor:
    print("safe:orphan-ref")
elif merged_prs:
    print(f"safe:post-merge-stale:{','.join('#' + str(p['number']) for p in merged_prs)}")
else:
    print("refuse:diverged-unknown")
PYVALIDATE

SAFETY="$(python3 "$TMP_VALIDATOR" "$BRANCH" 2>/dev/null || echo error)"

if [[ "$SAFETY" == "error" ]]; then
  echo "error: safety re-validation failed (python3 / git / gh issue)" >&2
  exit 2
fi
if [[ "$SAFETY" == "no-such-branch" ]]; then
  echo "noop: branch $BRANCH does not exist locally"
elif [[ "$SAFETY" == refuse:* ]]; then
  echo "refused: $SAFETY" >&2
  echo "this branch is not safe to delete autonomously; operator must reconcile" >&2
  exit 1
elif [[ "$SAFETY" == safe:* ]]; then
  echo "verdict: $SAFETY"
  git branch -D "$BRANCH"
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
