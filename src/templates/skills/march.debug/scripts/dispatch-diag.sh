#!/usr/bin/env bash
# dispatch-diag.sh — cross-check Herald's fold against the legate's view.
#
# THE core "is the system actually wedged?" tool. Herald's smithy.dispatchable
# (computed in senseObserved) and the legate's queue.dispatchable (computed in
# assess) should agree. When Herald > legate, that is the #268 metric-inflation
# signature: Herald over-counts because its observation-side senseSmithy runs
# against a synthetic empty working state and skips the in-flight/archived dedup.
# A persistent "dispatchable=5" on Herald with "dispatchable=0" on the legate is
# NOT a dispatch deadlock — it is the inflated metric. Don't chase a phantom.
#
# Usage:
#   dispatch-diag.sh --profile <p> [--json]
#
# Flags:
#   --profile <p>  Required.
#   --json         Emit the comparison as JSON.
#   --help         This help.
#
# Examples:
#   dispatch-diag.sh --profile march

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq

PROFILE=""; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2;;
    --json) JSON=1; shift;;
    --help|-h) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit "$EX_USAGE";;
  esac
done
[ -n "$PROFILE" ] || { echo "march.debug: --profile is required." >&2; exit "$EX_USAGE"; }

STATE=$(herald_get "/state") || exit $?
STATUS=$(legate_get "/status?profile=${PROFILE}") || exit $?

if [ "$(echo "$STATUS" | jq -r '.ok // false')" != "true" ]; then
  echo "march.debug: legate does not know profile '$PROFILE'." >&2
  exit "$EX_NOTFOUND"
fi

H_DISP=$(echo "$STATE"  | jq -r '.smithy.dispatchable // 0')
H_BLOCK=$(echo "$STATE" | jq -r '.smithy.blocked // 0')
H_TOTAL=$(echo "$STATE" | jq -r '.smithy.total // 0')
L_DISP=$(echo "$STATUS" | jq -r '.queue.dispatchable // 0')
L_BLOCK=$(echo "$STATUS"| jq -r '.queue.blocked // 0')
L_TOTAL=$(echo "$STATUS"| jq -r '.queue.total // 0')
AGE=$(echo "$STATUS"    | jq -r '.last_tick_age_seconds // "?"')

if [ "$JSON" = 1 ]; then
  jq -n --argjson hd "$H_DISP" --argjson hb "$H_BLOCK" --argjson ht "$H_TOTAL" \
        --argjson ld "$L_DISP" --argjson lb "$L_BLOCK" --argjson lt "$L_TOTAL" \
        --argjson diverged "$([ "$H_DISP" -gt "$L_DISP" ] && echo true || echo false)" '
    { herald: {dispatchable:$hd, blocked:$hb, total:$ht},
      legate: {dispatchable:$ld, blocked:$lb, total:$lt},
      diverged: $diverged }'
  exit 0
fi

printf '%-14s %10s %10s %10s\n' "" "dispatch" "blocked" "total"
printf '%-14s %10s %10s %10s\n' "herald /state" "$H_DISP" "$H_BLOCK" "$H_TOTAL"
printf '%-14s %10s %10s %10s\n' "legate /status" "$L_DISP" "$L_BLOCK" "$L_TOTAL"
echo "legate last tick: ${AGE}s ago"
echo "---"
if [ "$H_DISP" -gt "$L_DISP" ]; then
  echo "DIVERGED: Herald dispatchable ($H_DISP) > legate dispatchable ($L_DISP)."
  echo "  This is the #268 metric-inflation signature, NOT a dispatch deadlock."
  echo "  Herald's observation-side count skips the in-flight/archived dedup the"
  echo "  legate applies. Trust the legate's number. If legate dispatchable is 0,"
  echo "  there is genuinely nothing to dispatch this tick."
elif [ "$L_DISP" -gt 0 ]; then
  echo "Both agree work is dispatchable ($L_DISP). If no legate-source dispatch"
  echo "events appear across several ticks (events-tail.sh --src legate), the"
  echo "dispatch handler may not be firing — proceed to spawn-failure.sh."
else
  echo "Aligned at dispatchable=0. Nothing is ready to dispatch; not wedged."
fi
