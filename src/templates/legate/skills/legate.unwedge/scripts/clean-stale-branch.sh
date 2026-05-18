#!/usr/bin/env bash
# legate.unwedge skill: delete a stale local branch and clear its escalated
# slice from state.json so the deterministic loop re-dispatches the artifact
# on the next tick. Safety re-validation happens here, NOT in the caller —
# this script must refuse to delete a branch with an open PR or with
# diverged work whose status isn't a merged PR.
#
# Usage:
#   clean-stale-branch.sh <repo-path> <branch-name> <state-json-path> <slice-id>
#
# Exit:
#   0 cleaned successfully
#   1 refused (operator/agent must reconcile manually — prints reason on stderr)
#   2 invalid input or environment
#
# Stdout: one line per action taken (branch deleted, slice removed, files removed).
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: clean-stale-branch.sh <repo-path> <branch-name> <state-json-path> <slice-id>" >&2
  exit 2
fi

REPO="$1"
BRANCH="$2"
STATE="$3"
SLICE_ID="$4"

if [[ ! -d "$REPO/.git" ]]; then
  echo "error: $REPO is not a git checkout" >&2
  exit 2
fi
if [[ ! -f "$STATE" ]]; then
  echo "error: state file $STATE not found" >&2
  exit 2
fi

cd "$REPO"

# We do not trust upstream callers to have validated safety. Extract two small
# python helpers to temp files so the heredoc-in-command-substitution and
# heredoc-as-stdin patterns don't collide on a single PY marker.
TMP_VALIDATOR="$(mktemp -t unwedge.validate.XXXXXX.py)"
TMP_MUTATOR="$(mktemp -t unwedge.mutate.XXXXXX.py)"
trap 'rm -f "$TMP_VALIDATOR" "$TMP_MUTATOR"' EXIT

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

cat > "$TMP_MUTATOR" <<'PYMUTATE'
import json, os, sys, tempfile

state_path, slice_id = sys.argv[1], sys.argv[2]
with open(state_path, "r") as f:
    state = json.load(f)
slices = state.get("slices") or {}
slice_data = slices.pop(slice_id, None)
if slice_data is None:
    print(f"noop: slice {slice_id} not in state.slices")
    sys.exit(0)
hatchery = slice_data.get("hatchery") or {}
removed = []
for key in ("hatchery_request_path", "hatchery_result_path", "hatchery_log_path"):
    p = hatchery.get(key)
    if isinstance(p, str) and p:
        try:
            os.unlink(p)
            removed.append(p)
        except FileNotFoundError:
            pass
        except OSError as e:
            print(f"warning: failed to remove {p}: {e}", file=sys.stderr)
fd, tmp = tempfile.mkstemp(prefix="state.", suffix=".json", dir=os.path.dirname(state_path) or ".")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, state_path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
print(f"cleared slice: {slice_id}")
for p in removed:
    print(f"removed hatchery artifact: {p}")
PYMUTATE

python3 "$TMP_MUTATOR" "$STATE" "$SLICE_ID"

echo "done. loop will re-dispatch $SLICE_ID on next tick."
