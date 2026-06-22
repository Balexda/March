#!/usr/bin/env bash
# events-tail.sh — tail Herald's append-only event log (GET /events).
#
# Herald is event-sourced: the fold (/state) is the projection, the event log is
# the truth. Reading the recent tail shows you what each service actually
# observed/transitioned, in order. `source` distinguishes herald observations
# from legate transitions.
#
# Herald folds per profile; the legate drives N profiles. This tail therefore
# scopes to ONE profile: `--profile` is required and is passed to Herald as
# `?profile=`, so /state (the seq probe) and /events return only that profile's
# events — scoped server-side, never an interleaved cross-profile stream.
#
# Usage:
#   events-tail.sh --profile <name> [--after <seq>] [--src herald|legate]
#                  [--type <t>] [--slice <id>] [--limit <n>] [--show <n>] [--json]
#
# Flags:
#   --profile <p>  Required. Scope to this profile (Herald filters server-side).
#   --after <seq>  Page forward from this seq (ascending). When omitted, the
#                  script probes /state.seq (for this profile) and shows the most
#                  recent window.
#   --src <s>      Filter by source: herald (observations) | legate (transitions).
#   --type <t>     Filter by exact event type (e.g. slice.escalated).
#   --slice <id>   Filter by sliceId.
#   --limit <n>    Max events to FETCH from Herald (default 200).
#   --show <n>     Max events to DISPLAY after filtering (default 50).
#   --json         Print the raw filtered events array.
#   --help         This help.
#
# Examples:
#   events-tail.sh --profile march
#   events-tail.sh --profile march --src legate --type slice.escalated
#   events-tail.sh --profile smithy --slice 01-spawn-f5-s3-cut --limit 500
#   events-tail.sh --profile march --after 700 --json
#
# Columns: seq  src  type  slice  extras

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq

PROFILE=""; AFTER=""; SRC=""; TYPE=""; SLICE=""; LIMIT=200; SHOW=50; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2;;
    --after) AFTER="${2:?}"; shift 2;;
    --src) SRC="${2:?}"; shift 2;;
    --type) TYPE="${2:?}"; shift 2;;
    --slice) SLICE="${2:?}"; shift 2;;
    --limit) LIMIT="${2:?}"; shift 2;;
    --show) SHOW="${2:?}"; shift 2;;
    --json) JSON=1; shift;;
    --help|-h) sed -n '2,37p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit "$EX_USAGE";;
  esac
done
[ -n "$PROFILE" ] || { echo "march.debug: --profile is required." >&2; exit "$EX_USAGE"; }

if [ -z "$AFTER" ]; then
  TIP=$(herald_get "/state?profile=${PROFILE}" | jq -r '.seq // 0') || exit $?
  AFTER=$(( TIP > LIMIT ? TIP - LIMIT : 0 ))
fi

PAGE=$(herald_get "/events?after=${AFTER}&limit=${LIMIT}&profile=${PROFILE}") || exit $?

FILTERED=$(echo "$PAGE" | jq \
  --arg src "$SRC" --arg type "$TYPE" --arg slice "$SLICE" '
  [ .events[]
    | select($src   == "" or .source == $src)
    | select($type  == "" or .type   == $type)
    | select($slice == "" or (.sliceId // "") == $slice) ]')

if [ "$JSON" = 1 ]; then echo "$FILTERED" | jq .; exit 0; fi

# `columnize` (from lib.sh) aligns the TSV when util-linux `column` is present
# and passes it through unchanged when it is not (the container image omits it).
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
  | @tsv' | columnize
