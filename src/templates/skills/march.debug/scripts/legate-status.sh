#!/usr/bin/env bash
# legate-status.sh — read the legate's own view of a profile (GET /status).
#
# This is the legate's IN-MEMORY working state for one profile: tick health, the
# queue it actually computed, and per-action counters. It is the same fold as
# Herald's /state but a different in-memory shape — and the two can diverge
# (see dispatch-diag.sh and issue #268).
#
# Usage:
#   legate-status.sh --profile <p> [--json]
#
# Flags:
#   --profile <p>  Required. The profile to fetch.
#   --json         Raw /status JSON (default is pretty-printed).
#   --help         This help.
#
# Examples:
#   legate-status.sh --profile march
#   legate-status.sh --profile march --json
#
# Exits 5 if the profile is unknown to the legate.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq

PROFILE=""; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2;;
    --json) JSON=1; shift;;
    --help|-h) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit "$EX_USAGE";;
  esac
done
[ -n "$PROFILE" ] || { echo "march.debug: --profile is required." >&2; exit "$EX_USAGE"; }

BODY=$(legate_get "/status?profile=${PROFILE}") || exit $?

if [ "$(echo "$BODY" | jq -r '.ok // false')" != "true" ]; then
  echo "march.debug: legate does not know profile '$PROFILE'." >&2
  echo "$BODY" | jq -r '"  known profiles: " + ((.profiles // []) | join(", "))' >&2 || true
  exit "$EX_NOTFOUND"
fi

if [ "$JSON" = 1 ]; then echo "$BODY"; else echo "$BODY" | jq .; fi
