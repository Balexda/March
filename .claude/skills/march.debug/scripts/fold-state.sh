#!/usr/bin/env bash
# fold-state.sh — summarize Herald's current fold projection (GET /state).
#
# Herald's /state is the fold of the event log: the system's current view of
# every slice. This is the first thing to read when diagnosing stuck state.
#
# Usage:
#   fold-state.sh [--profile <p>] [--archived] [--json]
#   fold-state.sh --slice <sliceId> [--profile <p>]
#
# Flags:
#   --slice <id>   Full attribute dump for one slice (exit 5 if not found).
#   --archived     Include archived slices in the default listing.
#   --profile <p>  Append ?profile=<p> to /state (single-container deployments
#                  serve one profile and ignore it; harmless to pass).
#   --json         Print the raw /state JSON.
#   --help         This help.
#
# Examples:
#   fold-state.sh
#   fold-state.sh --archived
#   fold-state.sh --slice layered-testing-framework-m2-f2-mark
#   MARCH_HERALD_URL=http://localhost:8818 fold-state.sh --json
#
# Default output: fold seq/ts, the smithy queue summary, then one line per
# non-archived slice (sliceId, stage, branch, sessionId, pr #/state, escalation).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq

SLICE=""; ARCHIVED=0; JSON=0; PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slice) SLICE="${2:?--slice needs a sliceId}"; shift 2;;
    --archived) ARCHIVED=1; shift;;
    --json) JSON=1; shift;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2;;
    --help|-h) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit "$EX_USAGE";;
  esac
done

PATH_Q="/state"
[ -n "$PROFILE" ] && PATH_Q="/state?profile=$PROFILE"
STATE=$(herald_get "$PATH_Q") || exit $?

if [ "$JSON" = 1 ]; then echo "$STATE" | jq .; exit 0; fi

if [ -n "$SLICE" ]; then
  if ! echo "$STATE" | jq -e --arg s "$SLICE" '.slices[$s]' >/dev/null 2>&1; then
    echo "march.debug: slice '$SLICE' not found in fold." >&2
    exit "$EX_NOTFOUND"
  fi
  echo "$STATE" | jq --arg s "$SLICE" '.slices[$s]'
  exit 0
fi

echo "$STATE" | jq -r '
  "fold seq=\(.seq)  ts=\(.ts)",
  "smithy: dispatchable=\(.smithy.dispatchable) blocked=\(.smithy.blocked) total=\(.smithy.total)",
  "workers: " + ([.workers | to_entries[] | "\(.key)=\(.value)"] | join(" "))
'
echo "---"
echo "$STATE" | jq -r --argjson all "$ARCHIVED" '
  .slices | to_entries
  | map(select($all == 1 or (.value.archived // false) == false))
  | sort_by(.key)[]
  | .value as $s
  | [ .key,
      "stage=\($s.stage // "-")",
      "branch=\($s.branch // "-")",
      "session=\(($s.sessionId // "") | if . == "" then "MISSING" else . end)",
      (if ($s.pr.number // null) != null then "pr=#\($s.pr.number)(\($s.pr.state))" +
         (if ($s.pr.needs_response_count // 0) > 0 then " threads=\($s.pr.needs_response_count)" else "" end)
        else "pr=-" end),
      (if $s.escalatedReason then "ESCALATED:\($s.escalatedReason)" else empty end),
      (if ($s.archived // false) then "[archived]" else empty end),
      (if ($s.recovered // false) then "[recovered]" else empty end)
    ] | join("  ")
'
