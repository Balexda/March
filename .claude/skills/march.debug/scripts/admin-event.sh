#!/usr/bin/env bash
# admin-event.sh — BREAK-GLASS wrapper around `march herald admin event` (#265).
#
# Authors a corrective event directly into Herald's fold via POST /admin/events.
# This is for the narrow case: "a since-fixed bug left the fold in a state the
# running services cannot reach, and the data is now wrong." It is NOT a flow-
# control knob — if you reach for it regularly, the underlying bug is not fixed.
#
# Safety: this wrapper ALWAYS echoes the body it would send and runs as a DRY RUN
# unless --yes is passed. With --yes it forwards to the march CLI (which posts to
# Herald). The append is reducer-validated, gets a real seq, and writes a paired
# admin.event.appended audit row.
#
# Usage:
#   admin-event.sh --profile <p> --type <t> --note <why> [event-fields...] [--yes]
#
# Common event-fields (for --type slice.steward.attached):
#   --slice-id <id> --session-id <sid> --worktree-path <path> --branch <branch>
# Also forwarded: --operator <name>  (defaults to $USER in the CLI).
#
# Required env:
#   MARCH_HERALD_URL          Herald base URL (e.g. http://localhost:8818)
#   MARCH_HERALD_ADMIN_TOKEN  the separate admin bearer token. If unset, the
#                             /admin/events route 404s by design (#265) — set it
#                             only while intervening, then unset it again.
# Optional:
#   MARCH_CLI   path to the march executable (default: node <repo>/dist/cli.js)
#
# Example — the #230/#240 slice->session backfill (most common use):
#   MARCH_HERALD_ADMIN_TOKEN=*** admin-event.sh \
#     --profile march --type slice.steward.attached \
#     --slice-id 01-spawn-f5-s2-cut \
#     --session-id e3bde73d-1779515948 \
#     --worktree-path /home/jmbattista/Development/WorkTrees/March/feature-smithy-cut-01-spawn-f5-s2 \
#     --branch smithy/cut/01-spawn-f5-s2 \
#     --note "legacy slice pre-#213; unstick PR #240" --yes

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

YES=0; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    --yes) YES=1; shift;;
    *) ARGS+=("$1"); shift;;
  esac
done

if [ -z "${MARCH_HERALD_URL:-}" ]; then
  echo "march.debug: MARCH_HERALD_URL is not set — point it at Herald (e.g. http://localhost:8818)." >&2
  exit "$EX_USAGE"
fi
if [ -z "${MARCH_HERALD_ADMIN_TOKEN:-}" ]; then
  echo "march.debug: MARCH_HERALD_ADMIN_TOKEN is not set." >&2
  echo "  The /admin/events route 404s without it (by design, #265). Set the admin" >&2
  echo "  token only while intervening, then unset it again." >&2
  exit "$EX_USAGE"
fi

resolve_cli() {
  if [ -n "${MARCH_CLI:-}" ]; then echo "$MARCH_CLI"; return; fi
  echo "node /home/jmbattista/Development/March/dist/cli.js"
}
CLI="$(resolve_cli)"

{
  echo "============================================================"
  echo "  BREAK-GLASS: this writes to Herald's fold."
  echo "  Use ONLY when the bug that produced the missing data is fixed."
  echo "============================================================"
  echo "  herald   : $HERALD_URL"
  echo "  command  : $CLI herald admin event ${ARGS[*]}"
} >&2

if [ "$YES" != 1 ]; then
  echo >&2
  echo "DRY RUN — nothing sent. Re-run with --yes to append the event." >&2
  exit 0
fi

# Forward to the march CLI, which echoes the JSON body and POSTs to /admin/events.
# We pass --yes through so the CLI does not prompt again.
# shellcheck disable=SC2086
$CLI herald admin event "${ARGS[@]}" --yes
rc=$?
if [ "$rc" -eq 0 ]; then
  echo
  echo "Next legate tick folds this incrementally into working state via the"
  echo "warm-fold guarantee (#265) — no legate restart needed. Confirm with:"
  echo "  fold-state.sh --slice <sliceId>    # the corrected field should now be set"
fi
exit "$rc"
