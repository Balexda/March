#!/usr/bin/env bash
# tests.sh — fixture-based unit tests for the march.debug scripts.
#
# No running March stack required: HTTP calls are served from
# fixtures/replay via the MARCH_DEBUG_REPLAY_DIR hook in lib.sh, and the
# file-reading scripts are pointed at fixtures/legate-home + fixtures/hatchery-logs.
#
# Run:  bash .claude/skills/march.debug/scripts/tests.sh
# Exits non-zero on the first failing assertion.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$DIR/fixtures"
PASS=0

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { PASS=$((PASS+1)); echo "ok - $*"; }

# Asserts: run command, check exit code and (optional) stdout substring.
expect() { # <desc> <expected-rc> <substr-or-empty> -- <cmd...>
  local desc="$1" want_rc="$2" substr="$3"; shift 3; [ "$1" = "--" ] && shift
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  [ "$rc" = "$want_rc" ] || fail "$desc: rc=$rc want $want_rc"
  if [ -n "$substr" ]; then
    grep -qF -- "$substr" <<<"$out" || fail "$desc: stdout missing '$substr'"
  fi
  ok "$desc"
}

REPLAY="$FIX/replay"

# --- --help on every script exits 0 ---
for s in fold-state events-tail legate-status dispatch-diag spawn-failure admin-event mass-recover; do
  expect "$s --help" 0 "Usage" -- bash "$DIR/$s.sh" --help
done

# --- fold-state ---
expect "fold-state default lists a non-archived slice" 0 "layered-testing-framework-m2-f2-mark" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh"
# the archived slice is hidden by default, shown with --archived
out=$(env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh" 2>/dev/null)
grep -q "01-spawn-f3-s3-cut" <<<"$out" && fail "fold-state default leaked an archived slice"
ok "fold-state default hides archived slices"
expect "fold-state --archived shows the archived slice" 0 "01-spawn-f3-s3-cut" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh" --archived
expect "fold-state shows escalation" 0 "ESCALATED:hatchery_dispatch_failed" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh"
expect "fold-state flags missing session" 0 "session=MISSING" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh"
expect "fold-state --slice dumps known slice" 0 "smithy/cut/01-spawn-f3-s3" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh" --slice 01-spawn-f3-s3-cut
expect "fold-state --slice unknown -> 5" 5 "" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/fold-state.sh" --slice nope

# --- events-tail (use --after to skip the /state.seq probe) ---
expect "events-tail filters by type" 0 "slice.escalated" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/events-tail.sh" --after 0 --type slice.escalated
expect "events-tail --src legate excludes herald heartbeat" 0 "slice.escalated" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/events-tail.sh" --after 0 --src legate
# heartbeat is herald-source: must NOT appear under --src legate
out=$(env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/events-tail.sh" --after 0 --src legate 2>/dev/null)
grep -q "heartbeat" <<<"$out" && fail "events-tail --src legate leaked a herald event"
ok "events-tail --src legate excludes herald observations"

# --- legate-status ---
expect "legate-status ok" 0 "\"profile\": \"march\"" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/legate-status.sh" --profile march
expect "legate-status unknown profile -> 5" 5 "" -- \
  env MARCH_DEBUG_REPLAY_DIR="$FIX/unknown-profile" bash "$DIR/legate-status.sh" --profile nope
expect "legate-status missing --profile -> 2" 2 "" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/legate-status.sh"

# --- dispatch-diag: the #268 divergence (herald 5 > legate 0) ---
expect "dispatch-diag detects divergence" 0 "DIVERGED" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/dispatch-diag.sh" --profile march
expect "dispatch-diag cites #268" 0 "#268" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/dispatch-diag.sh" --profile march

# --- spawn-failure: reads ndjson -> spawn-output.log, finds auth-refresh ---
expect "spawn-failure surfaces codex auth error" 0 "refresh token was already used" -- \
  env MARCH_LEGATE_HOME="$FIX/legate-home" MARCH_HATCHERY_LOG_DIR="$FIX/hatchery-logs" \
  bash "$DIR/spawn-failure.sh" --profile march
# default reports the most-recent failure (last ndjson line -> 8da6e7)
expect "spawn-failure reports the most-recent spawnId" 0 "20260603-8da6e7" -- \
  env MARCH_LEGATE_HOME="$FIX/legate-home" MARCH_HATCHERY_LOG_DIR="$FIX/hatchery-logs" \
  bash "$DIR/spawn-failure.sh" --profile march
# --all should walk all three failed slices
out=$(env MARCH_LEGATE_HOME="$FIX/legate-home" MARCH_HATCHERY_LOG_DIR="$FIX/hatchery-logs" \
  bash "$DIR/spawn-failure.sh" --profile march --all 2>/dev/null)
n=$(grep -c "spawn-output.log" <<<"$out")
[ "$n" -ge 3 ] || fail "spawn-failure --all: expected >=3 logs, got $n"
ok "spawn-failure --all walks every failed slice"
expect "spawn-failure unknown profile -> 5" 5 "" -- \
  env MARCH_LEGATE_HOME="$FIX/legate-home" bash "$DIR/spawn-failure.sh" --profile ghost

# --- admin-event: env gate + dry-run safety ---
expect "admin-event errors without MARCH_HERALD_URL" 2 "" -- \
  env -u MARCH_HERALD_URL MARCH_HERALD_ADMIN_TOKEN=x bash "$DIR/admin-event.sh" --type x
expect "admin-event errors without admin token" 2 "" -- \
  env -u MARCH_HERALD_ADMIN_TOKEN MARCH_HERALD_URL=http://localhost:8818 bash "$DIR/admin-event.sh" --type x
# dry-run (no --yes): exits 0, sends nothing, prints the banner to stderr
out=$(env MARCH_HERALD_URL=http://localhost:8818 MARCH_HERALD_ADMIN_TOKEN=tok \
  bash "$DIR/admin-event.sh" --profile march --type slice.steward.attached --note test 2>&1); rc=$?
[ "$rc" = 0 ] || fail "admin-event dry-run rc=$rc"
grep -q "BREAK-GLASS" <<<"$out" || fail "admin-event dry-run missing banner"
grep -q "DRY RUN" <<<"$out" || fail "admin-event dry-run missing DRY RUN notice"
ok "admin-event dry-run is safe and shows the break-glass banner"

# --- mass-recover: dry-run enumerates escalated slices, acts only with --yes ---
# Dry run (no --yes): lists the fixture's escalated slice, calls neither docker
# nor the CLI, exits 0.
expect "mass-recover dry-run lists the escalated slice" 0 "01-spawn-f5-s3-cut" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/mass-recover.sh" --profile march
expect "mass-recover dry-run says DRY RUN" 0 "DRY RUN" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/mass-recover.sh" --profile march
# --reason filter excludes non-matching escalations (nothing to recover).
expect "mass-recover --reason filters out non-matches" 0 "no escalated slices match" -- \
  env MARCH_DEBUG_REPLAY_DIR="$REPLAY" bash "$DIR/mass-recover.sh" --profile march --reason no-such-reason

# --- service unreachable (no replay dir; closed port) ---
expect "fold-state unreachable -> 4" 4 "" -- \
  env -u MARCH_DEBUG_REPLAY_DIR MARCH_HERALD_URL=http://127.0.0.1:1 bash "$DIR/fold-state.sh"

echo
echo "All $PASS checks passed."
