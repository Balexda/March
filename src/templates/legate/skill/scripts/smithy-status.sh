#!/usr/bin/env bash
# legate skill: refresh smithy status as JSON.
#
# Usage:
#   smithy-status.sh <repo-path>
#
# Stdout: JSON from `smithy status --format json` (or empty object `{}` if smithy
# is unavailable; the conductor escalates in that case).
# Exit:
#   0 success
#   1 smithy not on PATH or smithy command failed
#   2 invalid input
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: smithy-status.sh <repo-path>" >&2
  exit 2
fi

REPO="$1"

if ! command -v smithy >/dev/null 2>&1; then
  echo "smithy not found on PATH" >&2
  exit 1
fi

if [[ ! -d "$REPO" ]]; then
  echo "repo path not a directory: $REPO" >&2
  exit 2
fi

cd "$REPO"
smithy status --format json
