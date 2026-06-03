#!/usr/bin/env bash
# spawn-failure.sh — find the root cause of a failed dispatch.
#
# When a spawn dies, `docker logs march-legate` is sparse. The real "why" lives
# in two host files:
#   1. ~/.march/legate/<profile>/legate-requests.ndjson  — the escalation record
#      (reason=hatchery_dispatch_failed) whose `detail` names the spawnId + log.
#   2. ~/.march/logs/hatchery-spawns/<spawnId>/spawn-output.log — the codex CLI's
#      line-delimited JSON events, where the actual error message appears.
#
# This script walks #1 -> #2 and surfaces the codex error so you can pattern-
# match the failure class.
#
# Usage:
#   spawn-failure.sh --profile <p> [--all] [--lines <n>]
#
# Flags:
#   --profile <p>  Required.
#   --all          Walk every hatchery_dispatch_failed entry (newest first),
#                  not just the most recent. Use when N slices failed in the same
#                  minute and you want to confirm a shared root cause.
#   --lines <n>    Tail this many lines of each spawn-output.log (default 20).
#   --help         This help.
#
# Env overrides (default to ~/.march/...):
#   MARCH_LEGATE_HOME       legate per-profile log root  (default ~/.march/legate)
#   MARCH_HATCHERY_LOG_DIR  hatchery spawn-log root       (default ~/.march/logs)
#
# Failure-class cheat sheet (match the codex CLI message):
#   "refresh token was already used" / "log out and sign in again"
#                                  -> codex OAuth expired; operator re-auths codex.
#   "branch already exists"        -> orphan branch; Brood teardown needed (#155).
#   "git apply" / "patch does not apply"
#                                  -> bad worker patch (truncated/new-file diff).
#   exited 1 with empty log        -> image broken / codex CLI startup error.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need jq

PROFILE=""; ALL=0; LINES=20
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2;;
    --all) ALL=1; shift;;
    --lines) LINES="${2:?}"; shift 2;;
    --help|-h) sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown flag: $1" >&2; exit "$EX_USAGE";;
  esac
done
[ -n "$PROFILE" ] || { echo "march.debug: --profile is required." >&2; exit "$EX_USAGE"; }

LEGATE_HOME="${MARCH_LEGATE_HOME:-$HOME/.march/legate}"
HATCHERY_LOG_DIR="${MARCH_HATCHERY_LOG_DIR:-$HOME/.march/logs}"
REQ_FILE="${LEGATE_HOME}/${PROFILE}/legate-requests.ndjson"

[ -f "$REQ_FILE" ] || { echo "march.debug: no request log at $REQ_FILE" >&2; exit "$EX_NOTFOUND"; }

# Newest-first list of dispatch-failure entries, one compact JSON object per
# line. jq -c keeps embedded newlines in `detail` escaped, so each entry stays a
# single line (safe for mapfile); we re-parse the fields per entry below.
mapfile -t ROWS < <(jq -c 'select(.reason == "hatchery_dispatch_failed") | {ts, slice_id, detail}' "$REQ_FILE" | tac)

[ "${#ROWS[@]}" -gt 0 ] || { echo "march.debug: no hatchery_dispatch_failed entries in $REQ_FILE" >&2; exit "$EX_NOTFOUND"; }

report_one() {
  local row="$1"
  local ts slice detail
  ts=$(jq -r '.ts' <<<"$row")
  slice=$(jq -r '.slice_id' <<<"$row")
  detail=$(jq -r '.detail' <<<"$row")

  echo "=== $slice  ($ts) ==="
  # Extract spawnId ("Spawn <id> exited") and the Logs: <path> hint.
  local spawn_id logs_path
  spawn_id=$(printf '%s' "$detail" | grep -oE 'Spawn [0-9A-Za-z._-]+' | head -1 | awk '{print $2}')
  logs_path=$(printf '%s' "$detail" | grep -oE 'Logs: [^[:space:]]+' | head -1 | sed 's/^Logs: //')

  # Prefer the rebuilt path when MARCH_HATCHERY_LOG_DIR is overridden (tests),
  # else the absolute Logs: path from the detail, else the default rebuild.
  local log_file=""
  if [ -n "${MARCH_HATCHERY_LOG_DIR:-}" ] && [ -n "$spawn_id" ]; then
    log_file="${HATCHERY_LOG_DIR}/hatchery-spawns/${spawn_id}/spawn-output.log"
  elif [ -n "$logs_path" ]; then
    log_file="$logs_path"
  elif [ -n "$spawn_id" ]; then
    log_file="${HATCHERY_LOG_DIR}/hatchery-spawns/${spawn_id}/spawn-output.log"
  fi

  echo "spawnId: ${spawn_id:-?}   log: ${log_file:-?}"
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    echo "--- last ${LINES} line(s) of spawn-output.log ---"
    tail -n "$LINES" "$log_file" | sed 's/^/  /'
    echo "--- error / turn.failed lines ---"
    if ! grep -E '"type":"(error|turn\.failed)"' "$log_file" | tail -n 5 | sed 's/^/  >> /'; then
      echo "  (no structured error/turn.failed lines — exited before emitting one;"
      echo "   image-broken or CLI-startup failure class)"
    fi
  else
    echo "  spawn-output.log not found. If the container exited instantly with no"
    echo "  log, suspect a broken image or codex CLI startup error."
  fi
  echo
}

if [ "$ALL" = 1 ]; then
  for row in "${ROWS[@]}"; do report_one "$row"; done
else
  report_one "${ROWS[0]}"
fi
