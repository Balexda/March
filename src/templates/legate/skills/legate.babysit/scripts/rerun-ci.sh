#!/usr/bin/env bash
# legate skill: re-trigger a failed CI run on a PR.
#
# Wraps `gh run rerun --failed` so the dispatch stays inside the legate
# skill's `allowed-tools` and auto-mode doesn't pause.
#
# Usage:
#   rerun-ci.sh <repo-path> <run-id> [slice-id]
#
# `<run-id>` is the GitHub Actions run id, e.g. extracted from
# babysit-pr's `failed_checks[].url` field
# (https://github.com/<owner>/<repo>/actions/runs/<RUN-ID>/job/<job-id>).
#
# Stdout: gh's confirmation line.
# Exit:
#   0 success
#   1 rerun requires operator action or the run could not be rerun
#   2 invalid input
#
# IMPORTANT: rerun-ci re-runs *the same workflow against the same merge
# commit*. GitHub computes the PR's merge commit from (PR head, main HEAD)
# at the time the original run started; rerun reuses that merge commit
# verbatim. So:
#
#   - Transient infra hiccup, flaky network test, runner OOM → rerun-ci
#     is the right tool. The same code+main may behave differently on a
#     second attempt.
#   - Main was red when this PR ran, parent fix-PR has since merged, the
#     test still references the *old* main → rerun-ci is the WRONG tool.
#     It will reuse the stale merge commit and fail identically. Use
#     request-rebase.sh instead — that makes the worker rebase the
#     branch onto current main and force-push, which causes GitHub to
#     recompute the merge commit and fire fresh CI.
#   - Real test/lint failure rooted in this PR's diff → `/smithy.fix`
#     via `send-to-worker.sh`, not rerun-ci.
#   - Run is currently in_progress → wait for it to complete first.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: rerun-ci.sh <repo-path> <run-id> [slice-id]" >&2
  exit 2
fi

REPO="$1"
export MARCH_TESSERA_SLICE_ID="${3:-${MARCH_TESSERA_SLICE_ID:-}}"
RUN_ID="$2"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if ! [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "run-id must be a positive integer: $RUN_ID" >&2
  exit 2
fi

FORGE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../tessera-forge.mjs"
cd "$REPO"

echo "rerun: run-id=$RUN_ID" >&2

# `--failed` only re-runs the failed jobs (not the whole workflow), which
# is what we want when CI is partially failed and partially passing.
if ! node "$FORGE" gh write run rerun "$RUN_ID" --failed; then
  echo "CI rerun did not complete. Ask the operator to rerun failed jobs for run $RUN_ID in GitHub Actions." >&2
  exit 1
fi
