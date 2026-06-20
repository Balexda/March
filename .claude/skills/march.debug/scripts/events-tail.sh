#!/usr/bin/env bash
# events-tail.sh — tail Herald's append-only event log (GET /events).
#
# Herald is event-sourced: the fold (/state) is the projection, the event log is
# the truth. Reading the recent tail shows you what each service actually
# observed/transitioned, in order. `source` distinguishes herald observations
# from legate transitions.
#
# Usage:
#   events-tail.sh [--after <seq>] [--src herald|legate] [--type <t>]
#                  [--slice <id>] [--limit <n>] [--show <n>] [--json]
#
# Flags:
#   --after <seq>  Page forward from this seq (ascending). When omitted, the
#                  script probes /state.seq and shows the most recent window.
#   --src <s>      Filter by source: herald (observations) | legate (transitions).
#   --type <t>     Filter by exact event type (e.g. slice.escalated).
#   --slice <id>   Filter by sliceId.
#   --limit <n>    Max events to FETCH from Herald (default 200).
#   --show <n>     Max events to DISPLAY after filtering (default 50).
#   --json         Print the raw filtered events array.
#   --help         This help.
#
# Examples:
#   events-tail.sh
#   events-tail.sh --src legate --type slice.escalated
#   events-tail.sh --slice 01-spawn-f5-s3-cut --limit 500
#   events-tail.sh --after 700 --json
#
# Columns: seq  src  type  slice  extras

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq

AFTER=""; SRC=""; TYPE=""; SLICE=""; LIMIT=200; SHOW=50; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --after) AFTER="${2:?}"; shift 2;;
    --src) SRC="${2:?}"; shift 2;;
    --type) TYPE="${2:?}"; shift 2;;
    --slice) SLICE="${2:?}"; shift 2;;
    --limit) LIMIT="${2:?}"; shift 2;;
    --show) SHOW="${2:?}"; shift 2;;
    --json) JSON=1; shift;;
    --help|-h) sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit "$EX_USAGE";;
  esac
done

if [ -z "$AFTER" ]; then
  TIP=$(herald_get "/state" | jq -r '.seq // 0') || exit $?
  AFTER=$(( TIP > LIMIT ? TIP - LIMIT : 0 ))
fi

PAGE=$(herald_get "/events?after=${AFTER}&limit=${LIMIT}") || exit $?

FILTERED=$(echo "$PAGE" | jq \
  --arg src "$SRC" --arg type "$TYPE" --arg slice "$SLICE" '
  [ .events[]
    | select($src   == "" or .source == $src)
    | select($type  == "" or .type   == $type)
    | select($slice == "" or (.sliceId // "") == $slice) ]')

if [ "$JSON" = 1 ]; then echo "$FILTERED" | jq .; exit 0; fi

echo "$FILTERED" | jq -r --argjson show "$SHOW" '
  (. | (length - $show)) as $start
  | .[ (if $start < 0 then 0 else $start end) : ]
  | .[]
  | [ (.seq|tostring),
      (.source // "-"),
      .type,
      (.sliceId // "-"),
      ( (if .admin then "ADMIN " else "" end)
        + (.reason // .stage // .note // .operator // "") ) ]
  | @tsv' | { command -v column >/dev/null 2>&1 && column -t -s$'\t' || cat; }
