#!/usr/bin/env bash
# legate skill: re-trigger a failed CI run on a PR.
#
# When `babysit-pr.sh` reports `checks == "FAIL"` but the failure root-cause
# is upstream (a previous main red, a transient Actions infra hiccup, an
# environment problem since fixed), the right action is *rerun the CI*,
# not push another `/smithy.fix` amendment. Wraps `gh run rerun --failed`
# so the dispatch stays inside the legate skill's `allowed-tools` and
# auto-mode doesn't pause.
#
# Usage:
#   rerun-ci.sh <repo-path> <run-id>
#
# `<run-id>` is the GitHub Actions run id, e.g. extracted from
# babysit-pr's `failed_checks[].url` field
# (https://github.com/<owner>/<repo>/actions/runs/<RUN-ID>/job/<job-id>).
#
# Stdout: gh's confirmation line.
# Exit:
#   0 success
#   1 gh call failed (e.g. run already passing, run id invalid)
#   2 invalid input
#
# When NOT to use:
#   - Real test/lint failure rooted in this PR's diff → `/smithy.fix` via
#     `send-to-worker.sh`, not rerun-ci.
#   - Run is currently in_progress → wait for it to complete before rerun.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: rerun-ci.sh <repo-path> <run-id>" >&2
  exit 2
fi

REPO="$1"
RUN_ID="$2"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if ! [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "run-id must be a positive integer: $RUN_ID" >&2
  exit 2
fi

cd "$REPO"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not found on PATH" >&2
  exit 1
fi

echo "rerun: run-id=$RUN_ID" >&2

# `--failed` only re-runs the failed jobs (not the whole workflow), which
# is what we want when CI is partially failed and partially passing.
gh run rerun "$RUN_ID" --failed
